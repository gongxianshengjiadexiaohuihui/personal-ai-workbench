import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { Engine } from "../src/engine.js";
import { queryTasks, taskMessages } from "../src/task-query.js";
import { confirmTask, requestResend } from "../src/task-actions.js";

const dir = mkdtempSync(path.join(os.tmpdir(), "task-actions-"));
const store = new Store(path.join(dir, "test.sqlite"));
try {
  const task = (id: string, status: any) => store.create("tasks", { projectId: "p", parentId: null, groupId: null, title: id, goal: "", criteria: [], status, question: "内部核对", summary: "", controllerSession: "session", source: "web", interventions: 0, controllerMode: "native" }, id);
  const message = (id: string, status: string, extra = {}) => store.setSetting(`native:message:${id}`, { id, kind: "executor", taskIds: [id], status, turnId: null, ...extra });
  task("T-review", "clarifying"); message("T-review", "completed", { turnId: "turn", finalText: "执行结果" });
  assert.equal(queryTasks(store, taskMessages(store)).find(t => t.id === "T-review")?.category, "review");
  confirmTask(store, "T-review", "用户");
  assert.equal(queryTasks(store, taskMessages(store)).find(t => t.id === "T-review")?.category, "completed");
  assert.equal(store.get("tasks", "T-review").status, "clarifying");
  store.create("deliveries", { requestId: "T-review", groupId: "g", status: "pending" } as any, "D-pending");
  assert.equal(queryTasks(store, taskMessages(store)).find(t => t.id === "T-review")?.category, "user");
  store.patch("deliveries", "D-pending", { status: "merged" } as any);
  store.patch("tasks", "T-review", { question: "新需求" });
  assert.equal(queryTasks(store, taskMessages(store)).find(t => t.id === "T-review")?.category, "review");
  task("T-internal", "clarifying");
  assert.throws(() => confirmTask(store, "T-internal", "用户"));
  task("T-pending", "running"); message("T-pending", "pending");
  let wakes = 0;
  requestResend(store, "T-pending", () => wakes++);
  assert.equal(wakes, 1);
  for (const status of ["queued", "running", "uncertain", "completed"]) {
    message("T-pending", status);
    assert.throws(() => requestResend(store, "T-pending", () => wakes++));
  }
  assert.equal(wakes, 1);
  const engine = new Engine(store, null as any, null as any, null as any, dir);
  for (const channel of ["weixin", "dingtalk"] as const) for (const routing of ["native", "legacy"] as const) {
    task(`T-${channel}-${routing}`, "clarifying"); message(`T-${channel}-${routing}`, "completed", { finalText: "结果", turnId: "turn" });
    assert.match(await engine.handleMessage(`确认完成 T-${channel}-${routing}`, "incoming", { routing, origin: { channel, senderId: "user", conversationId: "user" } }), /已完成/);
  }
  console.log("任务操作验证通过：显式确认、结果变化失效、内部核对拒绝、待发唤醒及重复派发保护、双渠道双路由");
} finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
