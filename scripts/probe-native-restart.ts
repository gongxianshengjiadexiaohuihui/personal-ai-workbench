import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { command } from "../src/process.js";
import { NativeProbeRpc, diagnosticError } from "./lib/native-probe-rpc.js";
import { NativeProbeOutbox } from "./lib/native-probe-outbox.js";

// 明确启动后才等待人工重启。只观察 App 进程；绝不替用户关闭或重启当前桌面。
const appPid = Number(process.argv[2]);
if (!Number.isSafeInteger(appPid) || appPid < 1) throw new Error("Usage: probe:native:restart -- <desktop-app-pid>");
const root = path.resolve(".data/verification/native-controller");
const fixture = JSON.parse(await readFile(path.join(root, "fixture.json"), "utf8"));
if (!fixture.threadId || !fixture.cwd.startsWith(path.join(os.homedir(), "Documents/Codex") + path.sep) ||
  path.basename(fixture.cwd) !== "personal-workstation-native-probe") throw new Error("App fixture required");
const executable = (await command("ps", ["-p", String(appPid), "-o", "comm="])).stdout.trim();
if (!/^\/Applications\/(?:ChatGPT|Codex)\.app\/Contents\/MacOS\//.test(executable))
  throw new Error("PID is not a supported desktop app main process");
const birth = (await command("ps", ["-p", String(appPid), "-o", "lstart="])).stdout.trim();
const report: Record<string, any> = {
  schemaVersion: 1, status: "waiting-for-user-restart", startedAt: new Date().toISOString(),
  threadId: fixture.threadId, appPid, timeoutMinutes: 15,
};
const file = path.join(root, "restart-probe.json");
const save = () => writeFile(file, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
const deadline = Date.now() + 15 * 60_000;
await save();
console.log("Restart probe armed for 15 minutes; waiting for the user to quit the desktop app.");
let outbox: NativeProbeOutbox | undefined;
try {
  let exited = false;
  let lastPoll = Date.now();
  report.maxPollGapMs = 0;
  while (Date.now() < deadline) {
    report.maxPollGapMs = Math.max(report.maxPollGapMs, Date.now() - lastPoll);
    lastPoll = Date.now();
    const current = await command("ps", ["-p", String(appPid), "-o", "lstart="]);
    if (current.code || current.stdout.trim() !== birth) { exited = true; break; }
    report.lastAppObservedAt = new Date().toISOString();
    await save();
    await delay(1000);
  }
  if (!exited) throw new Error("App was not restarted within the probe window");
  report.appExitedAt = new Date().toISOString();
  // 确认离线时刻。若用户重开太快，没有观察到离线就不冒充完成了离线投递验收。
  const processes = await command("ps", ["-axo", "comm="]);
  if (processes.stdout.split("\n").some((line) => line.trim() === executable))
    throw new Error("App already reopened before offline enqueue; retry the controlled test");
  report.offlineObservedAt = new Date().toISOString();
  outbox = new NativeProbeOutbox(path.join(root, "outbox.sqlite"));
  const eventId = `native-offline-${Date.now()}`;
  report.eventId = eventId;
  outbox.add(eventId, fixture.threadId, "这是已授权的 App 离线事件恢复验证。不使用工具、不访问文件，仅回复 APP_OFFLINE_EVENT_RECOVERED。");
  report.status = "offline-event-persisted";
  await save();
  let sent = false;
  while (Date.now() < deadline) {
    const rpc = new NativeProbeRpc(process.env.CODEX_BIN || "/usr/local/bin/codex");
    try {
      await rpc.initialize();
      const entry = await outbox.deliver(rpc, eventId);
      if (!sent && entry.state === "queued") {
        sent = true;
        report.queuedAt = new Date().toISOString();
        report.status = "waiting-for-app-to-consume";
        await save();
      }
      if (entry.state === "consumed") {
        const turns = await rpc.request("thread/turns/list", {
          threadId: fixture.threadId, limit: 100, itemsView: "full",
        });
        const matching = turns.data.filter((turn: any) => turn.items.some((item: any) =>
          item.type === "userMessage" && item.clientId === eventId));
        if (matching.length !== 1) throw new Error("Unexpected event occurrence count");
        const turn = matching[0];
        if (turn.status === "completed" && turn.items.some((item: any) =>
          item.type === "agentMessage" && item.text.trim() === "APP_OFFLINE_EVENT_RECOVERED")) {
          report.status = "passed";
          report.completedAt = new Date().toISOString();
          report.turnId = turn.id;
          report.nativeEventCount = 1;
          break;
        }
        if (turn.status === "failed" || turn.status === "interrupted") throw new Error("Recovery turn did not complete");
      }
    } finally { rpc.close(); }
    await delay(2000);
  }
  if (report.status !== "passed") throw new Error("Offline event has not completed; evidence remains pending");
} catch (e) {
  report.status = "not-passed";
  report.reason = diagnosticError(e);
  process.exitCode = 1;
} finally {
  outbox?.close();
  await save();
  console.log(JSON.stringify(report, null, 2));
}
