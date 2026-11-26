import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/store.js";
import { queryTasks, taskMessages, taskQueryCommand } from "../src/task-query.js";
import { Engine } from "../src/engine.js";

const dir = mkdtempSync(path.join(os.tmpdir(), "task-query-"));
const store = new Store(path.join(dir, "test.sqlite"));
try {
  const task = (id: string, status: any, extra: object = {}) => store.create("tasks", { projectId: "p", parentId: null, groupId: null, title: id, goal: "", criteria: [], status, question: "", summary: "", controllerSession: "session", source: "web", interventions: 0, ...extra }, id);
  const message = (id: string, status: string) => store.setSetting(`native:message:${id}`, { id, kind: "executor", taskIds: [id], status, createdAt: new Date().toISOString() });
  task("T-queued", "running", { controllerMode: "native" }); message("T-queued", "queued");
  task("T-running", "running", { controllerMode: "native" }); message("T-running", "running");
  task("T-unknown", "running", { controllerMode: "native" });
  task("T-internal", "clarifying", { controllerMode: "native", question: "等待主控核对项目会话结果" });
  task("T-user", "clarifying", { question: "请提供需求" });
  task("T-done", "delivered");
  task("T-approval", "awaiting_approval");
  task("T-finished-turn", "running", { controllerMode: "native" });
  store.setSetting("native:message:T-finished-turn", { id: "T-finished-turn", kind: "executor", taskIds: ["T-finished-turn"], status: "running", error: "回合已结束，等待最终答复落盘" });
  task("T-child", "running", { parentId: "T-queued" });
  const result = queryTasks(store, taskMessages(store));
  assert.equal(result.length, 8);
  for (const [id, category] of [["T-queued", "queued"], ["T-running", "running"], ["T-unknown", "review"], ["T-internal", "review"], ["T-user", "user"], ["T-done", "completed"], ["T-approval", "user"], ["T-finished-turn", "review"]]) assert.equal(result.find(t => t.id === id)?.category, category);
  assert.match(result.find(t => t.id === "T-queued")!.stage, /未观察到消费.*未知/);
  const before = store.db.prepare("SELECT count(*) AS n FROM tasks").get()!.n;
  const engine = new Engine(store, null as any, null as any, null as any, dir);
  for (const routing of ["legacy", "native"] as const) {
    assert.match(await engine.handleMessage("任务 待执行", "id", { routing, origin: { channel: "weixin", senderId: "s", conversationId: "s" } }), /T-queued/);
    assert.match(await engine.handleMessage("查看 T-queued", "id", { routing, origin: { channel: "dingtalk", senderId: "s", conversationId: "s" } }), /实际执行未知/);
  }
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM tasks").get()!.n, before);
  assert.equal(taskQueryCommand("查看 T-missing", store, taskMessages(store)), "未找到该根任务，请核对任务编号。");
  console.log("模拟验证通过：根任务去重、六类状态、未消费与内部核对、双渠道双路由查询不建任务");
} finally { store.db.close(); rmSync(dir, { recursive: true, force: true }); }

const real = process.argv[2];
if (real) {
  // 真实数据只用 SQLite 只读连接；不启动调度、写入消息或发送渠道回复。
  const db = new DatabaseSync(real, { readOnly: true });
  try {
    const reader = { db, all: (table: string) => db.prepare(`SELECT data FROM ${table} ORDER BY rowid`).all().map(r => JSON.parse(String(r.data))), setting: (id: string, fallback: unknown) => { const row = db.prepare("SELECT value FROM settings WHERE id=?").get(id); return row ? JSON.parse(String(row.value)) : fallback; } } as unknown as Store;
    const views = queryTasks(reader, taskMessages(reader));
    const counts = Object.fromEntries(["running", "user", "review", "queued", "completed", "other"].map(k => [k, views.filter(v => v.category === k).length]));
    console.log("真实数据库只读查询通过：根任务数", views.length, "分类数", JSON.stringify(counts));
  } finally { db.close(); }
}
