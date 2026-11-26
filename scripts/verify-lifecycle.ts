// 明确使用脚本执行器，只验证调度、恢复与 Git 实际副作用，不代表真实模型或钉钉联调。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { Store } from "../src/store.js";
import { Engine } from "../src/engine.js";
import { GitService, git } from "../src/git.js";
import { Verifier } from "../src/verification.js";
import type { AgentAdapter, AgentInput } from "../src/adapters/agent.js";

const parent = path.resolve(".data/verification");
await mkdir(parent, { recursive: true });
const root = await mkdtemp(path.join(parent, "lifecycle-"));
const repo = path.join(root, "repo"),
  data = path.join(root, "data");
await mkdir(repo, { recursive: true });
await git(repo, ["init", "-b", "main"]);
await git(repo, ["config", "user.name", "Lifecycle fixture"]);
await git(repo, ["config", "user.email", "fixture@localhost"]);
await writeFile(path.join(repo, "a.mjs"), "export const a = 0;\n");
await writeFile(path.join(repo, "b.mjs"), "export const b = 0;\n");
await git(repo, ["add", "."]);
await git(repo, ["commit", "-m", "Create lifecycle fixture"]);
class FixtureAgent implements AgentAdapter {
  running = 0;
  maxRunning = 0;
  holdRecovery = true;
  resumed = false;
  capabilities() {
    return {
      id: "scripted-lifecycle-fixture",
      resume: true,
      interrupt: true,
      structuredOutput: true,
    };
  }
  async start(input: AgentInput) {
    const id = input.sessionId || `fixture-${Math.random()}`;
    if (input.sessionId) this.resumed = true;
    input.onSession(id);
    input.onTurn?.(`turn-${id}`);
    let output: any;
    if (input.role === "controller") {
      const keys = input.prompt.includes("recover-test") ? ["c"] : ["a", "b"];
      output = {
        action: "plan",
        summary: "脚本调度验收计划",
        question: "",
        groups: keys.map((key) => ({
          key,
          title: `修改 ${key}`,
          goal: key,
          criteria: [`修改 ${key}.mjs`],
          dependsOn: [],
          tasks: [{ title: key, goal: key, criteria: [key] }],
        })),
      };
    } else if (input.role === "executor") {
      this.running++;
      this.maxRunning = Math.max(this.maxRunning, this.running);
      try {
        const key = input.prompt.match(/目标：([abc])\n/)![1];
        if (key === "c" && this.holdRecovery)
          await new Promise<void>((resolve, reject) => {
            const abort = () => reject(new Error("夹具执行被中断"));
            input.signal?.addEventListener("abort", abort, { once: true });
            if (input.signal?.aborted) abort();
          });
        await new Promise((r) => setTimeout(r, 120));
        if (input.signal?.aborted) throw new Error("夹具执行被中断");
        await writeFile(
          path.join(input.cwd, `${key}.mjs`),
          `export const ${key} = 1;\n`,
        );
        output = {
          summary: "脚本夹具已修改文件",
          blocked: false,
          question: "",
          artifacts: [],
        };
      } finally {
        this.running--;
      }
    } else
      output = {
        decision: "pass",
        summary: "夹具客观语法检查通过",
        feedback: "",
        artifacts: [],
      };
    return {
      sessionId: id,
      turnId: `turn-${id}`,
      output: JSON.stringify(output),
      usage: null,
    };
  }
  resume(input: AgentInput & { sessionId: string }) {
    return this.start(input);
  }
  async observe(sessionId: string) {
    return { thread: { id: sessionId, turns: [{ status: "interrupted" }] } };
  }
  async interrupt() {}
}
class ObservedVerifier extends Verifier {
  concurrent = 0;
  maxConcurrent = 0;
  override async run(...args: Parameters<Verifier["run"]>) {
    this.concurrent++;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
    try {
      return await super.run(...args);
    } finally {
      this.concurrent--;
    }
  }
}
let store = new Store(path.join(data, "workbench.sqlite"));
const agent = new FixtureAgent(),
  verifier = new ObservedVerifier("/usr/local/bin/codex", data);
