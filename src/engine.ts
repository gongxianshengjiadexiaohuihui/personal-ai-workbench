import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import {
  mkdir,
  writeFile,
  readFile,
  realpath,
  copyFile,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ProjectService } from "./projects.js";
import { Store } from "./store.js";
import { GitService, git } from "./git.js";
import { Verifier } from "./verification.js";
import {
  executionSchema,
  planSchema,
  reviewSchema,
  now,
  labels,
  repositoriesOf,
  projectForGroup,
  projectIssues,
  type Project,
  type WorkEvent,
  type MessageOrigin,
  type Group,
  type Status,
} from "./domain.js";
import type { AgentAdapter, AgentInput } from "./adapters/agent.js";
import { taskMessages, taskQueryCommand } from "./task-query.js";
import { confirmTask, requestResend } from "./task-actions.js";

export interface NativeControllerPort {
  enabled(): boolean;
  canDispatch(taskId: string): boolean;
  plan(taskId: string): void;
  review(groupId: string, context: { summary: string; artifacts: string[]; passed: boolean; feedback: string }): void;
  changed(taskId: string): void;
  draft(taskId: string): void;
  receive(content: string, id: string, origin: MessageOrigin): string;
  notify(event: WorkEvent): boolean;
  direct(content: string, id: string, origin: MessageOrigin, result: string): void;
  pump(): Promise<void>;
}

