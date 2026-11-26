// 脚本主控/执行器 + 真实 SQLite、Git worktree、macOS 验证与本地合并。非真实订阅模型验收。
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Store } from "../src/store.js";
import { Engine } from "../src/engine.js";
import { GitService, git } from "../src/git.js";
import { Verifier } from "../src/verification.js";
import { ProjectService } from "../src/projects.js";
import { NativeController } from "../src/native/controller.js";
import { buildServer } from "../src/server.js";
import { DingTalkChannel } from "../src/channels/dingtalk.js";
import type { AgentAdapter, AgentInput } from "../src/adapters/agent.js";
const root = await mkdtemp(path.join(os.tmpdir(), "native-controller-")), data = path.join(root, "data");
const store = new Store(path.join(data, "workbench.sqlite")), gitService = new GitService(data);
class Agent implements AgentAdapter {
  count = 0;
  capabilities() { return { id: "fixture", resume: true, interrupt: true, structuredOutput: true }; }
  async start(input: AgentInput) {
    assert.equal(input.role, "executor", "原生任务不允许调用旧主控或审查器");
    this.count++; input.onSession(`fixture-${this.count}`);
    await writeFile(path.join(input.cwd, "value.txt"), "1\n");
    return { sessionId: `fixture-${this.count}`, turnId: "fixture", output: JSON.stringify({ summary: "修改值", blocked: false, question: "", artifacts: [] }), usage: null };
  }
  resume(input: AgentInput) { return this.start(input); }
  async observe() { return { thread: { turns: [] } }; }
  async interrupt() {}
}
const agent = new Agent();
const engine = new Engine(store, agent, gitService, new Verifier("codex", data), data);
const native = new NativeController(engine, "codex", 48973);
const passed: string[] = [];
const channelConfig = { clientId: "", clientSecret: "", robotCode: "", ownerId: "", ownerMobile: "" };
const channel = new DingTalkChannel(channelConfig, store, (text, id) => engine.handleMessage(text, id));
let app: Awaited<ReturnType<typeof buildServer>> | undefined;
async function waitFor(fn: () => boolean) { const end = Date.now() + 15000; while (!fn()) { if (Date.now() > end) throw new Error("Timeout: " + JSON.stringify(store.all("groups"))); await new Promise(r => setTimeout(r, 25)); } }
try {
  const repos = [];
  for (const name of ["upstream", "downstream"]) {
    const dir = path.join(root, name); await mkdir(dir); await git(dir, ["init", "-b", "main"]);
    await git(dir, ["config", "user.name", "Fixture"]); await git(dir, ["config", "user.email", "fixture@localhost"]);
    await writeFile(path.join(dir, "value.txt"), "0\n"); await git(dir, ["add", "."]); await git(dir, ["commit", "-m", "base"]);
    repos.push({ name, repoPath: dir, baseBranch: "main", deliveryMode: "local", verifyCommands: ["test \"$(cat value.txt)\" = 1"], runtimeKey: "shared" });
  }
  const projects = new ProjectService(store, gitService); const p = await projects.save({ name: "native-fixture", repositories: repos });
  await native.start(); await engine.start();
  // 只替代接入门禁的已验证外部依赖，业务状态与 Git 均真实运行。
  store.setSetting("native:config", { enabled: true, projectId: "fixture-project", mainThreadId: "fixture-main", directory: root, inspections: true });
  native.onlinePid = process.pid; native.checkedAt = Date.now();
  const originalCfg = native.config();
  const mockRpc = { request: async (method: string) => method === "thread/read" ? { thread: { cwd: root, modelProvider: "custom", model: "fixture" } } : { account: { type: "apiKey" } } } as any;
  store.setSetting("native:config", { ...originalCfg, projectId: "", authentication: "subscription" });
  await assert.rejects(native.check(mockRpc, "fixture"), /订阅主控要求/);
  store.setSetting("native:config", { ...originalCfg, projectId: "", authentication: "existing" });
  await native.check(mockRpc, "fixture");
  store.setSetting("native:auth-binding", { provider: "openai", accountType: "chatgpt" });
  await assert.rejects(native.check(mockRpc, "fixture"), /认证来源已变化/);
  store.setSetting("native:auth-binding", null); store.setSetting("native:config", originalCfg);
  passed.push("订阅模式拒绝 API Key；显式 existing 模式接受原提供方，认证漂移被拒绝");
  const task = engine.request(p.id, "两个仓库", "上下游交付", "dingtalk", "native-fixture-message");
  assert.equal(engine.request(p.id, "duplicate", "duplicate", "dingtalk", "native-fixture-message").id, task.id);
  store.patch("tasks", task.id, { controllerSession: "fixture-specialist" }); native.plan(task.id);
  const event = native.events().find(e => e.taskId === task.id && e.kind === "plan")!;
  const plan = { action: "plan", summary: "上下游", question: "", groups: p.repositories!.map((r, i) => ({ key: String(i), repositoryId: r.repositoryId, title: r.name, goal: "value=1", criteria: ["value=1"], dependsOn: i ? ["0"] : [], tasks: [{ title: r.name, goal: "value=1", criteria: ["value=1"] }] })) };
  await assert.rejects(native.decide(event.id, 1, { ...plan, groups: [{ ...plan.groups[0], repositoryId: "outside" }] }));
  native.onlinePid = 0;
  await native.decide(event.id, 1, plan); await native.decide(event.id, 1, plan);
  await engine.tick(); assert.equal(agent.count, 0);
  assert.equal(store.all("groups").length, 2);
  native.onlinePid = process.pid; engine.wake();
  await waitFor(() => native.events().some(e => e.kind === "review") && engine.active.size === 0);
  let review = native.events().find(e => e.kind === "review")!;
  const approveReview = { decision: "pass", summary: "实际命令验证通过", feedback: "", artifacts: [] };
  await native.decide(review.id, review.revision, approveReview);
  assert.equal(agent.count, 1, "上游确认前不执行下游");
  const first = store.all("deliveries")[0];
  await engine.supplement(task.id, "仍需保证 value 等于 1", "native-input-fixture");
  assert.equal(store.get("deliveries", first.id).status, "stale");
  await assert.rejects(engine.approve(task.id, first.token));
  const task2 = store.get("tasks", task.id);
  await assert.rejects(native.decide(review.id, review.revision, { ...approveReview, summary: "changed" }));
  await engine.tick(); assert.equal(agent.count, 1, "新版本需原生主控重新确认执行");
  const nextPlan = native.events().find(e => e.kind === "plan" && e.status === "pending")!;
  await native.decide(nextPlan.id, task2.revision!, { action: "dispatch", summary: "按补充重新验证" });
  await waitFor(() => native.events().some(e => e.kind === "review" && e.status === "pending") && engine.active.size === 0);
  review = native.events().find(e => e.kind === "review" && e.status === "pending")!;
  await native.decide(review.id, review.revision, approveReview);
  const delivery = store.all("deliveries").find(d => d.status === "pending")!;
  await engine.approve(task.id, delivery.token);
  await waitFor(() => native.events().some(e => e.kind === "review" && e.status === "pending") && engine.active.size === 0);
  review = native.events().find(e => e.kind === "review" && e.status === "pending")!;
  await native.decide(review.id, review.revision, approveReview);
  await native.decide(review.id, review.revision, approveReview);
  const second = store.all("deliveries").find(d => d.status === "pending")!;
  await engine.approve(task.id, second.token);
  assert.equal(store.get("tasks", task.id).status, "delivered");
  for (const r of repos) assert.equal((await readFile(path.join(r.repoPath, "value.txt"), "utf8")).trim(), "1");
  assert.notEqual(store.all("groups")[0].worktree, store.all("groups")[1].worktree);
  passed.push("原生计划幂等、项目范围限制、App 离线暂停；真实双仓库 worktree/验证/逐项确认合并；无旧主控调用");
  passed.push("用户补充使旧确认失效；主控确认新版本前不重启执行；重复验收不重复交付");
  app = await buildServer(engine, channel, { port: 48973, maxConcurrent: 2, codexBin: "codex", model: undefined, dataDir: data, dingtalk: channelConfig }, undefined, native);
  const request = (body: any, headers: any = {}) => app!.inject({ method: "POST", url: "/api/controller/rpc", headers: { host: "localhost:48973", ...headers }, payload: body });
  assert.equal((await request({ name: "get_context" })).statusCode, 403);
  const headers = { authorization: `Bearer ${native.token}` };
  assert.equal((await request({ name: "approve", arguments: { taskId: task.id, token: second.token } }, headers)).statusCode, 400);
  assert.equal((await request({ name: "get_context" }, { ...headers, origin: "http://localhost:48973" })).statusCode, 403);
  assert.equal((await request({ name: "get_context", arguments: { taskId: task.id } }, headers)).statusCode, 200);
  passed.push("MCP 凭据不能批准合并，浏览器来源不能调用主控接口；允许读取任务证据");
  store.setSetting("native:inspection-day", "2000-01-01");
  await native.inspect(); // 首次建立游标，没有代码变化不创建模型事件。
  assert.equal(native.events().filter(e => e.kind === "inspection").length, 0);
  for (const r of p.repositories!) assert.equal(store.setting(`native:audit:${r.repositoryId}`, ""), await git(r.repoPath, ["rev-parse", "main"]));
  await writeFile(path.join(repos[0].repoPath, "new.txt"), "new\n"); await git(repos[0].repoPath, ["add", "."]); await git(repos[0].repoPath, ["commit", "-m", "new"]);
  store.setSetting("native:inspection-day", "2000-01-01"); await native.inspect(); await native.inspect();
  const audit = native.events().find(e => e.kind === "inspection")!;
  assert.equal(audit.detail.repositories.length, 1);
  const taskCount = store.all("tasks").length;
  await native.decide(audit.id, 1, { summary: "new.txt 增量，待确认业务含义；未修改代码" });
  assert.equal(store.all("tasks").length, taskCount);
  passed.push("巡检首次建立基线，无变化不调用模型；增量合并补做一次，仅保存报告不创建修复任务");
  // 实际关闭重建 Store，验证原生事件和历史交付编号保留。
  await app.close(); app = undefined; await engine.shutdown(); await native.close(); store.close();
  const restored = new Store(path.join(data, "workbench.sqlite"));
  assert.equal(restored.get("tasks", task.id).status, "delivered"); assert.equal(restored.get("deliveries", second.id).token, second.token);
  assert.equal(restored.setting<any>(`native:event:${audit.id}`, null).status, "handled"); restored.close();
  passed.push("真实 SQLite 重开保留事件、任务与确认编号");
  console.log(JSON.stringify({ mode: "scripted-controller-real-git-sqlite-sandbox", passed }, null, 2));
} finally { await app?.close(); await engine.shutdown(); await native.close(); try { store.close(); } catch {} await rm(root, { recursive: true, force: true }); }
