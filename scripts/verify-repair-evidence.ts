// 模拟消息与临时 SQLite，不连接 App 或渠道。
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { RepairEvidence } from "../src/native/repair-evidence.js";
import { NativeController } from "../src/native/controller.js";
import type { ConversationMessage } from "../src/native/conversations.js";

const dir = await mkdtemp(path.join(os.tmpdir(), "repair-evidence-"));
let store = new Store(path.join(dir, "db.sqlite"));
try {
  let tracker = new RepairEvidence(store, () => "queued");
  const message: ConversationMessage = { id: "C-fixture", sourceId: "source", kind: "executor", content: "private",
    origin: null, threadId: "thread", turnId: null, status: "pending", taskIds: ["task"], replyIds: [], createdAt: new Date(0).toISOString() };
  tracker.observe([message], 1000, 5000);
  assert.equal(tracker.active().length, 0);
  tracker.observe([message], 6000, 5000);
  tracker.observe([message], 7000, 5000);
  assert.equal(tracker.active().length, 1);
  assert.equal(tracker.active()[0].latest.delivery, "queued");
  assert.equal(JSON.stringify(tracker.active()).includes("private"), false);
  store.close(); store = new Store(path.join(dir, "db.sqlite"));
  tracker = new RepairEvidence(store, () => "uncertain");
  tracker.observe([{ ...message, status: "uncertain", turnId: "turn" }], 8000, 5000);
  assert.equal(tracker.active()[0].latest.turnId, "turn");
  tracker.observe([{ ...message, status: "running", turnId: "turn" }], 9000, 5000);
  assert.equal(tracker.active().length, 1, "恢复运行不能自动认定排查结束");
  tracker.observe([{ ...message, status: "failed", turnId: "turn" }], 10000, 5000);
  assert.equal(tracker.active().length, 1, "失败仍需排查");
  store.create("projects", { name: "fixture" } as any, "fixture-project");
  store.create("tasks", { projectId: "fixture-project", controllerMode: "native" } as any, "task");
  store.create("tasks", { projectId: "fixture-project", controllerMode: "native" } as any, "other-task");
  const native = new NativeController({ store } as any, "/usr/bin/false", 48973);
  native.repairEvidence = tracker;
  native.conversations = { all: () => [] } as any;
  assert.equal(native.context("task").investigations.length, 1);
  assert.equal(native.context("other-task").investigations.length, 0, "任务上下文只返回自身排查记录");
  tracker.observe([{ ...message, status: "completed", turnId: "turn" }], 11000, 5000);
  assert.equal(tracker.active().length, 0);
  assert.equal(store.setting<any>("native:investigation:C-fixture", null).firstSeenAt, new Date(6000).toISOString());
  console.log("repair evidence: persistence, redaction and conservative state passed");
} finally { store.close(); await rm(dir, { recursive: true, force: true }); }
