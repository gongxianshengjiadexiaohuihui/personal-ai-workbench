// 仅使用临时工作台和 Fastify 注入，不启动服务、模型或消息渠道。
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
import { DingTalkChannel } from "../src/channels/dingtalk.js";
import { buildServer } from "../src/server.js";

const root = await mkdtemp(path.join(os.tmpdir(), "desktop-wake-api-"));
const store = new Store(path.join(root, "db.sqlite"));
const engine = new Engine(store, new CodexAdapter("/usr/bin/false"), new GitService(root), new Verifier("/usr/bin/false", root), root);
const native = new NativeController(engine, "/usr/bin/false", 48973);
const dingtalk = { clientId: "", clientSecret: "", robotCode: "", ownerId: "", ownerMobile: "" };
const channel = new DingTalkChannel(dingtalk, store, async () => "");
let app: Awaited<ReturnType<typeof buildServer>> | undefined;
try {
  await native.start();
  app = await buildServer(engine, channel, { port: 48973, maxConcurrent: 2, codexBin: "/usr/bin/false", model: undefined, dataDir: root, dingtalk }, undefined, native);
  const host = "localhost:48973";
  const session = await app.inject({ method: "GET", url: "/api/session", headers: { host } });
  const token = session.json().token;
  const put = (headers: Record<string, string>, enabled: boolean) => app!.inject({ method: "PUT", url: "/api/settings/native/desktop-wake", headers: { host, ...headers }, payload: { enabled } });
  assert.equal((await put({}, true)).statusCode, 403);
  assert.equal((await put({ "x-workbench-token": token, origin: "http://example.invalid" }, true)).statusCode, 403);
  assert.notEqual((await put({ "x-workbench-token": token }, true)).statusCode, 200, "未启用主控不能启用唤醒");
  store.setSetting("native:config", { ...native.config(), enabled: true });
  store.setSetting("native:paused", "用户暂停");
  assert.equal((await put({ "x-workbench-token": token }, true)).statusCode, 200);
  assert.equal(native.desktopWake.settings().enabled, true);
  assert.equal(store.setting("native:paused", ""), "用户暂停", "独立设置不得解除暂停");
  assert.equal((await put({ "x-workbench-token": token }, false)).statusCode, 200);
  assert.equal(native.desktopWake.settings().enabled, false);
  console.log("desktop wake API: local authorization and pause preservation passed");
} finally { await app?.close(); await native.close(); store.close(); await rm(root, { recursive: true, force: true }); }
