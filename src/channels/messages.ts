import { Store } from "../store.js";
import { now, type MessageOrigin } from "../domain.js";

// 按 UTF-8 字节切分，保留原文和 Unicode 字符；编号预留余量，禁止渠道发送时再截断。
export function splitMessage(text: string): string[] {
  const chunks: string[] = []; let part = "", bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char);
    if (bytes + size > 5800) { chunks.push(part); part = ""; bytes = 0; }
    part += char; bytes += size;
  }
  if (part || !chunks.length) chunks.push(part);
  return chunks.length === 1 ? chunks : chunks.map((s, i) => `[${i + 1}/${chunks.length}]\n${s}`);
}
export function enqueueReply(store: Store, batchId: string, text: string, recipientId?: string, origin?: MessageOrigin): string[] {
  return store.transaction(() => splitMessage(text).map((message, part) => {
    const id = `${batchId}:${part}`;
    const previous = store.maybe("outbox", id);
    if (previous) {
      if (previous.message !== message || previous.recipientId !== recipientId || JSON.stringify(previous.origin) !== JSON.stringify(origin)) throw new Error("回复编号已绑定其他内容或收件人");
    } else store.create("outbox", { message, recipientId, origin, batchId, part, status: "pending", attempts: 0, nextAt: now(), error: "" }, id);
    return id;
  }));
}
