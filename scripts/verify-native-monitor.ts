// 仅使用临时 SQLite 与虚拟收件人，不启动真实渠道或 Codex App。
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { NativeMonitor } from "../src/native/monitor.js";

const dir = await mkdtemp(path.join(os.tmpdir(), "native-monitor-"));
let store = new Store(path.join(dir, "db.sqlite"));
const origin = { channel: "dingtalk" as const, senderId: "fixture", conversationId: "fixture" };
try {
  let targets = [origin];
  let monitor = new NativeMonitor(store, () => targets, 1000);
  monitor.observe("app-offline", "App 离线", 10000);
  monitor.resolve("app-offline", "已恢复", 10500);
  assert.equal(store.all("outbox").length, 0, "暂态离线不告警");
  targets = [];
  monitor.observe("app-offline", "App 离线", 20000);
  monitor.observe("app-offline", "App 离线", 22000);
  assert.equal(store.all("outbox").length, 0, "无绑定时保留事件");
  store.close();
  store = new Store(path.join(dir, "db.sqlite"));
  targets = [origin];
  monitor = new NativeMonitor(store, () => targets, 1000);
  monitor.observe("app-offline", "App 离线", 23000);
  monitor.observe("app-offline", "App 离线", 24000);
  assert.equal(store.all("outbox").length, 1, "重启和重复监测只产生一次告警");
  const alert = store.all("outbox")[0];
  store.patch("outbox", alert.id, { status: "uncertain" });
  monitor.resolve("app-offline", "已核对恢复", 25000);
  monitor.resolve("app-offline", "已核对恢复", 26000);
  assert.equal(store.all("outbox").length, 2, "恢复通知去重");
  assert.equal(store.get("outbox", alert.id).status, "uncertain", "未知渠道回执不可重置");
  const incidents = store.db.prepare("SELECT value FROM settings WHERE id LIKE 'native:monitor:incident:%'").all();
  assert.equal(incidents.length, 2);
  assert.ok(incidents.every(x => JSON.parse(String(x.value)).resolvedAt));
  console.log("native monitor: isolated persistence, debounce and deduplication passed");
} finally { store.close(); await rm(dir, { recursive: true, force: true }); }