export class Engine {
  native?: NativeControllerPort;
  events = new EventEmitter();
  active = new Map<string, AbortController>();
  planning = new Map<string, AbortController>();
  merging = new Set<string>();
  locks = new Map<string, Promise<void>>();
  stopping = false;
  scheduled = false;
  timer: NodeJS.Timeout | null = null;
  constructor(
    public store: Store,
    public agent: AgentAdapter,
    public gitService: GitService,
    public verifier: Verifier,
    public dataDir: string,
    public maxConcurrent = 2,
  ) {}
  directControls = new Set<string>();
  event(
    taskId: string | null,
    groupId: string | null,
    type: string,
    message: string,
    detail: unknown = null,
    notify = false,
  ) {
    const event = this.store.create("events", {
      taskId,
      groupId,
      type,
      message,
      detail,
    });
    const routed = notify && this.native?.notify(event);
    if (notify && !routed)
      this.store.create("outbox", {
        message: `${taskId ? `[${taskId}] ` : ""}${message}`,
        origin: taskId ? this.store.maybe("tasks", taskId)?.messageOrigin : undefined,
        status: "pending",
        attempts: 0,
        nextAt: now(),
        error: "",
      });
    this.events.emit("change", event);
    return event;
  }
  async start() {
    await new ProjectService(this.store, this.gitService).migrate();
    // 重启先核对交付的外部事实，绝不凭上次内存中的成功/失败猜测结果。
    for (const d of this.store
      .all("deliveries")
      .filter((x) => x.status === "merging" || x.status === "approved")) {
      const g = this.store.get("groups", d.groupId),
        p = projectForGroup(this.store.get("projects", g.projectId), g);
      try {
        const sha = await this.gitService.reconcile(p, d);
        if (sha) {
          this.completeDelivery(d.id, sha);
          continue;
        }
      } catch {}
      this.store.patch("deliveries", d.id, {
        status: "pending",
        approvedAt: null,
      });
      this.event(
        d.requestId,
        g.id,
        "recovery",
        "上次交付结果尚未确认，请核对本地分支或 PR 后重新确认。",
        null,
        true,
      );
    }
    for (const r of this.store
      .all("runs")
      .filter((x) => x.status === "running"))
      this.store.patch("runs", r.id, {
        status: "interrupted",
        error: "服务重启，等待核对并恢复会话",
      });
    for (const g of this.store
      .all("groups")
      .filter((x) => x.status === "running" || x.status === "verifying")) {
      if (g.status === "verifying" && this.store.get("tasks", g.requestId).controllerMode === "native" && this.store.setting(`native-review:${g.id}`, null)) continue;
      this.setGroup(g.id, "blocked");
      this.event(
        g.requestId,
        g.id,
        "recovery",
        "服务重启：执行已标记中断。点击恢复将核对 Codex 会话并保留当前 worktree。",
        null,
        true,
      );
    }
    for (const g of this.store
      .all("groups")
      .filter((g) => g.status === "blocked")) {
      const lastRun = this.store
        .all("runs")
        .filter((r) => r.groupId === g.id)
        .at(-1);
      if (lastRun?.status === "interrupted")
        this.store.setSetting(`recovery-required:${g.id}`, true);
    }
    this.timer = setInterval(() => {
      this.progressNotifications();
      this.wake();
    }, 30000);
    this.wake();
  }
  request(
    projectId: string,
    title: string,
    goal: string,
    source: "web" | "dingtalk" | "weixin" = "web",
    messageId?: string,
    messageOrigin?: MessageOrigin,
  ) {
    const project = this.store.get("projects", projectId);
    const issues = projectIssues(project);
    if (issues.length) throw new Error(`项目待配置：${issues.join("；")}`);
    const id = messageId
      ? `T-${createHash("sha256").update(messageId).digest("hex").slice(0, 12)}`
      : undefined;
    if (id && this.store.maybe("tasks", id)) return this.store.get("tasks", id);
    const task = this.store.create(
      "tasks",
      {
        projectId,
        controllerMode: this.native?.enabled() ? "native" : "legacy",
        revision: 1,
        parentId: null,
        groupId: null,
        title,
        goal,
        criteria: [],
        status: "clarifying",
        question: "",
        summary: "需求已收到，等待主控整理",
        controllerSession: null,
        source,
        messageOrigin,
        interventions: 0,
      },
      id,
    );
    this.event(
      task.id,
      null,
      "request",
      task.controllerMode === "native" ? "已收到需求，等待 App 主控；App 离线时保留排队。" : "已收到需求，主控正在整理目标和完成条件。",
      null,
      true,
    );
    this.wake();
    return task;
  }
  wake() {
    if (this.scheduled || this.stopping) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      void this.tick().catch((e) => this.event(null, null, "error", String(e)));
    });
  }
  async tick() {
    if (this.stopping) return;
    // 执行期间收到的补充先持久化；所有相关回合结束后再应用，避免悄悄交付旧需求。
    for (const task of this.store.all("tasks").filter((t) => !t.parentId)) {
      const key = `pending-input:${task.id}`;
      const pending = this.store.setting<string[]>(key, []);
      if (!pending.length || this.planning.has(task.id)) continue;
      if (
        this.store
          .all("groups")
          .some(
            (g) =>
              g.requestId === task.id &&
              (this.active.has(g.id) ||
                this.merging.has(g.id) ||
                this.store.setting(`recovery-required:${g.id}`, false)),
          )
      )
        continue;
      this.store.setSetting(key, []);
      if (["delivered", "cancelled"].includes(task.status)) continue;
      try {
        await this.supplement(task.id, pending.join("\n\n"));
      } catch (e) {
        this.store.setSetting(key, pending);
        this.failTask(task.id, e);
      }
    }
    for (const t of this.store.all("tasks").filter(t => !t.parentId && t.controllerMode === "native" && t.status === "clarifying" && !t.question)) this.native?.plan(t.id);
    if (this.planning.size === 0) {
      const t = this.store
        .all("tasks")
        .find((t) => !t.parentId && t.controllerMode !== "native" && t.status === "clarifying" && !t.question);
      if (t) {
        const c = new AbortController();
        this.planning.set(t.id, c);
        void this.plan(t.id, c.signal)
          .catch((e) => this.failTask(t.id, e))
          .finally(() => {
            this.planning.delete(t.id);
            this.wake();
          });
      }
    }
    for (const group of this.store.all("groups")) {
      if (this.active.size >= this.maxConcurrent) break;
      if (
        group.status !== "queued" ||
        (this.store.get("tasks", group.requestId).controllerMode === "native" && !this.native?.canDispatch(group.requestId)) ||
        this.active.has(group.id) ||
        this.store.setting(`recovery-required:${group.id}`, false) ||
        !group.dependsOn.every(
          (id) => this.store.maybe("groups", id)?.status === "delivered",
        )
      )
        continue;
      const identity = group.repositoryId || group.projectId;
      if (
        [...this.active.keys()].some((id) => {
          const running = this.store.get("groups", id);
          return (running.repositoryId || running.projectId) === identity;
        })
      )
        continue;
      if (!this.store.claim(group.id)) continue;
      const c = new AbortController();
      this.active.set(group.id, c);
      this.setGroup(group.id, "running");
      void this.withRuntime(`repository:${identity}`, async () => {
        if (!c.signal.aborted) await this.execute(group.id, c.signal);
      })
        .catch((e) => this.failGroup(group.id, e))
        .finally(() => {
          this.active.delete(group.id);
          this.wake();
        });
    }
  }
  async ai(
    taskId: string,
    groupId: string | null,
    input: Omit<AgentInput, "onSession" | "onTurn" | "onEvent">,
    skills: Record<string, string> = {},
  ) {
    const run = this.store.create("runs", {
      taskId,
      groupId,
      role: input.role,
      sessionId: input.sessionId ?? null,
      turnId: null,
      status: "running",
      summary: "",
      error: "",
      usage: null,
      skillVersions: skills,
    });
    let progress = "";
    try {
      const result = await this.agent.start({
        ...input,
        onSession: (id) => {
          this.store.patch("runs", run.id, { sessionId: id });
          if (groupId && input.role === "executor")
            this.store.patch("groups", groupId, { sessionId: id });
          if (input.role === "controller")
            this.store.patch("tasks", taskId, { controllerSession: id });
        },
        onTurn: (id) => this.store.patch("runs", run.id, { turnId: id }),
        onEvent: (e) => {
          if (e.type === "output") {
            progress = (progress + e.message).slice(-1200);
            if (groupId) this.store.patch("groups", groupId, { progress });
          } else this.event(taskId, groupId, e.type, e.message, e.detail);
          this.events.emit("progress", {
            taskId,
            groupId,
            type: e.type,
            message: e.message,
          });
        },
      });
      this.store.patch("runs", run.id, {
        status: "completed",
        summary: result.output,
        usage: result.usage,
      });
      return JSON.parse(result.output);
    } catch (e) {
      this.store.patch("runs", run.id, {
        status: input.signal?.aborted ? "interrupted" : "failed",
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  }
  async plan(taskId: string, signal: AbortSignal) {
    const t = this.store.get("tasks", taskId),
      p = this.store.get("projects", t.projectId);
    const members = repositoriesOf(p);
    const decision = planSchema.parse(
      await this.ai(taskId, null, {
        cwd: p.repoPath,
        role: "controller",
        sessionId: t.controllerSession,
        signal,
        schema: z.toJSONSchema(
          planSchema.extend({
            groups: z
              .array(
                planSchema.shape.groups.element.extend({
                  repositoryId: z.enum(
                    members.map((r) => r.repositoryId) as [string, ...string[]],
                  ),
                }),
              )
              .min(0)
              .max(8),
          }),
        ),
        prompt: `你是主控。只读分析本项目仓库，为需求提出结构化工作计划，不修改任何文件。项目仓库清单：${JSON.stringify(members)}。每个执行组必须输出 repositoryId，只能引用清单内仓库，一组只修改一个仓库。跨仓库验证安排在依赖链下游，依赖只有确认合并后才能使用。\n项目约定：${p.instructions}\n需求：${t.goal}\n项目验证命令：${JSON.stringify(p.verifyCommands)}\n规则：关键需求不清晰时 action=clarify，question 给出一个明确问题，groups=[]。否则 action=plan，每个组包含可共同交付的一组任务和客观完成条件；紧密关联任务放同一组。只有独立交付才拆组，组间依赖必须使用其他组 key 且无环。依赖组只有用户确认合并后才启动后继组。不要虚构完成条件或把实现细节当作用户要求。完成条件描述功能结果；禁止执行器提交/合并等权限约束由系统保障，不得将“仓库没有新提交”当成验收条件，执行结束后服务会自动提交快照。只返回指定 JSON。`,
      }),
    );
    if (signal.aborted) return;
    this.applyPlan(taskId, decision);
  }
  applyPlan(taskId: string, decision: z.infer<typeof planSchema>) {
    const t = this.store.get("tasks", taskId), p = this.store.get("projects", t.projectId), members = repositoriesOf(p);
    if (t.status !== "clarifying" || this.store.all("groups").some(g => g.requestId === taskId)) throw new Error("任务已有计划或状态已变化");
    if (decision.action === "clarify") {
      if (!decision.question.trim())
        throw new Error("主控没有提供明确的待回答问题");
      this.store.patch("tasks", taskId, {
        question: decision.question,
        summary: decision.summary,
      });
      this.event(taskId, null, "question", decision.question, null, true);
      return;
    }
    this.validatePlan(decision);
    for (const spec of decision.groups) {
      if (!spec.repositoryId && members.length === 1)
        spec.repositoryId = members[0].repositoryId;
      if (!members.some((r) => r.repositoryId === spec.repositoryId))
        throw new Error("主控引用了项目外仓库或缺少仓库绑定");
    }
    this.store.transaction(() => {
      const mapping = new Map<string, string>();
      for (const spec of decision.groups) {
        const repository = members.find(
          (r) => r.repositoryId === spec.repositoryId,
        )!;
        const g = this.store.create("groups", {
          projectId: p.id,
          repositoryId: repository.repositoryId,
          repository,
          requestId: taskId,
          title: spec.title,
          goal: spec.goal,
          criteria: spec.criteria,
          taskIds: [],
          dependsOn: [],
          runtimeKey: repository.runtimeKey || repository.repositoryId,
          status: "queued",
          branch: "",
          worktree: "",
          baseSha: "",
          headSha: "",
          sessionId: null,
          reworks: 0,
          feedback: "",
          lastSummaryAt: now(),
          lastSummary: "",
          progress: "",
        });
        mapping.set(spec.key, g.id);
        const tasks = spec.tasks.map((s) =>
          this.store.create("tasks", {
            projectId: p.id,
            parentId: taskId,
            groupId: g.id,
            title: s.title,
            goal: s.goal,
            criteria: s.criteria,
            status: "queued",
            question: "",
            summary: "",
            controllerSession: null,
            source: t.source,
            interventions: 0,
          }),
        );
        this.store.patch("groups", g.id, { taskIds: tasks.map((t) => t.id) });
      }
      for (const spec of decision.groups)
        this.store.patch("groups", mapping.get(spec.key)!, {
          dependsOn: spec.dependsOn.map((k) => mapping.get(k)!),
        });
      this.store.patch("tasks", taskId, {
        status: "queued",
        summary: decision.summary,
        criteria: decision.groups.flatMap((g) => g.criteria),
      });
    });
    this.event(
      taskId,
      null,
      "plan",
      `${decision.summary}\n已发布 ${decision.groups.length} 个执行组。`,
      decision,
      true,
    );
  }
  validatePlan(d: z.infer<typeof planSchema>) {
    if (!d.groups.length) throw new Error("主控没有创建执行组");
    const keys = new Set(d.groups.map((g) => g.key));
    if (keys.size !== d.groups.length) throw new Error("执行组 key 重复");
    const done = new Set<string>(),
      visiting = new Set<string>();
    const visit = (key: string) => {
      if (done.has(key)) return;
      if (visiting.has(key)) throw new Error("任务依赖存在循环");
      const g = d.groups.find((g) => g.key === key);
      if (!g) throw new Error("引用了不存在的任务依赖");
      visiting.add(key);
      for (const k of g.dependsOn) visit(k);
      visiting.delete(key);
      done.add(key);
    };
    for (const key of keys) visit(key);
  }
  async withRuntime<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((r) => {
      release = r;
    });
    this.locks.set(key, current);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(key) === current) this.locks.delete(key);
    }
  }
  async execute(groupId: string, signal: AbortSignal) {
    let g = this.store.get("groups", groupId);
    const p = projectForGroup(this.store.get("projects", g.projectId), g);
    this.event(g.requestId, g.id, "claimed", `已认领：${g.title}`, null, true);
    const prepared = await this.gitService.prepare(p, g);
    g = this.store.patch("groups", g.id, prepared);
    if (signal.aborted) return;
    const skills = this.store
      .all("skills")
      .filter((s) => s.projectId === p.id && s.status === "active");
    const output = executionSchema.parse(
      await this.ai(
        g.requestId,
        g.id,
        {
          cwd: g.worktree,
          role: "executor",
          sessionId: g.sessionId,
          signal,
          schema: z.toJSONSchema(executionSchema),
          prompt: `完成工作包。当前执行仓库：${g.repository?.name || p.name}；本次唯一工作目录：${g.worktree}。完成条件中的本仓库文件均指该 worktree，验证命令也在该目录执行。原始仓库 ${p.repoPath} 在用户批准交付前保持不变，这是正常流程，不需要写回原仓库。只修改当前 worktree。其他项目成员仅供只读参考：${JSON.stringify(repositoriesOf(p).map((r) => ({ name: r.name, repoPath: r.repoPath, baseBranch: r.baseBranch })))}。不要提交、推送、合并或修改外部项目；这些由服务处理。\n目标：${g.goal}\n完成条件：${JSON.stringify(g.criteria)}\n任务：${JSON.stringify(g.taskIds.map((id) => this.store.get("tasks", id)))}\n项目约定：${p.instructions}\n验证命令：${JSON.stringify(p.verifyCommands)}\n批准启用的 Skill：${skills.map((s) => `${s.name}@${s.version}\n${s.content}`).join("\n")}\n返工或补充要求：${g.feedback || "无"}\n如果恢复已有会话，先检查当前实际文件和已完成操作，避免重复副作用。UI 任务必须提供真实浏览器操作和截图，无法完成则 blocked=true 并明确原因。artifact 路径必须位于当前 worktree。返回指定 JSON，不要把计划写成已完成。`,
        },
        Object.fromEntries(skills.map((s) => [s.id, s.version])),
      ),
    );
    if (signal.aborted) return;
    if (output.blocked) {
      this.setGroup(g.id, "blocked");
      this.event(
        g.requestId,
        g.id,
        "question",
        output.question || output.summary,
        null,
        true,
      );
      return;
    }
    const artifacts = await this.collectArtifacts(g, output.artifacts);
    const headSha = await this.gitService.snapshot(g);
    g = this.store.patch("groups", g.id, { headSha });
    this.event(g.requestId, g.id, "snapshot", `工作系统已保存执行结果快照：${headSha}`, {
      repositoryId: g.repositoryId,
      headSha,
    });
    this.setGroup(g.id, "verifying");
    const verified = await this.withRuntime(`environment:${g.runtimeKey}`, () =>
      this.verifier.run(p, g, signal, (e) => {
        this.store.create("evidence", e);
        this.event(
          g.requestId,
          g.id,
          "evidence",
          `${e.exitCode === 0 ? "通过" : "失败"}：${e.command}`,
        );
      }),
    );
    if (signal.aborted) return;
    if (this.store.get("tasks", g.requestId).controllerMode === "native") {
      this.native?.review(g.id, { summary: output.summary, artifacts, passed: verified.passed, feedback: verified.feedback });
      return;
    }
    if (!verified.passed) {
      this.rework(g.id, verified.feedback);
      return;
    }
    const evidence = this.store
      .all("evidence")
      .filter((e) => e.groupId === g.id && e.headSha === headSha);
    const review = reviewSchema.parse(
      await this.ai(g.requestId, g.id, {
        cwd: g.worktree,
        role: "reviewer",
        signal,
        schema: z.toJSONSchema(reviewSchema),
        prompt: `你是主控的验收步骤，只有只读权限。验收对象是仓库 ${g.repository?.name || p.name} 的执行 worktree ${g.worktree}，所有本仓库功能条件与验证均以该目录为准。源目录 ${p.repoPath} 要等验收通过且用户批准后才合并，所以此时保留旧内容是预期行为，不能因此返工或要求提前写回。跨仓库依赖仅对已交付的其他仓库读取验证。当前提交 ${headSha} 是工作系统在执行会话结束后调用 GitService.snapshot 保存的快照，有系统事件记录；这不代表执行器自行提交，不因存在该提交判定执行器违规。根据实际代码与客观证据核对完成条件，检查真实缺陷，不扩展需求或提出假设性防御。\n目标：${g.goal}\n完成条件：${JSON.stringify(g.criteria)}\n执行者报告（仅为待核实声明）：${output.summary}\n提交：${headSha}\n差异：${await this.gitService.diff(g)}\n独立验证结果：${JSON.stringify(evidence.map((e) => ({ command: e.command, exitCode: e.exitCode, summary: e.summary })))}\n已收集产物：${JSON.stringify(artifacts)}\npass 仅用于有证据支持的完成项；实际错误返回 rework 和具体反馈；缺少真实 UI 验证或必须人工判断则 human。返回 JSON。`,
      }),
    );
    if (signal.aborted) return;
    await this.finishReview(g.id, review, output.summary, artifacts, signal);
  }
  async finishReview(groupId: string, review: z.infer<typeof reviewSchema>, summary: string, artifacts: string[], signal: AbortSignal) {
    const g = this.store.get("groups", groupId), p = projectForGroup(this.store.get("projects", g.projectId), g), headSha = g.headSha;
    if (g.status !== "verifying" || signal.aborted) throw new Error("验收状态已变化");
    if (review.decision === "rework") {
      this.rework(g.id, review.feedback);
      return;
    }
    if (review.decision === "human") {
      this.setGroup(g.id, "blocked");
      this.event(
        g.requestId,
        g.id,
        "question",
        `需要人工核实：${review.summary}\n${review.feedback}`,
        null,
        true,
      );
      return;
    }
    this.store.create("evidence", {
      groupId: g.id,
      headSha,
      command: "主控对照完成条件验收",
      exitCode: 0,
      logPath: "",
      summary: review.summary,
      artifacts,
    });
    const proposed = await this.gitService.propose(
      p,
      g,
      `${summary}\n\n验证结论：${review.summary}`,
    );
    const delivery = this.store.create("deliveries", {
      ...proposed,
      ...(signal.aborted ? { status: "cancelled" as const } : {}),
    });
    if (signal.aborted) {
      this.event(
        g.requestId,
        g.id,
        "cancelled-delivery",
        "停止期间交付准备已返回，已保留产物但取消合并授权。",
        { deliveryId: delivery.id },
      );
      return;
    }
    this.setGroup(g.id, "awaiting_approval");
    this.event(
      g.requestId,
      g.id,
      "delivery",
      `已完成：${g.title}\n仓库：${g.repository?.name || p.name}\n${review.summary}\n${delivery.mode === "github" ? delivery.url : `本地分支：${g.branch}`}\n提交：${headSha}\n批准合并 ${g.requestId} ${delivery.token}`,
      { deliveryId: delivery.id },
      true,
    );
  }
  async collectArtifacts(g: Group, paths: string[]) {
    const outputs: string[] = [];
    const root = await realpath(g.worktree);
    const dir = path.join(this.dataDir, "artifacts", g.id);
    await mkdir(dir, { recursive: true });
    for (const [index, file] of paths.entries()) {
      const actual = await realpath(path.resolve(g.worktree, file));
      if (!actual.startsWith(root + path.sep))
        throw new Error("产物必须位于当前 worktree");
      const target = path.join(
        dir,
        `${Date.now()}-${index}-${path.basename(actual)}`,
      );
      await copyFile(actual, target);
      outputs.push(target);
    }
    return outputs;
  }
  rework(groupId: string, feedback: string) {
    const g = this.store.get("groups", groupId);
    if (g.reworks >= 2) {
      this.setGroup(g.id, "blocked");
      this.event(
        g.requestId,
        g.id,
        "blocked",
        `两轮自动返工后仍未通过：${feedback}`,
        null,
        true,
      );
      return;
    }
    this.store.patch("groups", g.id, { reworks: g.reworks + 1, feedback });
    this.setGroup(g.id, "queued");
    this.event(
      g.requestId,
      g.id,
      "rework",
      `正在返工（${g.reworks + 1}/2）：${feedback}`,
      null,
      true,
    );
  }
  setGroup(id: string, status: Status) {
    const g = this.store.patch("groups", id, { status });
    for (const taskId of g.taskIds)
      this.store.patch("tasks", taskId, { status });
    this.refreshRequest(g.requestId);
  }
  refreshRequest(id: string) {
    const groups = this.store.all("groups").filter((g) => g.requestId === id);
    if (!groups.length) return;
    const statuses = groups.map((g) => g.status);
    const status: Status = statuses.every((s) => s === "delivered")
      ? "delivered"
      : statuses.every((s) => s === "cancelled")
        ? "cancelled"
        : statuses.includes("running")
          ? "running"
          : statuses.includes("verifying")
            ? "verifying"
            : statuses.includes("awaiting_approval")
              ? "awaiting_approval"
              : statuses.includes("blocked")
                ? "blocked"
                : "queued";
    this.store.patch("tasks", id, { status });
  }
  failTask(id: string, error: unknown) {
    if (this.store.get("tasks", id).status === "cancelled") return;
    const message = error instanceof Error ? error.message : String(error);
    this.store.patch("tasks", id, { status: "blocked", summary: message });
    this.event(id, null, "blocked", message, null, true);
  }
  failGroup(id: string, error: unknown) {
    const g = this.store.get("groups", id);
    if (g.status === "cancelled") return;
    this.setGroup(id, "blocked");
    this.event(
      g.requestId,
      id,
      "blocked",
      error instanceof Error ? error.message : String(error),
      null,
      true,
    );
  }
  async stop(taskId: string) {
    const t = this.store.get("tasks", taskId);
    const root = t.parentId || t.id;
    // 项目会话由 App 持有，旧执行组的中断机制无法停止它。
    if (this.store.setting(`native:project-execution:${root}`, false))
      throw new Error("该任务由 Codex 项目会话执行，请先在 App 中停止该会话；工作台无法确认已停止");
    if (
      this.store
        .all("groups")
        .some((g) => g.requestId === root && this.merging.has(g.id))
    )
      throw new Error("交付正在核对或合并，暂不能停止");
    this.planning.get(root)?.abort();
    if (this.store.get("tasks", root).controllerMode === "native") this.native?.changed(root);
    this.store.setSetting(`pending-input:${root}`, []);
    for (const g of this.store
      .all("groups")
      .filter((g) => g.requestId === root && g.status !== "delivered")) {
      this.setGroup(g.id, "cancelled");
      this.active.get(g.id)?.abort();
      for (const d of this.store
        .all("deliveries")
        .filter((d) => d.groupId === g.id && d.status !== "merged"))
        this.store.patch("deliveries", d.id, { status: "cancelled" });
    }
    if (t.status !== "delivered")
      this.store.patch("tasks", root, { status: "cancelled" });
    this.event(
      root,
      null,
      "stopped",
      "任务已停止；已有分支、产物和记录保留。",
      null,
      true,
    );
  }
  async supplement(taskId: string, text: string, messageId?: string) {
    const t = this.store.get("tasks", taskId);
    if (t.parentId) throw new Error("请向根任务补充需求");
    if (t.status === "delivered" || t.status === "cancelled")
      throw new Error("已结束的任务请创建新的需求");
    if (messageId && this.store.maybe("events", messageId)) return;
    if (
      this.store
        .all("groups")
        .some((g) => g.requestId === t.id && this.merging.has(g.id))
    )
      throw new Error("交付合并已经开始，请待结果确认后创建后续需求");
    if (t.controllerMode === "native") {
      this.store.patch("tasks", t.id, { revision: (t.revision || 1) + 1 });
      this.native?.changed(t.id);
    }
    if (
      this.planning.has(t.id) ||
      this.store
        .all("groups")
        .some((g) => g.requestId === t.id && this.active.has(g.id))
    ) {
      this.store.transaction(() => {
        const key = `pending-input:${taskId}`;
        this.store.setSetting(key, [
          ...this.store.setting<string[]>(key, []),
          text,
        ]);
        if (messageId)
          this.store.create(
            "events",
            {
              taskId,
              groupId: null,
              type: "queued-input",
              message: text,
              detail: null,
            },
            messageId,
          );
      });
      this.event(
        taskId,
        null,
        "queued-input",
        "已记录补充要求，当前回合结束后重新执行和验收；在应用补充前不能合并。",
        null,
        true,
      );
      return;
    }
    const groups = this.store.all("groups").filter((g) => g.requestId === t.id);
    this.store.transaction(() => {
      this.store.patch("tasks", t.id, {
        goal: `${t.goal}\n\n用户补充：${text}`,
        criteria: [...t.criteria, `满足用户补充要求：${text}`],
        question: "",
        status: groups.length ? "queued" : "clarifying",
        interventions: t.interventions + 1,
      });
      for (const g of groups.filter((g) => g.status !== "delivered")) {
        this.store.patch("groups", g.id, {
          feedback: `${g.feedback}\n用户补充：${text}`,
          goal: `${g.goal}\n用户补充：${text}`,
          criteria: [...g.criteria, `满足用户补充要求：${text}`],
          reworks: 0,
        });
        this.setGroup(g.id, "queued");
        for (const d of this.store
          .all("deliveries")
          .filter((d) => d.groupId === g.id && d.status !== "merged"))
          this.store.patch("deliveries", d.id, { status: "stale" });
      }
      if (messageId)
        this.store.create(
          "events",
          {
            taskId,
            groupId: null,
            type: "supplement",
            message: text,
            detail: null,
          },
          messageId,
        );
    });
    this.event(
      t.id,
      null,
      "supplement",
      "已收到补充要求，将重新执行和验证。",
      null,
      true,
    );
    if (t.controllerMode === "native") this.native?.plan(t.id);
    this.wake();
  }
  async resume(taskId: string) {
    const t = this.store.get("tasks", taskId);
    const groups = this.store
      .all("groups")
      .filter((g) => g.requestId === taskId && g.status === "blocked");
    if (t.status === "cancelled" || t.status === "delivered")
      throw new Error("已结束任务不能恢复，请新建需求");
    for (const g of groups) {
      if (this.active.has(g.id)) throw new Error("执行尚未退出");
      if (g.sessionId) {
        const state: any = await this.agent.observe(g.sessionId, g.worktree);
        const turns = state.thread?.turns ?? [];
        if (turns.some((x: any) => x.status === "inProgress"))
          throw new Error("旧 Codex 会话仍在运行，未启动重复执行");
      }
      this.setGroup(g.id, "queued");
      this.store.setSetting(`recovery-required:${g.id}`, false);
    }
    if (!this.store.all("groups").some((g) => g.requestId === taskId))
      this.store.patch("tasks", taskId, { status: "clarifying", question: "" });
    if (t.controllerMode === "native") {
      this.store.patch("tasks", t.id, { revision: (t.revision || 1) + 1 });
      this.native?.changed(t.id);
      this.native?.plan(t.id);
    }
    this.event(
      taskId,
      null,
      "resume",
      "已请求恢复，现有工作目录和会话保持。",
      null,
      true,
    );
    this.wake();
  }
  async approve(taskId: string, token: string) {
    if (this.store.setting<string[]>(`pending-input:${taskId}`, []).length)
      throw new Error("还有补充要求等待应用，请等待重新执行和验收后确认");
    const d = this.store
      .all("deliveries")
      .find((d) => d.requestId === taskId && d.token === token);
    if (!d) throw new Error("确认编号与任务不匹配");
    if (d.status === "merged") return "该版本已经交付";
    if (d.status !== "pending") throw new Error("该确认已失效或正在处理");
    const g = this.store.get("groups", d.groupId),
      p = projectForGroup(this.store.get("projects", g.projectId), g);
    if (this.merging.has(g.id) || g.status !== "awaiting_approval")
      throw new Error("当前任务不在待交付状态");
    this.merging.add(g.id);
    try {
      // 交付串行使用共享仓库锁，并在外部调用前持久化授权；恢复时依据实际 Git 结果核对。
      return await this.withRuntime(
        `repository:${g.repositoryId || g.projectId}`,
        async () => {
          // 等待共享仓库锁期间可能收到补充或状态更新，不能沿用等待前的授权状态。
          if (
            this.store.get("deliveries", d.id).status !== "pending" ||
            this.store.get("groups", g.id).status !== "awaiting_approval" ||
            this.store.setting<string[]>(`pending-input:${taskId}`, []).length
          )
            throw new Error("交付状态已变化，请重新核对后确认");
          try {
            await this.gitService.validateDelivery(p, g, d);
          } catch (e) {
            if (
              /变化|未提交文件/.test(e instanceof Error ? e.message : String(e))
            ) {
              this.store.patch("deliveries", d.id, { status: "stale" });
              this.setGroup(g.id, "blocked");
              this.event(
                taskId,
                g.id,
                "stale",
                "交付基线或版本已变化，请恢复执行以整合最新基线并重新验证。",
                null,
                true,
              );
            }
            throw e;
          }
          this.store.patch("deliveries", d.id, {
            status: "merging",
            approvedAt: now(),
          });
          try {
            const sha = await this.gitService.merge(p, g, d);
            this.completeDelivery(d.id, sha);
            return `已交付，合并提交 ${sha}`;
          } catch (e) {
            this.event(
              taskId,
              g.id,
              "delivery-error",
              "合并未得到确认，将核对实际结果后再继续。",
              null,
              true,
            );
            const sha = await this.gitService.reconcile(p, d).catch(() => null);
            if (sha) {
              this.completeDelivery(d.id, sha);
              return `已核实交付，提交 ${sha}`;
            }
            this.store.patch("deliveries", d.id, {
              status: "pending",
              approvedAt: null,
            });
            throw e;
          }
        },
      );
    } finally {
      this.merging.delete(g.id);
    }
  }
  completeDelivery(id: string, sha: string) {
    const d = this.store.patch("deliveries", id, {
      status: "merged",
      mergeSha: sha,
    });
    this.setGroup(d.groupId, "delivered");
    this.event(
      d.requestId,
      d.groupId,
      "delivered",
      `已核实交付。合并提交：${sha}`,
      null,
      true,
    );
    this.wake();
  }
  async draftSkill(taskId: string) {
    const t = this.store.get("tasks", taskId);
    if (t.status !== "delivered")
      throw new Error("请在任务完成交付后提炼 Skill 草稿");
    if (t.controllerMode === "native") {
      this.native?.draft(taskId);
      return { status: "pending", message: "已请求 App 主控提炼草稿" };
    }
    const operation = `skill:${taskId}`;
    if (this.planning.has(operation))
      throw new Error("正在提炼此任务的 Skill 草稿");
    const abort = new AbortController();
    this.planning.set(operation, abort);
    try {
      const p = this.store.get("projects", t.projectId),
        groupIds = new Set(
          this.store
            .all("groups")
            .filter((g) => g.requestId === taskId)
            .map((g) => g.id),
        );
      const schema = z.object({
        name: z.string().min(1).max(100),
        content: z.string().min(1).max(100000),
      });
      const result = schema.parse(
        await this.ai(taskId, null, {
          cwd: p.repoPath,
          role: "controller",
          signal: abort.signal,
          schema: z.toJSONSchema(schema),
          prompt: `从本次已交付的真实任务中提炼一个项目级 Skill 草稿。只保存可重复的方法、适用前提和已验证命令，不写未经验证的结论，不把临时路径或单次成功上升为全局保证。输出 Markdown 内容。\n需求：${t.goal}\n证据：${JSON.stringify(
            this.store
              .all("evidence")
              .filter((e) => groupIds.has(e.groupId))
              .map((e) => ({
                command: e.command,
                exitCode: e.exitCode,
                summary: e.summary,
              })),
          )}`,
        }),
      );
      const version = createHash("sha256").update(result.content).digest("hex");
      const skill = this.store.create("skills", {
        ...result,
        projectId: p.id,
        version,
        status: "draft",
      });
      const dir = path.join(this.dataDir, "knowledge", p.id);
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, `${skill.id}-${version.slice(0, 12)}.md`),
        skill.content,
      );
      this.event(
        taskId,
        null,
        "skill-draft",
        `已生成 Skill 草稿「${skill.name}」，等待你检查并启用。`,
      );
      return skill;
    } finally {
      this.planning.delete(operation);
      this.wake();
    }
  }
  progressNotifications() {
    for (const g of this.store
      .all("groups")
      .filter((g) => ["running", "verifying"].includes(g.status))) {
      if (
        Date.now() - Date.parse(g.lastSummaryAt) < 600000 ||
        !g.progress ||
        g.progress === g.lastSummary
      )
        continue;
      this.store.patch("groups", g.id, {
        lastSummaryAt: now(),
        lastSummary: g.progress,
      });
      this.event(
        g.requestId,
        g.id,
        "progress",
        `${g.title}：${labels[g.status]}\n${g.progress.slice(-500)}`,
        null,
        true,
      );
    }
  }
  async handleMessage(content: string, messageId: string, metadata?: { origin?: MessageOrigin; routing: "legacy" | "native" }) {
    const text = content.trim();
    // 明确的只读指令在两种渠道路由之前处理，不创建任务或触发主控回合。
    const query = taskQueryCommand(text, this.store, taskMessages(this.store));
    if (query !== null) return query;
    const operation = text.match(/^(确认完成|重发)\s+(T-[\w-]+)$/i);
    if (operation && metadata?.origin) {
      if (operation[1] === "确认完成") return confirmTask(this.store, operation[2], `${metadata.origin.channel} 用户`).message;
      if (!this.native) throw new Error("原生派发服务不可用，请先核对队列");
      return requestResend(this.store, operation[2], () => { void this.native!.pump(); }).message;
    }
    if (metadata?.routing === "native" && metadata.origin) {
      // 来源在入站时固定；暂停原生模式后也不把已接收的自然语言悄悄转成旧指令或新任务。
      if (!this.native) throw new Error("原生主控组件尚未就绪，消息已保留");
      let result: string | undefined;
      const stop = text.match(/^(?:停止|停止任务)\s+(\S+)$/), approve = text.match(/^批准合并\s+(\S+)\s+(\S+)$/);
      const target = stop?.[1] || approve?.[1];
      if (target) this.directControls.add(target);
      try {
        if (stop) { await this.stop(stop[1]); result = "已停止任务"; }
        else if (approve) result = await this.approve(approve[1], approve[2]);
      } finally { if (target) this.directControls.delete(target); }
      if (result !== undefined) { this.native.direct(content, messageId, metadata.origin, result); return result; }
      return this.native.receive(content, messageId, metadata.origin);
    }
    if (text === "帮助")
      return "项目\n任务 [运行|待用户处理|待核对|待执行|完成|全部]\n查看 <任务ID>\n确认完成 <任务ID>\n重发 <任务ID>\n新任务 <项目ID>：需求\n补充 <任务ID>：要求\n恢复 <任务ID>\n停止 <任务ID>\n批准合并 <任务ID> <确认编号>";
    if (text === "项目")
      return (
        this.store
          .all("projects")
          .map(
            (p) =>
              `${p.id} · ${p.name} · ${repositoriesOf(p).length} 个仓库 · ${projectIssues(p).length ? "待配置：" + projectIssues(p).join("；") : "可执行"}`,
          )
          .join("\n") || "请先在 Web 工作台注册本地项目。"
      );
    let m = text.match(/^新任务\s+(\S+)\s*[:：]\s*([\s\S]+)$/);
    if (m) {
      const t = this.request(
        m[1],
        m[2].slice(0, 80),
        m[2],
        metadata?.origin?.channel ?? "dingtalk",
        messageId,
        metadata?.origin,
      );
      return `已接收 ${t.id}：${t.title}`;
    }
    m = text.match(/^查看\s+(\S+)$/);
    if (m) {
      const t = this.store.get("tasks", m[1]);
      const groups = this.store
        .all("groups")
        .filter((g) => g.requestId === t.id);
      return `${t.id} ${t.title}\n${labels[t.status]}\n${t.question || t.summary}\n${groups.map((g) => `${g.repository?.name || "仓库"} / ${g.title}：${labels[g.status]}`).join("\n")}`;
    }
    m = text.match(/^停止\s+(\S+)$/);
    if (m) {
      await this.stop(m[1]);
      return "已停止任务";
    }
    m = text.match(/^恢复\s+(\S+)$/);
    if (m) {
      await this.resume(m[1]);
      return "已请求恢复";
    }
    m = text.match(/^补充\s+(\S+?)\s*[:：]\s*([\s\S]+)$/);
    if (m) {
      await this.supplement(m[1], m[2], messageId);
      return "已记录补充要求";
    }
    m = text.match(/^批准合并\s+(\S+)\s+(\S+)$/);
    if (m) return this.approve(m[1], m[2]);
    const projects = this.store.all("projects");
    if (projects.length === 1) {
      const t = this.request(
        projects[0].id,
        text.slice(0, 80),
        text,
        metadata?.origin?.channel ?? "dingtalk",
        messageId,
        metadata?.origin,
      );
      return `已接收 ${t.id}：${t.title}`;
    }
    return "请发送“项目”查看项目，然后发送“新任务 <项目ID>：需求”。发送“帮助”查看控制指令。";
  }
  async shutdown() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    for (const c of this.active.values()) c.abort();
    for (const c of this.planning.values()) c.abort();
    while (this.active.size || this.planning.size || this.merging.size)
      await new Promise((r) => setTimeout(r, 100));
  }
}