let engine = new Engine(store, agent, new GitService(data), verifier, data, 2);
const wait = async (fn: () => boolean, label: string) => {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`等待超时：${label}`);
};
const results: string[] = [];
try {
  const project = store.create("projects", {
    name: "调度生命周期夹具",
    repoPath: repo,
    baseBranch: "main",
    deliveryMode: "local",
    githubRepo: "",
    verifyCommands: [
      `"${process.execPath}" --check a.mjs && "${process.execPath}" --check b.mjs`,
    ],
    runtimeKey: "shared-service",
    instructions: "",
  });
  await engine.start();
  const task = engine.request(project.id, "两个独立执行组", "parallel-test");
  await wait(() => {
    const gs = store.all("groups").filter((g) => g.requestId === task.id);
    return gs.length === 2 && gs.every((g) => g.status === "awaiting_approval");
  }, "两个分组等待确认");
  assert.equal(agent.maxRunning, 1);
  assert.equal(verifier.maxConcurrent, 1);
  results.push("同一仓库的两个执行组串行，共享 runtimeKey 的验证串行");
  const deliveries = store.all("deliveries");
  await engine.approve(task.id, deliveries[0].token);
  await assert.rejects(
    () => engine.approve(task.id, deliveries[1].token),
    /变化/,
  );
  assert.equal(store.get("deliveries", deliveries[1].id).status, "stale");
  results.push("第一组合并后，第二组旧基线确认失效");
  await engine.resume(task.id);
  await wait(
    () =>
      store
        .all("deliveries")
        .some(
          (d) => d.groupId === deliveries[1].groupId && d.status === "pending",
        ),
    "新基线验收",
  );
  const replacement = store
    .all("deliveries")
    .find(
      (d) => d.groupId === deliveries[1].groupId && d.status === "pending",
    )!;
  assert.notEqual(replacement.headSha, deliveries[1].headSha);
  assert.notEqual(replacement.token, deliveries[1].token);
  await engine.approve(task.id, replacement.token);
  assert.match(await readFile(path.join(repo, "a.mjs"), "utf8"), /= 1/);
  assert.match(await readFile(path.join(repo, "b.mjs"), "utf8"), /= 1/);
  results.push("正常合并新基线、重新验证、新确认后，两组修改均进入本地 main");
  const recovery = engine.request(project.id, "中断恢复验收", "recover-test");
  await wait(
    () =>
      store
        .all("groups")
        .some((g) => g.requestId === recovery.id && !!g.sessionId),
    "恢复夹具启动",
  );
  const original = store
    .all("groups")
    .find((g) => g.requestId === recovery.id)!;
  await engine.supplement(
    recovery.id,
    "保留文件末尾换行",
    "supplement-fixture",
  );
  await engine.supplement(
    recovery.id,
    "保留文件末尾换行",
    "supplement-fixture",
  );
  assert.equal(
    store.setting<string[]>(`pending-input:${recovery.id}`, []).length,
    1,
  );
  await engine.shutdown();
  store.close();
  store = new Store(path.join(data, "workbench.sqlite"));
  agent.holdRecovery = false;
  engine = new Engine(store, agent, new GitService(data), verifier, data, 2);
  await engine.start();
  assert.equal(store.get("tasks", recovery.id).status, "blocked");
  await engine.resume(recovery.id);
  await wait(
    () => store.get("tasks", recovery.id).status === "awaiting_approval",
    "中断恢复至可交付",
  );
  const recovered = store.get("groups", original.id);
  assert.equal(recovered.worktree, original.worktree);
  assert.equal(recovered.sessionId, original.sessionId);
  assert.ok(agent.resumed);
  assert.ok(recovered.criteria.some((c) => c.includes("保留文件末尾换行")));
  assert.equal(
    store.setting<string[]>(`pending-input:${recovery.id}`, []).length,
    0,
  );
  results.push(
    "执行中补充落库且重复消息去重；重启先核对旧会话，再将补充纳入验收条件",
  );
  results.push(
    "关闭服务并重开 SQLite 后，核对会话，复用原 worktree 与 session 恢复",
  );
  const recoveryDelivery = store
    .all("deliveries")
    .find((d) => d.requestId === recovery.id && d.status === "pending")!;
  await engine.stop(recovery.id);
  assert.equal(
    store.get("deliveries", recoveryDelivery.id).status,
    "cancelled",
  );
  await assert.rejects(() =>
    engine.approve(recovery.id, recoveryDelivery.token),
  );
  results.push("停止任务使待交付授权失效，不能继续合并");
  const report = {
    mode: "scripted-agent-real-git-and-sandbox",
    root,
    passed: results,
    time: new Date().toISOString(),
  };
  await writeFile(
    path.join(parent, "latest-lifecycle.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await engine.shutdown();
  store.close();
}
