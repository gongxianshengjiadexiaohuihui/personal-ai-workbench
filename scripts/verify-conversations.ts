// 模拟钉钉/原生协议，真实 SQLite；禁止调用真实渠道或模型。
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { Engine } from "../src/engine.js";
import { CodexAdapter } from "../src/adapters/codex.js";
import { GitService } from "../src/git.js";
import { Verifier } from "../src/verification.js";
import { NativeController } from "../src/native/controller.js";
import { Conversations } from "../src/native/conversations.js";
import { NativeOutbox } from "../src/native/outbox.js";
import { DingTalkChannel } from "../src/channels/dingtalk.js";
import { splitMessage, enqueueReply } from "../src/channels/messages.js";
const root = await mkdtemp(path.join(os.tmpdir(), "workbench-conversations-"));
const store = new Store(path.join(root, "db.sqlite"));
const engine = new Engine(store, new CodexAdapter("/usr/bin/false"), new GitService(root), new Verifier("/usr/bin/false", root), root);
const native = new NativeController(engine, "/usr/bin/false", 48973);
const origin = { channel: "dingtalk" as const, senderId: "owner", conversationId: "single" };
const config = { clientId: "fixture", clientSecret: "fixture", robotCode: "fixture", ownerId: "owner" };
let callback: any, sent: string[] = [], routes: string[] = [], acks = 0;
const client: any = { connected: true, connect: async () => {}, disconnect() {}, on() {}, registerCallbackListener(_topic: any, fn: any) { callback = fn; }, socketCallBackResponse() { acks++; } };
const channel = new DingTalkChannel(config, store, async (text, id, metadata) => {
  routes.push(metadata!.routing); return engine.handleMessage(text, id, metadata);
}, () => client, () => native.enabled());
channel.send = async text => { sent.push(text); };
const finished = async () => { while (channel.busy) await new Promise(r => setTimeout(r, 1)); };
const inbound = (id: string, content: string, extra: any = {}) => callback({ headers: { messageId: id }, data: JSON.stringify({ msgId: id, senderStaffId: "owner", msgtype: "text", conversationType: "1", conversationId: "single", text: { content }, ...extra }) });
let turns: any[] = [], queue: any[] = [], adds = 0, pageCalls = 0;
const rpc = { async request(method: string, p: any): Promise<any> {
  if (method === "thread/turns/list") { pageCalls++; return p.cursor ? { data: turns, nextCursor: null } : { data: [{ id: "manual", status: "completed", items: [{ type: "userMessage", clientId: "app-manual" }, { type: "agentMessage", phase: "final_answer", text: "不可转发的 App 对话" }] }], nextCursor: "second" }; }
  if (method === "thread/items/list") return { data: turns.flatMap(t => t.items.map((item: any) => ({ turnId: t.id, item }))), nextCursor: null };
  if (method === "thread/queue/list") return { data: queue, nextCursor: null };
  if (method === "thread/queue/add") { adds++; const item = { id: `queue-${adds}`, clientUserMessageId: p.clientUserMessageId }; queue.push(item); return { queuedSubmission: item }; }
  throw new Error(`Unexpected ${method}`);
} };
try {
  await native.start();
  store.setSetting("native:config", { enabled: true, authentication: "existing", mainThreadId: "main", projectId: "fixture", directory: root, inspections: false });
  // 升级前积压消息保留旧路由，不回放到新主控。
  store.create("inbox", { content: "帮助", status: "pending", error: "" }, "legacy-pending");
  await channel.start(); await channel.pump();
  inbound("consult", "  你好，先讨论一下。\n不要创建任务。  "); await finished();
  inbound("consult", "  你好，先讨论一下。\n不要创建任务。  "); await finished();
  inbound("stranger", "不要接收", { senderStaffId: "stranger" }); await finished();
  inbound("group", "不支持群聊", { conversationType: "2" }); await finished();
  assert.equal(acks, 4); assert.deepEqual(routes, ["legacy", "native"]);
  assert.equal(store.all("tasks").length, 0);
  assert.equal(native.conversations.all().length, 1);
  const message = native.conversations.all()[0];
  assert.equal(message.content, "  你好，先讨论一下。\n不要创建任务。  ");
  await native.conversations.dispatch(rpc, message); await native.conversations.dispatch(rpc, message);
  assert.equal(adds, 1); assert.equal(native.conversations.get(message.id).status, "queued");
  await native.conversations.reconcile(rpc);
  assert.equal(native.conversations.get(message.id).replyIds.length, 0);
  // 真实 App 联调发现：非 writer 接口在回合运行时暂报 interrupted，之后才变为 completed。
  turns = [{ id: "matching-turn", status: "interrupted", error: null, items: [{ type: "userMessage", clientId: message.id }] }];
  await native.conversations.reconcile(rpc);
  assert.equal(native.conversations.get(message.id).status, "uncertain");
  assert.throws(() => native.conversations.resolveInterrupted(message.id, "wrong-turn", "已核对会话及业务操作，回合确实中断"));
  assert.equal(native.conversations.get(message.id).replyIds.length, 0);
  turns[0].status = "completed";
  await native.conversations.reconcile(rpc);
  assert.equal(native.conversations.get(message.id).replyIds.length, 0, "等待最终文本，不能提前结束");
  const long = "结果🌏中文\n".repeat(2000);
  turns = [{ id: "matching-turn", status: "completed", items: [{ type: "userMessage", clientId: message.id }, { type: "agentMessage", phase: "commentary", text: "内部进度不可转发" }, { type: "agentMessage", phase: "final_answer", text: long }] }]; queue = [];
  await native.conversations.reconcile(rpc); await native.conversations.reconcile(rpc);
  assert.ok(pageCalls >= 2);
  const complete = native.conversations.get(message.id);
  assert.equal(complete.turnId, "matching-turn"); assert.equal(complete.finalText, long);
  assert.equal(complete.replyIds.length, splitMessage(long).length);
  assert.equal(complete.replyIds.map(id => store.get("outbox", id).message.replace(/^\[\d+\/\d+\]\n/, "")).join(""), long);
  for (const id of complete.replyIds) assert.ok(Buffer.byteLength(store.get("outbox", id).message) <= 6000);
  const firstPart = complete.replyIds[0]; store.patch("outbox", firstPart, { status: "uncertain" });
  const sentBefore = sent.length; await channel.pump(); assert.equal(sent.length, sentBefore, "后续段不能越过未知回执");
  store.patch("outbox", firstPart, { status: "sent" });
  while (store.all("outbox").some(x => x.status === "pending")) await channel.pump();
  assert.equal(sent.slice(sentBefore).join(""), complete.replyIds.slice(1).map(id => store.get("outbox", id).message).join(""));
  assert.ok(!sent.join("").includes("不可转发"));
  assert.throws(() => enqueueReply(store, `native-reply-${message.id}-final`, "changed", "owner"));
  // 控制观察回合不转发；关闭模式仍接续已入站原生消息，不回退成任务。
  const observation = native.conversations.add("control:stop", "已停止", "main", origin, "control");
  native.conversations.finish(observation, "control-turn", "不要转发");
  assert.equal(native.conversations.get(observation.id).replyIds.length, 0);
  store.setSetting("native:config", { ...native.config(), enabled: false });
  await engine.handleMessage("关闭模式前已收到", "persisted-native", { routing: "native", origin });
  assert.equal(store.all("tasks").length, 0);
  assert.equal(native.conversations.all().at(-1)!.status, "pending");
  store.setSetting("native:config", { ...native.config(), enabled: true });
  // 客观业务记录与创建操作一起落盘，重试不能产生第二个任务。
  const p = store.create("projects", { name: "fixture", repoPath: root, baseBranch: "main", verifyCommands: ["true"], deliveryMode: "local", runtimeKey: "fixture", githubRepo: "", knowledge: "" } as any);
  const input = { projectId: p.id, title: "simple", goal: "只测试计划", sourceMessageId: message.id, operationId: "create-1" };
  const context: any = native.createRequest(input), again: any = native.createRequest(input);
  assert.equal(context.task.id, again.task.id); assert.equal(context.task.controllerSession, "main");
  assert.deepEqual(native.conversations.get(message.id).taskIds, [context.task.id]);
  assert.throws(() => native.createRequest({ ...input, goal: "different" }));
  native.conversations.save({ ...native.conversations.get(message.id), status: "running" });
  engine.event(context.task.id, null, "claimed", "已认领", null, true);
  const report = native.conversations.all().find(m => m.kind === "report" && m.coveredBy === message.id)!;
  assert.ok(report);
  native.conversations.finish(native.conversations.get(message.id), "matching-turn", long);
  assert.equal(native.conversations.get(report.id).status, "completed");
  assert.equal(native.conversations.get(report.id).replyIds.length, 0);
  // 来源消息走专项会话；无来源消息的任务仍由主控规划。
  assert.equal(context.events.some((e: any) => e.kind === "plan"), false);
  const planning: any = native.createRequest({ projectId: p.id, title: "planning", goal: "只测试计划", operationId: "create-plan" });
  const event = planning.events.find((e: any) => e.kind === "plan");
  assert.ok(event);
  await native.decide(event.id, 1, { action: "clarify", summary: "等待确认项目细节", question: "预期输出是什么？", groups: [] });
  assert.equal(store.get("tasks", planning.task.id).question, "预期输出是什么？");
  assert.equal(store.all("groups").length, 0);
  await assert.rejects(engine.handleMessage(`停止任务 ${context.task.id}`, "stop-project", { origin, routing: "native" }), /请先在 App 中停止/);
  await engine.handleMessage(`停止任务 ${planning.task.id}`, "stop-1", { origin, routing: "native" });
  assert.equal(store.get("tasks", planning.task.id).status, "cancelled"); assert.equal(engine.directControls.size, 0);
  assert.ok(native.conversations.all().some(m => m.sourceId === "control:stop-1"));
  let operations = 0;
  const op = () => native.operation("op1", { action: "test" }, async () => { operations++; return { ok: true }; });
  await op(); await op(); assert.equal(operations, 1);
  await assert.rejects(native.operation("op1", { action: "changed" }, async () => {}));
  // 发送之前崩溃：未认领的发件箱允许后续投递；发送后崩溃：未知结果不盲重试。
  const recover = native.conversations.add("recover", "restart", "main", origin);
  native.box.add(recover.id, "main", "restart"); native.conversations.save({ ...recover, status: "queued" });
  await native.conversations.reconcile(rpc, false);
  assert.equal(native.conversations.get(recover.id).status, "pending");
  const unknown = native.conversations.add("unknown", "uncertain", "main", origin);
  const failingRpc = { async request(method: string, p: any) { if (method === "thread/queue/add") { adds++; throw new Error("lost receipt"); } return rpc.request(method, p); } };
  await native.conversations.dispatch(failingRpc, unknown);
  const count = adds; await native.conversations.reconcile(rpc, false); assert.equal(adds, count);
  assert.equal(native.conversations.get(unknown.id).status, "uncertain");
  const reviewed = native.conversations.add("reviewed", "旧消息", "other-thread", origin);
  native.conversations.save({ ...reviewed, status: "uncertain", turnId: "old-turn" });
  const waiting = native.conversations.add("waiting", "后续消息", "other-thread", origin);
  const covered = native.conversations.add("covered", "旧进度", "other-thread", origin, "report");
  native.conversations.save({ ...covered, coveredBy: reviewed.id });
  assert.throws(() => native.conversations.resolveInterrupted(reviewed.id, "old-turn", "不足"));
  native.conversations.resolveInterrupted(reviewed.id, "old-turn", "已核对会话回合及关联任务，确认已经中断");
  assert.equal(native.conversations.get(reviewed.id).status, "interrupted_reviewed");
  assert.equal(native.conversations.get(reviewed.id).resolution?.turnId, "old-turn");
  assert.equal(native.conversations.get(covered.id).coveredBy, undefined);
  assert.equal(native.conversations.inflight().some(m => m.threadId === waiting.threadId), false);
  native.conversations.finish(native.conversations.get(reviewed.id), "old-turn", "迟到的结果");
  assert.equal(native.conversations.get(reviewed.id).status, "interrupted_reviewed");
  assert.throws(() => native.conversations.resolveInterrupted(reviewed.id, "old-turn", "已核对会话回合及关联任务，确认已经中断"));
  turns.push({ id: "quota-turn", status: "failed", error: { message: "insufficient_quota" }, items: [{ type: "userMessage", clientId: unknown.id }] });
  await native.conversations.reconcile(rpc, false);
  assert.match(store.setting("native:paused", ""), /额度/); assert.equal(native.config().authentication, "existing");
  assert.equal(native.conversations.get(unknown.id).status, "failed");
  // 模拟渠道网络回执丢失；独立实例用真实 send 方法但 fetch 被替换。
  await channel.stop();
  const network = new DingTalkChannel(config, store, async () => "", () => client);
  network.token = "fixture"; network.expires = Date.now() + 60000;
  const actualFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => { throw new Error("receipt lost"); };
    enqueueReply(store, "lost-network", "lost", "owner");
    await network.pump();
    assert.ok(store.all("outbox").some(o => o.status === "uncertain" && /回执未知/.test(o.error)));
  } finally { globalThis.fetch = actualFetch; await network.stop(); }
  // SQLite 真实关闭重开，历史回复与关联回合保持不变。
  await native.close(); store.close();
  const reopened = new Store(path.join(root, "db.sqlite")), box = new NativeOutbox(path.join(root, "native/outbox.sqlite"));
  const restored = new Conversations(reopened, box);
  assert.equal(restored.get(message.id).turnId, "matching-turn");
  assert.deepEqual(restored.get(message.id).replyIds, complete.replyIds);
  const sending = enqueueReply(reopened, "before-crash", "unknown send", "owner")[0];
  reopened.patch("outbox", sending, { status: "sending" });
  const restarted = new DingTalkChannel(config, reopened, async () => "", () => client);
  await restarted.start(); assert.equal(reopened.get("outbox", sending).status, "uncertain");
  await restarted.stop(); box.close(); reopened.close();
  console.log(JSON.stringify({ mode: "simulated-transports-real-sqlite", passed: ["授权单聊/完整文本/去重/旧入口兼容/咨询不建任务", "精确 clientId 与分页匹配/不转发 App 或 commentary/控制观察不回复", "Unicode 无损分段/顺序发送/未知回执不重发", "MCP 创建幂等/主控直接规划/紧急停止/操作幂等", "暂停不回退/重启恢复/额度暂停不切换提供方/历史回合与回复保留"] }, null, 2));
} finally { await channel.stop(); await native.close(); try { store.close(); } catch {} await rm(root, { recursive: true, force: true }); }
