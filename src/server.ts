import { ProjectImporter } from "./project-import.js";
import { ProjectService } from "./projects.js";
import Fastify from "fastify";
import { resolveDingTalkOwner } from "./channels/dingtalk-owner.js";
import fastifyStatic from "@fastify/static";
import { existsSync, createReadStream } from "node:fs";
import { mkdir, writeFile, realpath } from "node:fs/promises";
import path from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { z } from "zod";
import { requestInput } from "./domain.js";
import { NativeController } from "./native/controller.js";
import { readFile } from "node:fs/promises";
import { Engine } from "./engine.js";
import { queryTasks, taskMessages } from "./task-query.js";
import { confirmTask, requestResend } from "./task-actions.js";
import { WeixinChannel } from "./channels/weixin.js";
import { DingTalkChannel } from "./channels/dingtalk.js";
import { command } from "./process.js";
import type { Config } from "./config.js";
import { git } from "./git.js";
import {
  dingtalkConfigInput,
  dingtalkConfigSchema,
  saveDingTalkConfig,
} from "./dingtalk-config.js";

export async function buildServer(
  engine: Engine,
  channel: DingTalkChannel,
  config: Config,
  resolveOwner = resolveDingTalkOwner,
  native?: NativeController,
  weixin?: WeixinChannel,
) {
  const app = Fastify({
    logger: false,
    bodyLimit: 1000000,
    forceCloseConnections: true,
  });
  const csrf = randomBytes(24).toString("hex");
  const store = engine.store;
  const projects = new ProjectService(store, engine.gitService);
  await projects.migrate();
  const importer = new ProjectImporter(projects);
  let authStatus = "尚未检查";
  const refreshAuth = async () => {
    try {
      const r = await command(config.codexBin, ["login", "status"], undefined, {
        timeout: 15000,
      });
      const text = r.stdout + r.stderr;
      authStatus = /api.?key/i.test(text)
        ? "API Key 配置（有效性在实际请求时验证）"
        : /chatgpt/i.test(text)
          ? "ChatGPT 登录"
          : r.code === 0
            ? "已有 Codex 登录"
            : "未登录或配置不可用";
    } catch {
      authStatus = "Codex CLI 不可用";
    }
  };
  void refreshAuth();
  const allowedHosts = new Set([
    `127.0.0.1:${config.port}`,
    `localhost:${config.port}`,
    "127.0.0.1:5178",
    "localhost:5178",
  ]);
  app.addHook("onRequest", async (req, reply) => {
    // 只绑定 loopback 仍需校验 Host/Origin，避免浏览器从其他站点操控本地仓库。
    if (!allowedHosts.has(req.headers.host ?? ""))
      return reply.code(403).send({ error: "不允许的 Host" });
    if (req.headers.origin) {
      let allowed = false;
      try {
        const url = new URL(req.headers.origin);
        allowed = url.protocol === "http:" && allowedHosts.has(url.host);
      } catch {}
      if (!allowed) return reply.code(403).send({ error: "不允许的来源" });
    }
    if (req.url === "/api/controller/rpc" && req.method === "POST") {
      if (!native?.token || req.headers.authorization !== `Bearer ${native.token}` || req.headers.origin) return reply.code(403).send({ error: "仅允许主控 MCP 凭据，拒绝浏览器来源" });
      return;
    }
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.headers["x-workbench-token"] !== csrf
    )
      return reply.code(403).send({ error: "请从本机工作台提交操作" });
  });
  app.setErrorHandler((error, req, reply) => {
    reply
      .code(400)
      .send({ error: error instanceof Error ? error.message : String(error) });
  });
  app.get("/api/session", () => ({ token: csrf }));
  app.get("/api/health", () => ({ status: "ok", version: "0.1.0" }));
  app.get("/api/projects/discover", () =>
    importer.source.discover(store.all("projects")),
  );
  app.post("/api/projects/import/preview", (req) => importer.preview(req.body));
  app.post("/api/projects/import/confirm", async (req) => {
    const result = await importer.confirm(req.body);
    engine.event(null, null, "project", `已导入项目：${result.project.name}`);
    return result;
  });
  app.get("/api/projects", () => store.all("projects"));
  app.post("/api/projects", async (req) => {
    const p = await projects.save(req.body);
    engine.event(null, null, "project", `已注册本地项目：${p.name}`);
    return p;
  });
  app.put<{ Params: { id: string } }>("/api/projects/:id", async (req) => {
    return projects.save(req.body, req.params.id);
  });
  app.get("/api/tasks", () =>
    store
      .all("tasks")
      .filter((t) => !t.parentId)
      .reverse(),
  );
  app.get("/api/task-query", () => queryTasks(store, taskMessages(store)));
  app.post<{ Params: { id: string } }>("/api/tasks/:id/confirm-complete", req => confirmTask(store, req.params.id, "本机工作台用户"));
  app.post<{ Params: { id: string } }>("/api/tasks/:id/resend", req => {
    if (!native) throw new Error("原生派发服务不可用，请先核对队列");
    return requestResend(store, req.params.id, () => { void native.pump(); });
  });
  app.post<{ Params: { id: string }; Body: { image: string } }>("/api/tasks/:id/weixin-image", { bodyLimit: 15 * 1024 * 1024 }, async req => {
    if (!weixin) throw new Error("微信通道不可用");
    const body = z.object({ image: z.string().min(1).max(14 * 1024 * 1024).regex(/^[A-Za-z0-9+/]+={0,2}$/) }).parse(req.body);
    return weixin.enqueueImage(req.params.id, Buffer.from(body.image, "base64"));
  });
  app.post("/api/tasks", (req) => {
    const b = requestInput.parse(req.body);
    return engine.request(b.projectId, b.title, b.goal);
  });
  app.get<{ Params: { id: string } }>("/api/tasks/:id", (req) => {
    const task = store.get("tasks", req.params.id);
    const groups = store.all("groups").filter((g) => g.requestId === task.id);
    const ids = new Set(groups.map((g) => g.id));
    return {
      task,
      groups,
      subtasks: store.all("tasks").filter((t) => t.parentId === task.id),
      runs: store.all("runs").filter((r) => r.taskId === task.id),
      evidence: store.all("evidence").filter((e) => ids.has(e.groupId)),
      deliveries: store
        .all("deliveries")
        .filter((d) => d.requestId === task.id),
      events: store.all("events").filter((e) => e.taskId === task.id),
    };
  });
  app.post<{ Params: { id: string } }>(
    "/api/tasks/:id/supplement",
    async (req) => {
      const b = z
        .object({ text: z.string().trim().min(1).max(30000) })
        .parse(req.body);
      await engine.supplement(req.params.id, b.text);
      return { ok: true };
    },
  );
  app.get<{ Params: { id: string } }>("/api/groups/:id/diff", async (req) => {
    const group = store.get("groups", req.params.id);
    if (!group.worktree || !group.headSha)
      throw new Error("尚未生成可检查的提交");
    const stat = await git(group.worktree, [
      "diff",
      "--stat",
      group.baseSha,
      group.headSha,
      "--",
    ]);
    const patch = await git(group.worktree, [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      group.baseSha,
      group.headSha,
      "--",
    ]);
    return {
      baseSha: group.baseSha,
      headSha: group.headSha,
      stat,
      patch,
      note: "大差异最多显示末尾约 2 MB，请在本地仓库检查完整提交。",
    };
  });
  app.post<{ Params: { id: string } }>("/api/tasks/:id/stop", async (req) => {
    await engine.stop(req.params.id);
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>("/api/tasks/:id/resume", async (req) => {
    await engine.resume(req.params.id);
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>(
    "/api/tasks/:id/approve",
    async (req) => {
      const b = z.object({ token: z.string().min(1) }).parse(req.body);
      return { message: await engine.approve(req.params.id, b.token) };
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/tasks/:id/skill-draft",
    async (req) => engine.draftSkill(req.params.id),
  );
  app.get("/api/settings", () => ({
    native: native?.status() ?? null,
    codex: {
      ...engine.agent.capabilities(),
      executable: config.codexBin,
      model: config.model || "沿用 CLI 配置",
      authentication: authStatus,
    },
    dingtalk: channel.status(),
    weixin: weixin?.status() ?? null,
    maxConcurrent: engine.maxConcurrent,
    dataDir: config.dataDir,
    version: "0.1.0",
    notifications: store
      .all("outbox")
      .filter((x) => x.status === "pending")
      .slice(-20),
  }));
  app.put("/api/settings", (req) => {
    const b = z
      .object({ maxConcurrent: z.number().int().min(1).max(8) })
      .parse(req.body);
    store.setSetting("maxConcurrent", b.maxConcurrent);
    engine.maxConcurrent = b.maxConcurrent;
    engine.wake();
    return { ok: true };
  });
  let savingDingTalk = false;
  app.put("/api/settings/dingtalk", async (req) => {
    if (savingDingTalk) throw new Error("正在保存钉钉配置，请稍候");
    const input = dingtalkConfigInput.parse(req.body);
    if (!input.clientSecret && input.clientId !== channel.config.clientId)
      throw new Error("更换应用时请填写对应的 AppSecret");
    const clientSecret = input.clientSecret || channel.config.clientSecret;
    if (!clientSecret) throw new Error("首次配置请填写 AppSecret");
    savingDingTalk = true;
    try {
      // Validate the new application and recipient before replacing a working configuration.
      const ownerId = await resolveOwner({ ...input, clientSecret });
      const next = dingtalkConfigSchema.parse({
        ...input,
        clientSecret,
        ownerId,
      });
      await saveDingTalkConfig(config.dataDir, next);
      await channel.configure(next);
      return {
        message: "钉钉配置已保存并生效，可查看连接状态或发送测试消息。",
        dingtalk: channel.status(),
      };
    } finally {
      savingDingTalk = false;
    }
  });
  app.post("/api/settings/weixin/bind", async () => {
    if (!weixin) throw new Error("微信通道不可用");
    return weixin.beginLogin();
  });
  app.post("/api/settings/weixin/verify-code", req => {
    if (!weixin) throw new Error("微信通道不可用");
    const { code } = z.object({ code: z.string().trim().regex(/^\d{1,12}$/) }).parse(req.body);
    weixin.submitCode(code);
    return { message: "验证码已提交" };
  });
  app.post("/api/settings/check-codex", async () => {
    await refreshAuth();
    return { authentication: authStatus };
  });
  app.post("/api/settings/test-dingtalk", () => {
    if (!channel.configured) throw new Error("请先在系统设置中保存钉钉配置");
    engine.event(
      null,
      null,
      "channel-test",
      "个人 AI 工作台消息通道测试：收到此消息后，请回复“项目”。",
      null,
      true,
    );
    void channel.pump();
    return { message: "测试消息已排队，发送结果见通道状态" };
  });
  if (native) {
    app.get("/api/channel-messages", () => native.conversations.view());
    app.put("/api/settings/native", req => native.configure(req.body));
    app.put("/api/settings/native/desktop-wake", req => {
      const b = z.object({ enabled: z.boolean() }).parse(req.body);
      return native.configureDesktopWake(b.enabled);
    });
    app.post("/api/settings/native/check", () => native.diagnose());
    app.post<{ Params: { id: string } }>("/api/channel-messages/:id/resolve-interrupted", req => {
      const b = z.object({ turnId: z.string().min(1).max(200), reason: z.string().trim().min(10).max(2000) }).parse(req.body);
      return native.resolveInterrupted(req.params.id, b.turnId, b.reason);
    });
    app.post("/api/controller/rpc", async req => {
      const { name, arguments: args } = z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()).default({}) }).parse(req.body);
      const id = z.string().min(1).max(200);
      if (name === "create_request") {
        const b = requestInput.extend({ sourceMessageId: id.optional(), operationId: id }).parse(args);
        return native.createRequest(b);
      }
      if (name === "list_tasks") { const b = z.object({ projectId: id.optional() }).parse(args); return store.all("tasks").filter(t => !t.parentId && (!b.projectId || t.projectId === b.projectId)); }
      if (name === "query_tasks") {
        const b = z.object({ projectId: id.optional(), taskId: id.optional(), category: z.enum(["running", "user", "review", "queued", "completed", "other"]).optional() }).parse(args);
        const tasks = queryTasks(store, taskMessages(store)).filter(t => (!b.projectId || t.projectId === b.projectId) && (!b.taskId || t.id === b.taskId) && (!b.category || t.category === b.category));
        return { count: tasks.length, tasks };
      }
      if (name === "discover_projects") return importer.source.discover(store.all("projects"));
      if (name === "task_action") {
        const b = z.object({ taskId: id, action: z.enum(["stop", "resume"]), operationId: id }).parse(args); native.context(b.taskId);
        return native.operation(b.operationId, { name, ...b }, async () => { await engine[b.action](b.taskId); return { ok: true, task: store.get("tasks", b.taskId) }; });
      }
      if (name === "get_context") return native.context(z.object({ taskId: id.optional() }).parse(args).taskId);
      if (name === "bind_task") { const b = z.object({ taskId: id, threadId: id }).parse(args); return native.bindTask(b.taskId, b.threadId); }
      if (name === "send_task_message") {
        const b = z.object({ taskId: id, sourceMessageId: id }).parse(args);
        native.context(b.taskId);
        const message = native.conversations.get(b.sourceMessageId);
        if (message.kind !== "user") throw new Error("只能转交用户消息");
        return native.queueProjectMessage(b.taskId, b.sourceMessageId, `用户对该任务的补充或确认：\n${message.content}\n请继续执行并报告实际结果、验证和阻塞。`);
      }
      if (name === "send_task_image") {
        const b = z.object({ taskId: id, sourceMessageId: id, imagePath: z.string().min(1).max(4000), operationId: id }).parse(args);
        native.context(b.taskId);
        const source = native.conversations.get(b.sourceMessageId);
        if (!weixin?.credentials || source.kind !== "user" || source.origin?.channel !== "weixin" || source.origin.accountId !== weixin.credentials.accountId || source.origin.senderId !== weixin.credentials.ownerId || source.origin.conversationId !== weixin.credentials.ownerId || !source.taskIds.includes(b.taskId)) throw new Error("没有关联该任务的当前微信用户授权消息");
        if (!path.isAbsolute(b.imagePath)) throw new Error("图片路径必须是绝对路径");
        // 含空格的 Markdown 目标用尖括号包裹；仍精确核对同任务已完成结果中的完整路径，
        // 不按目录、路径前缀或 realpath 别名放宽授权，与文件发送使用同样的两种引用形式。
        const result = native.conversations.all().find(m => m.kind === "executor" && m.status === "completed" && m.taskIds.includes(b.taskId) && (m.finalText?.includes(`](${b.imagePath})`) || m.finalText?.includes(`](<${b.imagePath}>)`)));
        if (!result) throw new Error("图片未出现在该任务已完成的项目会话结果中");
        return native.operation(b.operationId, { name, ...b }, async () => weixin.enqueueImage(b.taskId, await readFile(await realpath(b.imagePath))));
      }
      if (name === "get_image_delivery") {
        const b = z.object({ outboxId: id }).parse(args);
        const item = store.get("outbox", b.outboxId);
        if (!item.imagePath || item.origin?.channel !== "weixin") throw new Error("图片发送记录不存在");
        return { id: item.id, status: item.status, error: item.error };
      }
      if (name === "send_task_file") {
        const b = z.object({ taskId: id, sourceMessageId: id, filePath: z.string().min(1).max(4000), operationId: id }).parse(args);
        native.context(b.taskId);
        const source = native.conversations.get(b.sourceMessageId);
        if (!weixin?.credentials || source.kind !== "user" || source.origin?.channel !== "weixin" || source.origin.accountId !== weixin.credentials.accountId || source.origin.senderId !== weixin.credentials.ownerId || source.origin.conversationId !== weixin.credentials.ownerId || !source.taskIds.includes(b.taskId)) throw new Error("没有关联该任务的当前微信用户授权消息");
        if (!path.isAbsolute(b.filePath)) throw new Error("文件路径必须是绝对路径");
        const result = native.conversations.all().find(m => m.kind === "executor" && m.status === "completed" && m.taskIds.includes(b.taskId) && (m.finalText?.includes(`](${b.filePath})`) || m.finalText?.includes(`](<${b.filePath}>)`)));
        if (!result) throw new Error("文件未出现在该任务已完成的项目会话结果中");
        return native.operation(b.operationId, { name, ...b }, async () => weixin.enqueueFile(b.taskId, path.basename(b.filePath), await readFile(await realpath(b.filePath))));
      }
      if (name === "get_file_delivery") {
        const b = z.object({ outboxId: id }).parse(args);
        const item = store.get("outbox", b.outboxId);
        if (!item.filePath || item.origin?.channel !== "weixin") throw new Error("文件发送记录不存在");
        return { id: item.id, taskIds: item.taskIds, fileName: item.fileName, status: item.status, error: item.error };
      }
      if (name === "decide") { const b = z.object({ eventId: id, revision: z.number().int().positive(), decision: z.record(z.string(), z.unknown()) }).parse(args); return native.decide(b.eventId, b.revision, b.decision); }
      if (name === "supplement") {
        const b = z.object({ taskId: id, text: z.string().trim().min(1).max(30000), operationId: id }).parse(args);
        native.context(b.taskId);
        return native.operation(b.operationId, { name, ...b }, async () => { await engine.supplement(b.taskId, b.text, `native-input:${b.operationId}`); return { ok: true, context: native.context(b.taskId) }; });
      }
      if (name === "get_diff") { const b = z.object({ groupId: id }).parse(args), g = store.get("groups", b.groupId); native.context(g.requestId); return { headSha: g.headSha, diff: await engine.gitService.diff(g) }; }
      if (name === "get_evidence") {
        const b = z.object({ evidenceId: id }).parse(args), e = store.get("evidence", b.evidenceId), g = store.get("groups", e.groupId); native.context(g.requestId);
        let log = "";
        if (e.logPath) { const file = await realpath(e.logPath), root = await realpath(path.join(config.dataDir, "artifacts")); if (!file.startsWith(root + path.sep)) throw new Error("证据不属于本系统"); log = (await readFile(file, "utf8")).slice(0, 100000); }
        return { ...e, log };
      }
      if (name === "skill_draft") {
        const b = z.object({ taskId: id, operationId: id, name: z.string().min(1).max(100), content: z.string().min(1).max(100000) }).parse(args);
        native.context(b.taskId); const t = store.get("tasks", b.taskId);
        if (t.status !== "delivered") throw new Error("仅从已交付任务提炼草稿");
        const key = `native-skill:${b.operationId}`, old = store.maybe("skills", key);
        if (old) { if (old.content !== b.content || old.name !== b.name || old.projectId !== t.projectId) throw new Error("幂等编号已绑定其他内容"); return old; }
        const version = createHash("sha256").update(b.content).digest("hex"), dir = path.join(config.dataDir, "knowledge", t.projectId);
        await mkdir(dir, { recursive: true }); await writeFile(path.join(dir, `${version}.md`), b.content);
        return store.create("skills", { projectId: t.projectId, name: b.name, content: b.content, version, status: "draft" }, key);
      }
      throw new Error("主控工具不存在或越权；不能批准合并、配置系统或启用 Skill");
    });
  }
  app.get("/api/skills", () => store.all("skills"));
  app.post("/api/skills", async (req) => {
    const b = z
      .object({
        projectId: z.string(),
        name: z.string().trim().min(1).max(100),
        content: z.string().trim().min(1).max(100000),
      })
      .parse(req.body);
    store.get("projects", b.projectId);
    const version = createHash("sha256").update(b.content).digest("hex");
    const skill = store.create("skills", { ...b, version, status: "draft" });
    const dir = path.join(config.dataDir, "knowledge", b.projectId);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, `${skill.id}-${version.slice(0, 12)}.md`),
      b.content,
    );
    return skill;
  });
  app.post<{ Params: { id: string } }>("/api/skills/:id/activate", (req) => {
    const s = store.get("skills", req.params.id);
    store.transaction(() => {
      for (const old of store
        .all("skills")
        .filter(
          (x) =>
            x.projectId === s.projectId &&
            x.name === s.name &&
            x.status === "active",
        ))
        store.patch("skills", old.id, { status: "draft" });
      store.patch("skills", s.id, { status: "active" });
    });
    engine.event(
      null,
      null,
      "skill",
      `用户启用 Skill：${s.name}@${s.version.slice(0, 12)}`,
    );
    return { ok: true };
  });
  app.get("/api/metrics", () => {
    const tasks = store.all("tasks").filter((t) => !t.parentId),
      groups = store.all("groups"),
      runs = store.all("runs");
    const delivered = tasks.filter((t) => t.status === "delivered");
    // 交付后提炼 Skill 仍会更新任务，耗时应截止于实际合并记录。
    const durations = delivered.flatMap((task) => {
      const completed = store
        .all("deliveries")
        .filter((d) => d.requestId === task.id && d.status === "merged");
      return completed.length
        ? [
            (Math.max(...completed.map((d) => Date.parse(d.updatedAt))) -
              Date.parse(task.createdAt)) /
              60000,
          ]
        : [];
    });
    return {
      requests: tasks.length,
      delivered: delivered.length,
      blocked: tasks.filter((t) => t.status === "blocked").length,
      awaitingApproval: tasks.filter((t) => t.status === "awaiting_approval")
        .length,
      interventions: tasks.reduce((n, t) => n + t.interventions, 0),
      reworks: groups.reduce((n, g) => n + g.reworks, 0),
      averageDeliveredMinutes: durations.length
        ? durations.reduce((sum, value) => sum + value, 0) / durations.length
        : null,
      usage: runs
        .filter((r) => r.usage)
        .map((r) => ({ runId: r.id, usage: r.usage })),
      cost: null,
      acceptanceErrors: "未建立人工标注数据，不能推断误通过或误拒绝率",
    };
  });
  app.get<{ Params: { id: string }; Querystring: { artifact?: string } }>(
    "/api/evidence/:id/file",
    async (req, reply) => {
      const e = store.get("evidence", req.params.id);
      const file =
        req.query.artifact === undefined
          ? e.logPath
          : e.artifacts[Number(req.query.artifact)];
      if (!file) throw new Error("证据文件不存在");
      const root = await realpath(path.join(config.dataDir, "artifacts")),
        actual = await realpath(file);
      if (!actual.startsWith(root + path.sep))
        throw new Error("证据路径不属于本系统");
      const ext = path.extname(actual).toLowerCase();
      reply.header("x-content-type-options", "nosniff");
      reply.header("content-security-policy", "default-src 'none'; sandbox");
      reply.type(
        (
          {
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".webp": "image/webp",
          } as Record<string, string>
        )[ext] || "text/plain; charset=utf-8",
      );
      return reply.send(createReadStream(actual));
    },
  );
  app.get("/api/events", (req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    reply.raw.write("event: ready\ndata: {}\n\n");
    const listener = (data: unknown) =>
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    engine.events.on("change", listener);
    const timer = setInterval(() => reply.raw.write(": heartbeat\n\n"), 20000);
    req.raw.on("close", () => {
      clearInterval(timer);
      engine.events.off("change", listener);
    });
  });
  const web = path.resolve("web-dist");
  if (existsSync(web)) await app.register(fastifyStatic, { root: web });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api/"))
      return reply.code(404).send({ error: "接口不存在" });
    if (existsSync(web)) return reply.sendFile("index.html");
    return reply.code(503).send({ error: "请先 npm run build 生成工作台" });
  });
  return app;
}
