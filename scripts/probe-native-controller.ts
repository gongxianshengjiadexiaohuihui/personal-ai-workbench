import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { command } from "../src/process.js";
import { NativeProbeRpc, readNativeDiagnostics } from "./lib/native-probe-rpc.js";
import { NativeProbeOutbox } from "./lib/native-probe-outbox.js";

const options = process.argv.slice(2);
const create = options.includes("--create-fixture");
const resumeAt = options.indexOf("--resume-fixture");
const bindAt = options.indexOf("--bind-app-thread");
const queueAt = options.indexOf("--queue-fixture");
const eventAt = options.indexOf("--event-id");
const bin = process.env.CODEX_BIN || "/usr/local/bin/codex";
const root = path.resolve(".data/verification/native-controller");
function isProbeDirectory(cwd: string) {
  return cwd.startsWith(root + path.sep) || (
    cwd.startsWith(path.join(os.homedir(), "Documents/Codex") + path.sep) &&
    path.basename(cwd) === "personal-workstation-native-probe"
  );
}
await mkdir(root, { recursive: true, mode: 0o700 });
const report: Record<string, any> = {
  schemaVersion: 1, checkedAt: new Date().toISOString(),
  scope: "standalone-app-server-probe", nativeGate: "not-verified",
  checks: {},
};
const version = await command(bin, ["--version"]);
report.cliVersion = version.stdout.trim();
const daemon = await command(bin, ["app-server", "daemon", "version"], undefined, { timeout: 10_000 });
report.checks.sharedDaemon = {
  status: daemon.code === 0 ? "available" : "unavailable",
  detail: daemon.code === 0 ? "Default control endpoint responds" : "Default control endpoint is unavailable; no daemon was started",
};
const rpc = new NativeProbeRpc(bin);
try {
  await rpc.initialize();
  report.diagnostics = await readNativeDiagnostics(rpc);
  if (bindAt >= 0) {
    const file = path.join(root, "fixture.json");
    const fixture = JSON.parse(await readFile(file, "utf8"));
    const { thread } = await rpc.request("thread/read", {
      threadId: options[bindAt + 1], includeTurns: false,
    });
    if (!isProbeDirectory(thread.cwd)) throw new Error("Not an App probe directory");
    fixture.threadId = thread.id;
    fixture.cwd = thread.cwd;
    await writeFile(file, JSON.stringify(fixture, null, 2) + "\n", { mode: 0o600 });
    report.fixture = fixture;
  }
  if (queueAt >= 0) {
    const fixture = JSON.parse(await readFile(path.resolve(options[queueAt + 1] || ""), "utf8"));
    if (!isProbeDirectory(fixture.cwd) || !fixture.threadId) throw new Error("Not an App probe fixture");
    const outbox = new NativeProbeOutbox(path.join(root, "outbox.sqlite"));
    try {
      const eventId = eventAt >= 0 ? options[eventAt + 1] : "personal-workstation-native-outbox-acceptance-v1";
      if (!eventId || !/^[A-Za-z0-9._:-]{1,160}$/.test(eventId)) throw new Error("Invalid probe event ID");
      outbox.add(eventId, fixture.threadId, "这是已授权的持久发件箱去重测试。不使用工具，不访问文件，仅回复 APP_OUTBOX_ONCE。");
      const results = await Promise.all([
        outbox.deliver(rpc, eventId), outbox.deliver(rpc, eventId),
      ]);
      report.fixture = fixture;
      report.checks.outbox = { eventId, attempts: results.map(({ state, submissionId }) => ({ state, submissionId })) };
    } finally { outbox.close(); }
  }
  if (create || resumeAt >= 0) {
    let fixture: { projectId: string; threadId: string | null; cwd: string };
    const fixtureFile = resumeAt >= 0
      ? path.resolve(options[resumeAt + 1] || "")
      : path.join(root, "fixture.json");
    if (resumeAt >= 0) {
      fixture = JSON.parse(await readFile(fixtureFile, "utf8"));
      // 只允许接续探针目录中的测试会话，拒绝用此脚本操作业务任务。
      if (!isProbeDirectory(fixture.cwd) || !fixture.threadId)
        throw new Error("Not a native-controller probe fixture");
      await rpc.request("thread/resume", {
        threadId: fixture.threadId, cwd: fixture.cwd, sandbox: "read-only", approvalPolicy: "never",
        excludeTurns: true,
      });
    } else {
      try { await readFile(fixtureFile); throw new Error("Fixture exists; use --resume-fixture instead"); }
      catch (e: any) { if (e.code !== "ENOENT") throw e; }
      const cwd = path.join(root, "workspace");
      await mkdir(cwd, { recursive: true });
      await writeFile(path.join(cwd, "README.md"), "# 原生主控接入验证\n\n专用测试目录，不包含业务仓库。\n");
      const response = await rpc.request("project/create", {
        name: "主控接入验证（临时）", roots: [{ path: cwd }],
        metadata: { purpose: "personal-workstation-native-probe" },
        idempotencyKey: "personal-workstation-native-probe:" + cwd,
      });
      fixture = { projectId: response.project.id, cwd, threadId: null };
      // 项目先独立保存。App 会话随后通过桌面入口创建，不冒充桌面客户端来源。
      await writeFile(fixtureFile, JSON.stringify(fixture, null, 2) + "\n", { mode: 0o600 });
    }
    report.fixture = fixture;
    if (fixture.threadId) {
      const memory = await rpc.request("thread/memory/read", { threadId: fixture.threadId }).catch(() => null);
      report.checks.threadMemory = { status: memory ? "available" : "unavailable", hasSummary: !!memory?.summary?.trim() };
      const eventId = randomUUID();
      const marker = `EXTERNAL_EVENT_${eventId}`;
      // 在发起回合前订阅，避免短回合完成早于 RPC 应答。只收集该会话的输出标记。
      let output = "";
      let startedTurnId: string | null = null;
      const completions = new Map<string, any>();
      let finish: ((turn: any) => void) | undefined;
      const listener = (message: any) => {
        if (message.params?.threadId !== fixture.threadId) return;
        if (message.method === "item/completed" && message.params.item?.type === "agentMessage")
          output = message.params.item.text || "";
        if (message.method === "turn/completed") {
          const turn = message.params.turn;
          completions.set(turn.id, turn);
          if (turn.id === startedTurnId) finish?.(turn);
        }
      };
      rpc.events.on("notification", listener);
      try {
        const turn = await rpc.request("turn/start", {
          threadId: fixture.threadId,
          input: [{ type: "text", text: `这是已授权的原生接入测试事件 ${eventId}。不要使用工具或访问文件，仅回复：${marker}` }],
          approvalPolicy: "never", sandboxPolicy: { type: "readOnly", networkAccess: false },
        });
        startedTurnId = turn.turn.id;
        const completed = await new Promise<any>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("Probe turn timeout")), 120_000);
          finish = (value) => { clearTimeout(timeout); resolve(value); };
          const early = completions.get(startedTurnId!);
          if (early) finish(early);
        });
        report.checks.externalTurn = {
          status: completed.status, threadId: fixture.threadId,
          turnId: startedTurnId, eventId, expectedMarker: marker, markerReceived: output.trim() === marker,
        };
      } finally { rpc.events.off("notification", listener); }
    }
  }
} catch (e) {
  report.error = String(e);
  process.exitCode = 1;
} finally {
  rpc.close();
  // 外部 RPC 成功不等于 App 原生门禁通过；桌面可见性、并发和重启必须另行验收。
  const file = path.join(root, `report-${Date.now()}.json`);
  await writeFile(file, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ ...report, reportFile: file }, null, 2));
}
