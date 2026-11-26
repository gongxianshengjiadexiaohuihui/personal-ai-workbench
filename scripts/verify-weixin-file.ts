// 完全隔离的微信文件协议与控制接口验证，不连接真实微信。
import assert from "node:assert/strict";
import { createDecipheriv, createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { Engine } from "../src/engine.js";
import { CodexAdapter } from "../src/adapters/codex.js";
import { GitService } from "../src/git.js";
import { Verifier } from "../src/verification.js";
import { NativeController } from "../src/native/controller.js";
import { DingTalkChannel } from "../src/channels/dingtalk.js";
import { WeixinChannel } from "../src/channels/weixin.js";
import { buildServer } from "../src/server.js";

const root = await mkdtemp(path.join(os.tmpdir(), "weixin-file-"));
const store = new Store(path.join(root, "db.sqlite"));
const engine = new Engine(store, new CodexAdapter("/usr/bin/false"), new GitService(root), new Verifier("/usr/bin/false", root), root);
const native = new NativeController(engine, "/usr/bin/false", 48973);
const dingtalk = { clientId: "", clientSecret: "", robotCode: "", ownerId: "", ownerMobile: "" };
const channel = new DingTalkChannel(dingtalk, store, async () => "");
const wx = new WeixinChannel(root, store, async () => "", () => true);
const originalFetch = globalThis.fetch;
let app: Awaited<ReturnType<typeof buildServer>> | undefined;
try {
  await native.start();
  wx.credentials = { token: "fixture", accountId: "account", ownerId: "owner", baseUrl: "https://fixture.qq.com" };
  store.setSetting("weixin:context:account:owner", "fixture-context");
  const project = store.create("projects", { name: "fixture", repoPath: root, baseBranch: "main", verifyCommands: [], deliveryMode: "local", runtimeKey: "fixture", githubRepo: "", knowledge: "" } as any);
  const task = store.create("tasks", { projectId: project.id, controllerMode: "native", parentId: null } as any);
  const origin = { channel: "weixin" as const, accountId: "account", senderId: "owner", conversationId: "owner" };
  const source = native.conversations.add("source", "发送文档", "main", origin, "user", [task.id]);
  const file = path.join(root, "中文 文档.md"), bytes = Buffer.from("# 文档\n内容 🌏\n\0字节", "utf8");
  await writeFile(file, bytes);
  const result = native.conversations.add("result", "", "executor", origin, "executor", [task.id]);
  native.conversations.save({ ...result, status: "completed", finalText: `[文档](<${file}>)` });
  app = await buildServer(engine, channel, { port: 48973, maxConcurrent: 2, codexBin: "/usr/bin/false", model: undefined, dataDir: root, dingtalk }, undefined, native, wx);
  const call = (name: string, args: unknown) => app!.inject({ method: "POST", url: "/api/controller/rpc", headers: { host: "localhost:48973", authorization: `Bearer ${native.token}` }, payload: { name, arguments: args } });
  const args = { taskId: task.id, sourceMessageId: source.id, filePath: file, operationId: "file-1" };
  assert.notEqual((await call("send_task_file", { ...args, sourceMessageId: "missing" })).statusCode, 200);
  assert.notEqual((await call("send_task_file", { ...args, filePath: path.join(root, "unreferenced") })).statusCode, 200);
  const queued = await call("send_task_file", args); assert.equal(queued.statusCode, 200, queued.body);
  const outboxId = queued.json().id;
  assert.equal((await call("send_task_file", args)).json().id, outboxId);
  assert.deepEqual(await readFile(store.get("outbox", outboxId).filePath!), bytes);
  let upload: any, sent: any, uploads = 0;
  globalThis.fetch = (async (input: any, init: any) => {
    const url = String(input);
    if (url.endsWith("/getuploadurl")) { upload = JSON.parse(init.body); return new Response(JSON.stringify({ upload_param: "fixture" })); }
    if (url.includes("/c2c/upload")) {
      uploads++;
      const cipher = Buffer.from(init.body), decipher = createDecipheriv("aes-128-ecb", Buffer.from(upload.aeskey, "hex"), null);
      assert.deepEqual(Buffer.concat([decipher.update(cipher), decipher.final()]), bytes);
      assert.equal(upload.media_type, 3); assert.equal(upload.rawsize, bytes.length); assert.equal(upload.filesize, cipher.length);
      assert.equal(upload.rawfilemd5, createHash("md5").update(bytes).digest("hex"));
      return new Response("", { headers: { "x-encrypted-param": "download-fixture" } });
    }
    if (url.endsWith("/sendmessage")) { sent = JSON.parse(init.body); return new Response(JSON.stringify({ ret: 0, message_id: "123" })); }
    throw new Error(`Unexpected network request: ${url}`);
  }) as typeof fetch;
  wx.running = true; await wx.pump(); wx.running = false;
  assert.equal(uploads, 1); const item = sent.msg.item_list[0];
  assert.equal(item.type, 4); assert.equal(item.file_item.file_name, "中文 文档.md"); assert.equal(item.file_item.len, String(bytes.length));
  assert.equal(item.file_item.media.encrypt_query_param, "download-fixture");
  assert.equal(Buffer.from(item.file_item.media.aes_key, "base64").toString(), upload.aeskey);
  const status = (await call("get_file_delivery", { outboxId })).json();
  assert.equal(status.status, "sent"); assert.deepEqual(status.taskIds, [task.id]); assert.equal(status.fileName, "中文 文档.md");
  assert.equal(store.get("outbox", outboxId).weixinMessageId, "123");
  // 发送回执丢失不能自动重发，避免重复送达。
  const second = await wx.enqueueFile(task.id, "没有扩展名", Buffer.alloc(0));
  let sends = 0;
  globalThis.fetch = (async (input: any, init: any) => {
    const url = String(input);
    if (url.endsWith("/getuploadurl")) return new Response(JSON.stringify({ upload_param: "fixture" }));
    if (url.includes("/c2c/upload")) return new Response("", { headers: { "x-encrypted-param": "fixture" } });
    if (url.endsWith("/sendmessage")) { sends++; throw new Error("lost receipt"); }
    throw new Error("Unexpected request");
  }) as typeof fetch;
  wx.running = true; await wx.pump(); await wx.pump(); wx.running = false;
  assert.equal(sends, 1); assert.equal(store.get("outbox", second.id).status, "uncertain");
  assert.match(store.get("outbox", second.id).error, /回执未知/);
  // 原有图片及文本仍使用各自消息类型，引用无法定位时要求用户指定任务。
  let received = "", messageTypes: number[] = [], mediaType = 0;
  const regression = new WeixinChannel(root, store, async content => { received = content; return "文本回复"; }, () => true);
  regression.credentials = wx.credentials;
  globalThis.fetch = (async (input: any, init: any) => {
    const url = String(input);
    if (url.endsWith("/getuploadurl")) { mediaType = JSON.parse(init.body).media_type; return new Response(JSON.stringify({ upload_param: "fixture" })); }
    if (url.includes("/c2c/upload")) return new Response("", { headers: { "x-encrypted-param": "fixture" } });
    if (url.endsWith("/sendmessage")) { messageTypes.push(JSON.parse(init.body).msg.item_list[0].type); return new Response('{"ret":0}'); }
    throw new Error("Unexpected request");
  }) as typeof fetch;
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  await regression.enqueueImage(task.id, png);
  store.create("inbox", { content: "继续", origin, hasQuote: true, quotedMessageId: "unknown", routing: "native", status: "pending", error: "" });
  regression.running = true; await regression.pump(); regression.running = false;
  assert.match(received, /引用消息无法唯一关联任务，请让用户指定任务，不要猜测/);
  assert.equal(mediaType, 1); assert.deepEqual(messageTypes.sort(), [1, 2]);
  console.log("隔离验证通过：授权与任务结果校验、幂等、原始字节加密往返、中文文件名、文件协议及发送状态");
} finally { globalThis.fetch = originalFetch; await app?.close(); await native.close(); store.close(); await rm(root, { recursive: true, force: true }); }
