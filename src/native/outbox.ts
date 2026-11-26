import { DatabaseSync } from "node:sqlite";

type Client = { request(method: string, params: unknown): Promise<any> };
type DeliveryState = "pending" | "sending" | "queued" | "consumed" | "uncertain";
type Entry = { id: string; threadId: string; text: string; state: DeliveryState; submissionId: string | null };

// 持久发件箱：发送意图必须先落盘。原生 clientUserMessageId 不是去重键。
export class NativeOutbox {
  readonly db: DatabaseSync;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, threadId TEXT NOT NULL, text TEXT NOT NULL,
        state TEXT NOT NULL, submissionId TEXT
      );`);
  }

  add(id: string, threadId: string, text: string) {
    this.db.prepare("INSERT OR IGNORE INTO events VALUES(?,?,?,'pending',NULL)").run(id, threadId, text);
    const entry = this.get(id);
    if (entry.threadId !== threadId || entry.text !== text)
      throw new Error("Event ID already binds different content");
    return entry;
  }

  get(id: string): Entry {
    const entry = this.db.prepare("SELECT * FROM events WHERE id=?").get(id);
    if (!entry) throw new Error("Unknown event");
    return entry as unknown as Entry;
  }

  private mark(id: string, state: DeliveryState, submissionId: string | null = null) {
    // 其他并发核对可能已经看到更晚的事实，旧回执不能把 consumed/queued 回退为不确定。
    const guard = state === "uncertain" ? "state='sending'" : "state!='consumed'";
    this.db.prepare(`UPDATE events SET state=?,submissionId=? WHERE id=? AND ${guard}`).run(state, submissionId, id);
    return this.get(id);
  }

  async deliver(client: Client, id: string, allowSend = true): Promise<Entry> {
    const event = this.get(id);
    if (event.state === "consumed") return event;
    // 先查待发队列，再查已消费的用户消息。分页不可用时宁可报错，不把查询失败当作不存在。
    let cursor: string | undefined;
    let complete = false;
    for (let page = 0; page < 100; page++) {
      const result = await client.request("thread/queue/list", { threadId: event.threadId, limit: 100, cursor });
      const found = result.data.find((item: any) => item.clientUserMessageId === id);
      if (found) return this.mark(id, "queued", found.id);
      if (!result.nextCursor) { complete = true; break; }
      cursor = result.nextCursor;
    }
    if (!complete) throw new Error("Queue scan incomplete; no event sent");
    cursor = undefined;
    complete = false;
    for (let page = 0; page < 100; page++) {
      const result = await client.request("thread/items/list", {
        threadId: event.threadId, limit: 100, sortDirection: "desc", cursor,
      });
      if (result.data.some(({ item }: any) => item.type === "userMessage" && item.clientId === id))
        return this.mark(id, "consumed");
      if (!result.nextCursor) { complete = true; break; }
      cursor = result.nextCursor;
    }
    if (!complete) throw new Error("History scan incomplete; no event sent");
    // 发出前先持久化发送意图。连接中断后缺少回执时保持 uncertain，禁止盲目重发。
    if (!allowSend) return this.get(id);
    const claim = this.db.prepare("UPDATE events SET state='sending' WHERE id=? AND state='pending'").run(id);
    if (!claim.changes) return this.get(id);
    try {
      const result = await client.request("thread/queue/add", {
        threadId: event.threadId, clientUserMessageId: id,
        input: [{ type: "text", text: event.text }],
      });
      return this.mark(id, "queued", result.queuedSubmission.id);
    } catch {
      return this.mark(id, "uncertain");
    }
  }

  close() { if (this.db.isOpen) this.db.close(); }
}
