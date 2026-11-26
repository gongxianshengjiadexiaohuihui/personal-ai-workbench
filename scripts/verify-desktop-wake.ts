// 仅用虚拟协议与临时数据库测试，不打开 App、启动真实回合或发送渠道消息。
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { NativeOutbox } from "../src/native/outbox.js";
import { DesktopWake } from "../src/native/desktop-wake.js";
import type { ConversationMessage } from "../src/native/conversations.js";

async function fixture(run: (f: any) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "desktop-wake-test-"));
  const store = new Store(path.join(dir, "state.sqlite"));
  const box = new NativeOutbox(path.join(dir, "outbox.sqlite"));
  const threadId = "00000000-0000-7000-8000-000000000001", id = "C-fixture";
  const message: ConversationMessage = { id, sourceId: "source", kind: "executor", content: "private", origin: null,
    threadId, turnId: null, status: "queued", taskIds: ["task"], replyIds: [], createdAt: new Date(2000).toISOString() };
  let opens = 0, fail = false, turnStatus = "completed", queue: any[] = [], historyIncludes = false, onTurns: () => void = () => {};
  const rpc = { request: async (method: string, p: any): Promise<any> => {
    if (method === "thread/items/list") return { data: [], nextCursor: null };
    if (method === "thread/queue/add") { const item = { id: "submission", clientUserMessageId: p.clientUserMessageId }; queue.push(item); return { queuedSubmission: item }; }
    if (method === "thread/queue/list") return { data: queue, nextCursor: null };
    if (method === "thread/turns/list") { onTurns(); return { data: [{ id: "prior", status: turnStatus, items: historyIncludes ? [{ type: "userMessage", clientId: id }] : [] }], nextCursor: null }; }
    throw new Error(`Unexpected ${method}`);
  } };
  const wake = new DesktopWake(store, box, async () => { opens++; if (fail) throw new Error("lost receipt"); });
  try {
    store.create("tasks", { controllerMode: "native", controllerSession: threadId, status: "running" } as any, "task");
    store.setSetting(`native:message:${id}`, message);
    box.add(id, threadId, "fixture"); await box.deliver(rpc, id);
    await run({ store, box, wake, rpc, message, get opens() { return opens; },
      fail: () => { fail = true; }, interrupted: () => { turnStatus = "interrupted"; },
      consumed: () => { historyIncludes = true; }, extraQueue: () => queue.push({ id: "other", clientUserMessageId: "other" }),
      duringCheck: (fn: () => void) => { onTurns = fn; } });
  } finally { box.close(); store.close(); await rm(dir, { recursive: true, force: true }); }
}
const app = "/Applications/ChatGPT.app", at = 100000;
await fixture(async f => {
  assert.equal(await f.wake.maybeWake(f.rpc, f.message, app, at), false, "默认关闭");
  f.wake.configure(true, 1000);
  const results = await Promise.all([f.wake.maybeWake(f.rpc, f.message, app, at), f.wake.maybeWake(f.rpc, f.message, app, at)]);
  assert.equal(results.filter(Boolean).length, 1); assert.equal(f.opens, 1, "并发只导航一次");
  assert.equal(f.wake.status().recent[0].state, "requested", "系统接受不等于消息完成");
  assert.equal(await f.wake.maybeWake(f.rpc, f.message, app, at + 100000), false);
  const reopened = new DesktopWake(f.store, f.box, async () => { throw new Error("不能重复打开"); });
  assert.equal(await reopened.maybeWake(f.rpc, f.message, app, at + 200000), false, "重建协调器后仍保留意图");
  reopened.reconcile([{ ...f.message, status: "running", turnId: "turn-1" }]);
  assert.equal(reopened.status().recent[0].state, "observed");
  assert.equal(reopened.status().recent[0].observedStatus, "running", "观察到回合不代表业务完成");
});
await fixture(async f => {
  f.wake.configure(true, 1000); f.fail();
  assert.equal(await f.wake.maybeWake(f.rpc, f.message, app, at), true);
  assert.equal(f.wake.status().recent[0].state, "uncertain");
  assert.equal(f.wake.status().unknownCount, 1);
  assert.equal(await f.wake.maybeWake(f.rpc, f.message, app, at + 100000), false);
  assert.equal(f.opens, 1, "结果不明不自动重复导航");
  f.wake.reconcile([{ ...f.message, status: "completed", turnId: "turn-2" }]);
  assert.equal(f.wake.status().unknownCount, 0);
});
await fixture(async f => {
  f.wake.configure(true, 1000); f.interrupted();
  assert.equal(await f.wake.maybeWake(f.rpc, f.message, app, at), false); assert.equal(f.opens, 0);
});
await fixture(async f => {
  f.wake.configure(true, 1000); f.store.setSetting("native:paused", "用户暂停");
  assert.equal(f.wake.status().blockedReason, "主控已暂停");
  assert.equal(await f.wake.maybeWake(f.rpc, f.message, app, at), false); assert.equal(f.opens, 0);
});
await fixture(async f => {
  f.wake.configure(true, 1000); f.consumed();
  assert.equal(await f.wake.maybeWake(f.rpc, f.message, app, at), false); assert.equal(f.opens, 0);
});
await fixture(async f => {
  f.wake.configure(true, 1000); f.extraQueue();
  assert.equal(await f.wake.maybeWake(f.rpc, f.message, app, at), false); assert.equal(f.opens, 0);
});
await fixture(async f => {
  f.wake.configure(true, 1000); f.store.setSetting("native:operation:fixture", { status: "uncertain" });
  assert.equal(f.wake.status().blockedReason, "存在尚未核对的操作回执");
  assert.equal(await f.wake.maybeWake(f.rpc, f.message, app, at), false); assert.equal(f.opens, 0);
});
await fixture(async f => {
  f.wake.configure(true, 1000); f.duringCheck(() => f.wake.configure(false, at));
  assert.equal(await f.wake.maybeWake(f.rpc, f.message, app, at), false); assert.equal(f.opens, 0, "检查期间关闭不能唤醒");
});
await fixture(async f => {
  f.wake.configure(true, 1000); let scans = 0;
  f.duringCheck(() => { scans++; if (scans === 2) f.consumed(); });
  assert.equal(await f.wake.maybeWake(f.rpc, f.message, app, at), false); assert.equal(f.opens, 0, "历史变化时不能唤醒");
});
await fixture(async f => {
  f.wake.configure(true, 3000);
  assert.equal(await f.wake.maybeWake(f.rpc, f.message, app, at), false, "不自动唤醒启用前的旧消息");
  assert.equal(await f.wake.maybeWake(f.rpc, { ...f.message, threadId: "not-a-uuid" }, app, at), false);
});
await fixture(async f => {
  f.wake.configure(true, 1000);
  const main = { ...f.message, kind: "user", taskIds: [] };
  f.store.setSetting("native:config", { mainThreadId: main.threadId });
  f.store.setSetting(`native:message:${main.id}`, main);
  assert.equal(await f.wake.maybeWake(f.rpc, main, app, at), true, "未关联任务的主控用户消息可以唤醒");
  assert.equal(f.opens, 1);
});
await fixture(async f => {
  f.wake.configure(true, 1000);
  const main = { ...f.message, kind: "report", taskIds: [] };
  f.store.setSetting("native:config", { mainThreadId: "00000000-0000-7000-8000-000000000002" });
  f.store.setSetting(`native:message:${main.id}`, main);
  assert.equal(await f.wake.maybeWake(f.rpc, main, app, at), false, "非绑定主控不得唤醒");
  f.store.setSetting("native:config", { mainThreadId: main.threadId });
  f.store.setSetting("native:message:other", { ...main, id: "other", status: "uncertain", turnId: "turn" });
  assert.equal(await f.wake.maybeWake(f.rpc, main, app, at), false, "同会话未知回合阻止导航");
  assert.equal(f.opens, 0);
});
await fixture(async f => {
  const main = { ...f.message, kind: "user", taskIds: [] };
  f.store.setSetting("native:config", { mainThreadId: main.threadId });
  f.store.setSetting(`native:message:${main.id}`, main);
  f.store.setSetting("native:desktop-wake:settings", { enabled: true, enabledAt: 1000 });
  f.wake.initializeMainCutoff(3000);
  assert.equal(await f.wake.maybeWake(f.rpc, main, app, at), false, "升级前的主控消息不自动唤醒");
  assert.equal(f.opens, 0);
});
console.log("desktop wake: opt-in, queue evidence, pause, unknown outcomes and one-attempt checks passed");
