// 隔离数据库、凭据及网络；可用只读导出的真实 finalText 重放引用，绝不连接真实微信。
import assert from "node:assert/strict";
import { createDecipheriv } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Store } from "../src/store.js";
import { Engine } from "../src/engine.js";
import { CodexAdapter } from "../src/adapters/codex.js";
import { GitService } from "../src/git.js";
import { Verifier } from "../src/verification.js";
import { NativeController } from "../src/native/controller.js";
import { DingTalkChannel } from "../src/channels/dingtalk.js";
import { WeixinChannel } from "../src/channels/weixin.js";
import { buildServer as sourceBuildServer } from "../src/server.js";

const buildServer: typeof sourceBuildServer = process.env.WORKBENCH_IMAGE_SERVER
  ? (await import(pathToFileURL(process.env.WORKBENCH_IMAGE_SERVER).href)).buildServer
  : sourceBuildServer;

const root = await mkdtemp(path.join(os.tmpdir(), "weixin image "));
const store = new Store(path.join(root, "db.sqlite"));
const engine = new Engine(store, new CodexAdapter("/usr/bin/false"), new GitService(root), new Verifier("/usr/bin/false", root), root);
const native = new NativeController(engine, "/usr/bin/false", 48974);
const dingtalk = { clientId: "", clientSecret: "", robotCode: "", ownerId: "", ownerMobile: "" };
const channel = new DingTalkChannel(dingtalk, store, async () => "");
const wx = new WeixinChannel(root, store, async () => "", () => true);
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("No network allowed in image verification"); };
let app: Awaited<ReturnType<typeof buildServer>> | undefined;
let checks = 0;
try {
  await native.start();
  wx.credentials = { token: "fixture", accountId: "account", ownerId: "owner", baseUrl: "https://fixture.qq.com" };
  store.setSetting("weixin:context:account:owner", "fixture-context");
  const project = store.create("projects", { name: "fixture", repoPath: root, baseBranch: "main", verifyCommands: [], deliveryMode: "local", runtimeKey: "fixture", githubRepo: "", knowledge: "" } as any);
  const task = store.create("tasks", { projectId: project.id, controllerMode: "native", parentId: null } as any);
  const origin = { channel: "weixin" as const, accountId: "account", senderId: "owner", conversationId: "owner" };
  const source = native.conversations.add("source", "重新给我发图片", "main", origin, "user", [task.id]);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
  const imagePath = path.join(root, "中文 设计 (1).png");
  await writeFile(imagePath, png);
  const result = { ...native.conversations.add("result", "", "executor", origin, "executor", [task.id]), status: "completed" as const, finalText: `![设计](<${imagePath}>)` };
  native.conversations.save(result);
  app = await buildServer(engine, channel, { port: 48974, maxConcurrent: 2, codexBin: "/usr/bin/false", model: undefined, dataDir: root, dingtalk }, undefined, native, wx);
  const call = (name: string, args: unknown, extraHeaders = {}) => app!.inject({ method: "POST", url: "/api/controller/rpc", headers: { host: "localhost:48974", authorization: `Bearer ${native.token}`, ...extraHeaders }, payload: { name, arguments: args } });
  const args = { taskId: task.id, sourceMessageId: source.id, imagePath, operationId: "image-1" };
  const denied = async (label: string, overrides = {}, error = /./, headers = {}) => {
    const before = store.all("outbox").length;
    const response = await call("send_task_image", { ...args, operationId: `denied-${checks}`, ...overrides }, headers);
    assert.notEqual(response.statusCode, 200, label);
    assert.match(response.json().error, error, label);
    assert.equal(store.all("outbox").length, before, `${label}: must not enqueue`);
    checks++;
  };

  // 首先复现含空格、中文、括号的原始链接。旧实现会在此报引用不存在。
  const queued = await call("send_task_image", args);
  assert.equal(queued.statusCode, 200, queued.body);
  const outboxId = queued.json().id;
  assert.equal(queued.json().status, "pending");
  assert.deepEqual(await readFile(store.get("outbox", outboxId).imagePath!), png);
  assert.equal((await call("send_task_image", args)).json().id, outboxId);
  assert.equal(store.all("outbox").length, 1); checks++;
  // 保留原来的普通链接形式，不对空格截断，也不扩展成目录级白名单。
  native.conversations.save({ ...result, finalText: `[原图](${imagePath})` });
  const plain = await call("send_task_image", { ...args, operationId: "plain" });
  assert.equal(plain.statusCode, 200, plain.body); checks++;
  native.conversations.save(result);
  await denied("MCP credential", {}, /主控 MCP/, { authorization: "Bearer wrong" });
  await denied("browser origin", {}, /主控 MCP/, { origin: "http://localhost:48974" });
  await denied("missing source", { sourceMessageId: "missing" }, /渠道消息不存在/);
  await denied("relative path", { imagePath: "设计.png" }, /绝对路径/);
  const unreferenced = path.join(root, "unreferenced.png");
  await writeFile(unreferenced, png);
  await denied("unreferenced existing image", { imagePath: unreferenced }, /未出现在/);
  const alias = path.join(root, "alias.png");
  await symlink(imagePath, alias);
  await denied("unreferenced symlink alias", { imagePath: alias }, /未出现在/);
  for (const patch of [
    { kind: "report" as const }, { taskIds: [] },
    { origin: { ...origin, channel: "dingtalk" as const } },
    { origin: { ...origin, accountId: "other" } },
    { origin: { ...origin, senderId: "other" } },
    { origin: { ...origin, conversationId: "group" } },
  ]) {
    native.conversations.save({ ...source, ...patch });
    await denied(`source ${JSON.stringify(patch)}`, {}, /授权消息/);
  }
  native.conversations.save(source);
  const credentials = wx.credentials; wx.credentials = null;
  await denied("unbound weixin", {}, /授权消息/); wx.credentials = credentials;
  for (const patch of [
    { kind: "report" as const }, { kind: "user" as const },
    { status: "running" as const }, { status: "failed" as const }, { status: "uncertain" as const },
    { taskIds: ["different-task"] },
    { finalText: "", content: result.finalText },
    { finalText: imagePath },
    { finalText: `![前缀](<${imagePath}.other>)` },
    { finalText: `![错误](<${imagePath})` },
    { finalText: `![错误](${imagePath}>)` },
  ]) {
    native.conversations.save({ ...result, ...patch });
    await denied(`result ${JSON.stringify(patch)}`, {}, /未出现在/);
  }
  native.conversations.save(result);
  await denied("operationId bound to other arguments", { operationId: args.operationId, sourceMessageId: native.conversations.add("another", "发送图片", "main", origin, "user", [task.id]).id }, /操作编号已绑定/);
  for (const [label, bytes] of [["not-image", Buffer.from("not an image")], ["too-large", Buffer.concat([png, Buffer.alloc(10 * 1024 * 1024)])]] as const) {
    const invalid = path.join(root, `${label}.png`);
    await writeFile(invalid, bytes);
    native.conversations.save({ ...result, finalText: `![图片](<${invalid}>)` });
    await denied(label, { imagePath: invalid }, /10 MiB/);
  }
  native.conversations.save(result);

  // 可选：真实任务的已完成结果和六张原 PNG 进入隔离队列；真实数据仅只读。
  let replayed = 0;
  if (process.env.WORKBENCH_IMAGE_RESULT) {
    const fixture = JSON.parse(await readFile(process.env.WORKBENCH_IMAGE_RESULT, "utf8")) as { finalText: string; paths: string[] };
    assert.equal(fixture.paths.length, 6);
    native.conversations.save({ ...result, finalText: fixture.finalText });
    for (const file of fixture.paths) {
      const response = await call("send_task_image", { ...args, imagePath: file, operationId: `original-${replayed}` });
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(await readFile(store.get("outbox", response.json().id).imagePath!), await readFile(file));
      replayed++; checks++;
    }
  }

  const pending = store.all("outbox");
  let upload: any, sends = 0, uploads = 0;
  globalThis.fetch = (async (input: any, init: any) => {
    const url = new URL(String(input));
    if (url.hostname === "fixture.qq.com" && url.pathname.endsWith("/getuploadurl")) {
      upload = JSON.parse(init.body); assert.equal(upload.media_type, 1);
      return new Response(JSON.stringify({ upload_param: "fixture" }));
    }
    if (url.hostname === "novac2c.cdn.weixin.qq.com" && url.pathname === "/c2c/upload") {
      const decipher = createDecipheriv("aes-128-ecb", Buffer.from(upload.aeskey, "hex"), null);
      assert.deepEqual(Buffer.concat([decipher.update(Buffer.from(init.body)), decipher.final()]), await readFile(pending[uploads++].imagePath!));
      return new Response("", { headers: { "x-encrypted-param": "download-fixture" } });
    }
    if (url.hostname === "fixture.qq.com" && url.pathname.endsWith("/sendmessage")) {
      const sent = JSON.parse(init.body);
      assert.equal(sent.msg.to_user_id, "owner"); assert.equal(sent.msg.item_list[0].type, 2);
      assert.equal(sent.msg.item_list[0].image_item.media.encrypt_query_param, "download-fixture");
      return new Response(JSON.stringify({ ret: 0, message_id: `fixture-${++sends}` }));
    }
    throw new Error(`Unexpected network request: ${url.origin}${url.pathname}`);
  }) as typeof fetch;
  wx.running = true; await wx.pump(); wx.running = false;
  assert.equal(sends, pending.length); assert.equal(uploads, pending.length);
  for (const item of pending) {
    const delivery = await call("get_image_delivery", { outboxId: item.id });
    assert.equal(delivery.json().status, "sent"); assert.ok(store.get("outbox", item.id).weixinMessageId);
  }
  checks++;
  // 未知回执保留 uncertain；重试同一操作只返回旧队列编号，不再次上传/发送。
  native.conversations.save(result);
  const lostArgs = { ...args, operationId: "lost-receipt" };
  const lost = (await call("send_task_image", lostArgs)).json();
  let lostSends = 0;
  globalThis.fetch = (async (input: any) => {
    const url = String(input);
    if (url.endsWith("/getuploadurl")) return new Response('{"upload_param":"fixture"}');
    if (url.includes("/c2c/upload")) return new Response("", { headers: { "x-encrypted-param": "fixture" } });
    if (url.endsWith("/sendmessage")) { lostSends++; throw new Error("lost receipt"); }
    throw new Error("Unexpected request");
  }) as typeof fetch;
  wx.running = true; await wx.pump(); await wx.pump(); wx.running = false;
  assert.equal((await call("get_image_delivery", { outboxId: lost.id })).json().status, "uncertain");
  assert.equal((await call("send_task_image", lostArgs)).json().id, lost.id);
  assert.equal(lostSends, 1); checks++;
  console.log(JSON.stringify({ passed: checks, replayedOriginalImages: replayed, mockImagesSent: sends, realNetworkRequests: 0 }));
} finally {
  wx.running = false; globalThis.fetch = originalFetch;
  await app?.close(); await native.close(); store.close(); await rm(root, { recursive: true, force: true });
}
