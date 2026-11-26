import assert from "node:assert/strict";
import { createCipheriv, createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { WeixinChannel } from "../src/channels/weixin.js";
import { DingTalkChannel } from "../src/channels/dingtalk.js";
import { Conversations } from "../src/native/conversations.js";

const dir = await mkdtemp(path.join(os.tmpdir(), "inbound-media-"));
const store = new Store(path.join(dir, "db.sqlite"));
const originalFetch = globalThis.fetch;
try {
  const key = Buffer.alloc(16, 42), plain = Buffer.from("中文文件\0内容"), png = Buffer.from([137,80,78,71,13,10,26,10,1,2]);
  const encrypt = (data: Buffer) => { const c = createCipheriv("aes-128-ecb", key, null); return Buffer.concat([c.update(data), c.final()]); };
  let callback: any, calls = 0, received = "";
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    if (url.includes("/oauth2/accessToken")) return Response.json({ accessToken: "token", expireIn: 7200 });
    if (url.includes("/messageFiles/download")) { assert.equal(JSON.parse(init.body).robotCode, "robot"); return Response.json({ downloadUrl: "https://fixture.aliyuncs.com/file" }); }
    if (url.includes("fixture.aliyuncs.com")) { calls++; return new Response(new Uint8Array(plain)); }
    if (url.includes("novac2c.cdn.weixin.qq.com")) { calls++; return new Response(new Uint8Array(url.includes("picture") ? encrypt(png) : encrypt(plain))); }
    throw new Error("unexpected network");
  }) as typeof fetch;
  const client: any = { connected: true, connect: async () => {}, disconnect: () => {}, on: () => {}, registerCallbackListener: (_: any, fn: any) => callback = fn, socketCallBackResponse: () => {} };
  const dd = new DingTalkChannel({ clientId: "app", clientSecret: "secret", robotCode: "robot", ownerId: "owner", ownerMobile: "" }, store, async text => { received = text; return "ok"; }, () => client, () => true);
  await dd.start();
  const send = (body: any) => callback({ data: JSON.stringify(body), headers: { messageId: body.msgId } });
  send({ senderStaffId: "other", conversationType: "1", msgtype: "file", msgId: "unauthorized", content: { downloadCode: "code" } });
  send({ senderStaffId: "owner", conversationType: "2", msgtype: "file", msgId: "group", content: { downloadCode: "code" } });
  assert.equal(store.all("inbox").length, 0);
  send({ senderStaffId: "owner", conversationType: "1", conversationId: "chat", msgtype: "file", msgId: "valid", content: { downloadCode: "code", fileName: "中文.txt" } });
  await new Promise(r => setTimeout(r, 50)); await dd.pump();
  const ddItem = store.all("inbox")[0]; assert.equal(ddItem.status, "processed");
  assert.equal(ddItem.attachments![0].name, "中文.txt"); assert.deepEqual(await readFile(ddItem.attachments![0].path), plain);
  assert.match(received, /中文.txt/); assert.equal(ddItem.mediaItems!.length, 0);
  send({ senderStaffId: "owner", conversationType: "1", msgtype: "picture", msgId: "image", content: { downloadCode: "code" } });
  await new Promise(r => setTimeout(r, 50)); await dd.pump();
  assert.equal(store.all("inbox").find(x => x.attachments?.[0]?.kind === "image")?.status, "processed");
  await dd.stop();
  const origin = { channel: "weixin" as const, accountId: "account", senderId: "owner", conversationId: "owner" };
  const wx = new WeixinChannel(dir, store, async text => { received = text; return "ok"; }, () => true);
  wx.credentials = { token: "x", accountId: "account", ownerId: "owner", baseUrl: "https://x.qq.com" };
  const abort = new AbortController();
  wx.request = async () => { abort.abort(); return { msgs: [
    { from_user_id: "stranger", message_type: 1, message_id: "no", item_list: [{ type: 2, image_item: {} }] },
    ...Array.from({ length: 2 }, () => ({ from_user_id: "owner", message_type: 1, message_id: "yes", item_list: [{ type: 4, file_item: { file_name: "轮询.txt", media: { encrypt_query_param: "file", aes_key: key.toString("base64") } } }] }))
  ], get_updates_buf: "next" }; };
  await wx.poll(abort.signal);
  const polled = store.all("inbox").find(x => x.mediaItems?.[0]?.name === "轮询.txt");
  assert.ok(polled); assert.equal(store.setting("weixin:cursor:account", ""), "next");
  assert.equal(store.all("inbox").filter(x => x.origin?.channel === "weixin").length, 1);
  wx.running = true; await wx.pump(); wx.running = false;
  assert.equal(store.get("inbox", polled.id).status, "processed");
  const m = store.create("inbox", { origin, content: "请查看", routing: "native", status: "pending", error: "", hasQuote: true, mediaItems: [
    { kind: "image", media: { encrypt_query_param: "picture", aes_key: key.toString("base64") } },
    { kind: "file", name: "文件.md", media: { encrypt_query_param: "file", aes_key: Buffer.from(key.toString("hex")).toString("base64") }, length: String(plain.length), md5: createHash("md5").update(plain).digest("hex") }
  ] });
  wx.running = true; await wx.pump(); wx.running = false;
  const saved = store.get("inbox", m.id); assert.equal(saved.status, "processed");
  assert.deepEqual(await readFile(saved.attachments![0].path), png); assert.deepEqual(await readFile(saved.attachments![1].path), plain);
  assert.equal(saved.attachments![1].name, "文件.md"); assert.match(received, /引用消息无法唯一关联任务/);
  const conversations = new Conversations(store, {} as any);
  const user = conversations.add(m.id, received, "main", origin);
  conversations.attach(user.id, "T-example"); assert.match(conversations.get(user.id).content, /文件.md/); assert.deepEqual(conversations.get(user.id).taskIds, ["T-example"]);
  const bad = store.create("inbox", { origin, content: "", routing: "native", status: "pending", error: "", mediaItems: [{ kind: "file", media: { full_url: "https://evil.example/file", aes_key: key.toString("base64") } }] });
  const before = calls; wx.running = true; await wx.pump(); wx.running = false;
  assert.equal(store.get("inbox", bad.id).status, "failed"); assert.equal(calls, before);
  const corrupt = store.create("inbox", { origin, content: "", routing: "native", status: "pending", error: "", mediaItems: [{ kind: "file", media: { encrypt_query_param: "file", aes_key: key.toString("base64") }, length: "1" }] });
  wx.running = true; await wx.pump(); wx.running = false;
  assert.equal(store.get("inbox", corrupt.id).status, "failed"); assert.match(store.get("inbox", corrupt.id).error, /长度校验失败/);
  console.log("入站附件模拟验证通过：渠道权限、钉钉文件、微信图片及文件解密、名称和字节、引用、消息与任务关联、拒绝不可信地址");
} finally { globalThis.fetch = originalFetch; store.close(); await rm(dir, { recursive: true, force: true }); }
