import { createHash } from "node:crypto";
import { DWClient, TOPIC_ROBOT, type RobotTextMessage } from "dingtalk-stream";
import type { Config } from "../config.js";
import { Store } from "../store.js";
import { now, type MessageOrigin } from "../domain.js";
import { enqueueReply, splitMessage } from "./messages.js";
import path from "node:path";
import { describeAttachments, receiveMedia } from "./inbound-media.js";
class UncertainSend extends Error {}
export interface ChannelAdapter {
  id: string;
  send(message: string): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}
type StreamClient = Pick<
  DWClient,
  | "connected"
  | "connect"
  | "disconnect"
  | "registerCallbackListener"
  | "socketCallBackResponse"
  | "on"
>;
export class DingTalkChannel implements ChannelAdapter {
  id = "dingtalk";
  client: StreamClient | null = null;
  connecting = false;
  error = "";
  connectionError = "";
  token = "";
  expires = 0;
  busy = false;
  stopped = false;
  timer: NodeJS.Timeout | null = null;
  constructor(
    public config: Config["dingtalk"],
    public store: Store,
    public handle: (content: string, messageId: string, metadata?: { origin?: MessageOrigin; routing: "legacy" | "native" }) => Promise<string>,
    private createClient: (config: Config["dingtalk"]) => StreamClient = (
      config,
    ) =>
      new DWClient({
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        keepAlive: true,
        debug: false,
      }),
    private nativeEnabled: () => boolean = () => false,
  ) {}
  get configured() {
    return [
      this.config.clientId,
      this.config.clientSecret,
      this.config.robotCode,
      this.config.ownerId,
    ].every(Boolean);
  }
  status() {
    return {
      configured: this.configured,
      connected: !!this.client?.connected,
      connecting: this.connecting,
      clientId: this.config.clientId,
      robotCode: this.config.robotCode,
      ownerId: this.config.ownerId,
      ownerMobile: this.config.ownerMobile || "",
      secretConfigured: !!this.config.clientSecret,
      error: this.error || (this.client?.connected ? "" : this.connectionError),
      pending: this.store.all("outbox").filter((x) => x.status === "pending" && (!x.origin || x.origin.channel === "dingtalk")).length,
      uncertain: this.store.all("outbox").filter((x) => x.status === "uncertain" && (!x.origin || x.origin.channel === "dingtalk")),
    };
  }
  async start() {
    if (!this.configured || this.client) return;
    this.stopped = false;
    for (const item of this.store.all("outbox").filter(x => x.status === "sending" && (!x.origin || x.origin.channel === "dingtalk")))
      this.store.patch("outbox", item.id, { status: "uncertain", error: "服务中断时发送结果未知，未自动重发" });
    this.connecting = true;
    this.timer = setInterval(() => void this.pump(), 3000);
    const client = this.createClient(this.config);
    this.client = client;
    client.registerCallbackListener(TOPIC_ROBOT, (message) => {
      if (this.stopped || this.client !== client) return;
      try {
        const body = JSON.parse(message.data) as RobotTextMessage & { content?: { downloadCode?: string; fileName?: string }; msgtype: string };
        if (
          body.senderStaffId === this.config.ownerId &&
          ["text", "picture", "file"].includes(body.msgtype) && body.conversationType === "1"
        ) {
          const id =
            "DD-" +
            createHash("sha256")
              .update(body.msgId || message.headers.messageId)
              .digest("hex");
          // 先持久化再 ACK。连接重投同一消息时保留原记录，不重新执行指令。
          if (!this.store.maybe("inbox", id))
            this.store.create(
              "inbox",
              {
                content: body.msgtype === "text" ? body.text?.content || "" : "",
                ...(body.msgtype !== "text" ? { mediaItems: [{ kind: body.msgtype === "picture" ? "image" as const : "file" as const, name: body.content?.fileName, downloadCode: body.content?.downloadCode }] } : {}),
                origin: { channel: "dingtalk", accountId: this.config.clientId, senderId: body.senderStaffId, conversationId: body.conversationId || body.senderStaffId },
                routing: this.nativeEnabled() ? "native" : "legacy",
                status: "pending",
                error: "",
              },
              id,
            );
        }
        client.socketCallBackResponse(message.headers.messageId, {
          status: "SUCCESS",
          message: "已接收",
        });
        void this.pump();
      } catch {
        this.error = "钉钉消息格式或持久化失败";
      }
    });
    client.on("error", () => {
      if (this.client !== client) return;
      this.connectionError = "钉钉连接错误，请检查网络和应用配置";
    });
    try {
      await client.connect();
      if (this.client !== client || this.stopped) {
        client.disconnect();
        return;
      }
      this.connectionError = client.connected
        ? ""
        : "尚未连接，请检查应用凭据、网络及 Stream 配置；连接器会重试。";
    } catch {
      if (this.client === client)
        this.connectionError = "钉钉连接失败，请检查应用凭据和 Stream 配置";
    } finally {
      if (this.client === client) this.connecting = false;
    }
  }
  async configure(config: Config["dingtalk"]) {
    await this.stop();
    this.config = config;
    this.token = "";
    this.expires = 0;
    this.error = "";
    this.connectionError = "";
    void this.start().catch(() => {
      this.connectionError = "钉钉连接初始化失败，请检查配置后重新保存";
      this.connecting = false;
    });
  }
  async accessToken() {
    if (this.token && Date.now() < this.expires) return this.token;
    const r = await fetch("https://api.dingtalk.com/v1.0/oauth2/accessToken", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        appKey: this.config.clientId,
        appSecret: this.config.clientSecret,
      }),
      signal: AbortSignal.timeout(15000),
    });
    const body: any = await r.json();
    if (!r.ok || !body.accessToken)
      throw new Error("钉钉获取 access token 失败，请检查应用配置");
    this.token = body.accessToken;
    this.expires = Date.now() + Math.max(0, Number(body.expireIn) - 120) * 1000;
    return this.token;
  }
  async downloadUrl(downloadCode: string) {
    const token = await this.accessToken();
    const response = await fetch("https://api.dingtalk.com/v1.0/robot/messageFiles/download", { method: "POST", headers: { "content-type": "application/json", "x-acs-dingtalk-access-token": token }, body: JSON.stringify({ downloadCode, robotCode: this.config.robotCode }), signal: AbortSignal.timeout(15000) });
    const body: any = await response.json();
    if (!response.ok || typeof body.downloadUrl !== "string") throw new Error(`钉钉附件下载授权失败 (${response.status})，请检查机器人权限或下载码有效期`);
    return body.downloadUrl;
  }
  async send(message: string, recipientId = this.config.ownerId) {
    if (recipientId !== this.config.ownerId) throw new Error("消息收件人与当前绑定用户不同，未发送");
    if (Buffer.byteLength(message) > 6000) throw new Error("消息尚未分段，未截断发送");
    const token = await this.accessToken();
    let r: Response, body: any;
    try {
    r = await fetch(
      "https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-acs-dingtalk-access-token": token,
        },
        body: JSON.stringify({
          robotCode: this.config.robotCode,
          userIds: [recipientId],
          msgKey: "sampleText",
          msgParam: JSON.stringify({ content: message }),
        }),
        signal: AbortSignal.timeout(15000),
      },
    );
    body = await r.json();
    } catch { throw new UncertainSend("钉钉发送回执未知，未自动重发，请核对实际消息"); }
    if (
      !r.ok ||
      body.invalidStaffIdList?.length ||
      body.flowControlledStaffIdList?.length
    )
      throw new Error(
        `钉钉发送失败 (${r.status})，请检查接收人、机器人权限及应用可见范围`,
      );
  }
  async pump() {
    if (this.busy || this.stopped || !this.configured) return;
    this.busy = true;
    try {
      for (const item of this.store
        .all("inbox")
        .filter((x) => x.status === "pending" && (!x.origin || x.origin.channel === "dingtalk"))) {
        try {
          if (item.origin && (item.origin.senderId !== this.config.ownerId || (item.origin.accountId && item.origin.accountId !== this.config.clientId))) throw new Error("入站消息不属于当前绑定账号或用户");
          const attachments = item.attachments ?? await receiveMedia(item, path.dirname(this.store.file), code => this.downloadUrl(code));
          if (item.mediaItems?.length && !item.attachments) this.store.patch("inbox", item.id, { attachments, mediaItems: [] });
          const reply = await this.handle(item.content + describeAttachments(attachments), item.id, { origin: item.origin, routing: item.routing ?? "legacy" });
          this.store.transaction(() => {
            enqueueReply(this.store, `reply-${item.id}`, reply, item.origin?.senderId, item.origin);
            this.store.patch("inbox", item.id, { status: "processed" });
          });
        } catch (e) {
          const error = e instanceof Error ? e.message : String(e);
          this.store.transaction(() => {
            this.store.patch("inbox", item.id, { status: "failed", error });
            this.store.create("outbox", {
              message: `指令处理失败：${error}`,
              origin: item.origin,
              recipientId: item.origin?.senderId,
              status: "pending",
              attempts: 0,
              nextAt: now(),
              error: "",
            });
          });
        }
      }
      for (const item of this.store
        .all("outbox")
        .filter((x) => x.status === "pending" && x.nextAt <= now() && (!x.origin || x.origin.channel === "dingtalk"))
        .slice(0, 10)) {
        if (item.batchId && this.store.all("outbox").some(x => x.batchId === item.batchId && (x.part ?? 0) < (item.part ?? 0) && x.status !== "sent")) continue;
        // 旧模板通知也在发送前分段；将原记录作为已展开容器，避免升级时丢弃历史消息。
        if (!item.batchId && splitMessage(item.message).length > 1) {
          this.store.transaction(() => { enqueueReply(this.store, `split-${item.id}`, item.message, item.recipientId, item.origin); this.store.patch("outbox", item.id, { status: "sent" }); });
          continue;
        }
        try {
          this.store.patch("outbox", item.id, { status: "sending" });
          await this.send(item.message, item.recipientId);
          this.store.patch("outbox", item.id, { status: "sent", error: "" });
          this.error = "";
        } catch (e) {
          const error = e instanceof Error ? e.message : String(e);
          this.error = error;
          this.store.patch("outbox", item.id, {
            status: e instanceof UncertainSend ? "uncertain" : "pending",
            attempts: item.attempts + 1,
            error,
            nextAt: new Date(
              Date.now() +
                Math.min(300000, 5000 * 2 ** Math.min(item.attempts, 6)),
            ).toISOString(),
          });
          break;
        }
      }
    } finally {
      this.busy = false;
    }
  }
  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.client?.disconnect();
    this.client = null;
    this.connecting = false;
    while (this.busy) await new Promise((r) => setTimeout(r, 100));
  }
}
