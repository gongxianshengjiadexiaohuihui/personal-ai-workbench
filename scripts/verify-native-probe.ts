import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { NativeProbeOutbox } from "./lib/native-probe-outbox.js";
import { diagnosticError, readNativeDiagnostics } from "./lib/native-probe-rpc.js";

const dir = await mkdtemp(path.join(os.tmpdir(), "native-probe-test-"));
let box = new NativeProbeOutbox(path.join(dir, "outbox.sqlite"));
let sends = 0, loseReply = false, unavailable = false;
const queue: any[] = [], history: any[] = [];
const client = { async request(method: string, params: any): Promise<any> {
  if (unavailable) throw new Error("offline");
  if (method === "thread/queue/list") return { data: [...queue], nextCursor: null };
  if (method === "thread/items/list") return { data: [...history], nextCursor: null };
  if (method === "thread/queue/add") {
    sends++;
    const item = { id: `queue-${sends}`, clientUserMessageId: params.clientUserMessageId };
    queue.push(item);
    if (loseReply) throw new Error("reply lost after acceptance");
    return { queuedSubmission: item };
  }
  throw new Error("Unexpected method");
} };
const passed: string[] = [];
try {
  box.add("event-1", "fixture", "one");
  await Promise.all([box.deliver(client, "event-1"), box.deliver(client, "event-1")]);
  assert.equal(sends, 1);
  assert.throws(() => box.add("event-1", "fixture", "changed"));
  passed.push("concurrent dispatch claims once; event ID binds immutable content");
  box.close(); box = new NativeProbeOutbox(path.join(dir, "outbox.sqlite"));
  await box.deliver(client, "event-1"); assert.equal(sends, 1);
  queue.length = 0; history.push({ turnId: "turn-1", item: { type: "userMessage", clientId: "event-1" } });
  assert.equal((await box.deliver(client, "event-1")).state, "consumed");
  assert.equal(sends, 1);
  passed.push("restart reconciles queued and consumed events without replay");
  loseReply = true; box.add("event-2", "fixture", "two");
  assert.equal((await box.deliver(client, "event-2")).state, "uncertain");
  box.close(); box = new NativeProbeOutbox(path.join(dir, "outbox.sqlite"));
  assert.equal((await box.deliver(client, "event-2")).state, "queued");
  assert.equal(sends, 2);
  queue.length = 0;
  await box.deliver(client, "event-2"); assert.equal(sends, 2);
  passed.push("lost response reconciles; absent receipt never causes blind retry");
  box.add("event-3", "fixture", "three"); unavailable = true;
  await assert.rejects(box.deliver(client, "event-3"));
  assert.equal(box.get("event-3").state, "pending");
  unavailable = false; loseReply = false;
  await box.deliver(client, "event-3"); assert.equal(sends, 3);
  passed.push("offline lookup retains pending event until connection recovers");
  const diagnostics = await readNativeDiagnostics({ request: async (method) => {
    if (method === "account/read") return { account: { type: "apiKey", email: "private@example.test", token: "private-token" } };
    if (method === "memory/status") return { v2Ready: false, v2ConsolidatedThreads: 65, summary: "private-memory" };
    if (method === "project/list") return { data: [{ name: "private-project" }] };
    return { config: { model_provider: "custom", model: "fixture", api_key: "private-key" } };
  } });
  assert.ok(!JSON.stringify(diagnostics).includes("private"));
  assert.ok(!diagnosticError("token=private-token sk-abcdef test@example.test https://example.test/?key=private").includes("private"));
  assert.equal((diagnostics.memory as any).ready, false);
  passed.push("diagnostics whitelist excludes credentials, personal fields and memory content");
  console.log(JSON.stringify({ mode: "simulated-protocol-real-sqlite", passed }, null, 2));
} finally { box.close(); await rm(dir, { recursive: true, force: true }); }
