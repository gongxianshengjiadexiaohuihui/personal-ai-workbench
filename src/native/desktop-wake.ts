import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Store } from "../store.js";
import { NativeOutbox } from "./outbox.js";
import type { ConversationMessage } from "./conversations.js";

type Rpc = { request(method: string, params: unknown): Promise<any> };
type Open = (appPath: string, threadId: string) => Promise<void>;
type Settings = { enabled: boolean; enabledAt: number; mainEnabledAt?: number };
type Attempt = { messageId: string; threadId: string; submissionId: string; at: number; state: "claimed" | "requested" | "uncertain" | "canceled" | "observed" | "reviewed"; turnId?: string; observedStatus?: ConversationMessage["status"]; error?: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 链接只请求 App 导航，不代表队列已被消费；成功与否均通过原有回合核对确定。
const openDesktop: Open = async (appPath, threadId) => {
  await promisify(execFile)("/usr/bin/open", ["-g", "-a", appPath, `codex://threads/${threadId}`], { env: {}, timeout: 10000 });
};

export class DesktopWake {
  constructor(private store: Store, private box: NativeOutbox, private open: Open = openDesktop) {}
  settings(): Settings { return this.store.setting("native:desktop-wake:settings", { enabled: false, enabledAt: 0 }); }
  configure(enabled: boolean, at = Date.now()) {
    return this.store.transaction(() => {
      const old = this.settings();
      const next = { enabled, enabledAt: enabled && !old.enabled ? at : old.enabledAt,
        mainEnabledAt: enabled && !old.enabled ? at : old.mainEnabledAt };
      this.store.setSetting("native:desktop-wake:settings", next);
      return next;
    });
  }
  initializeMainCutoff(at = Date.now()) {
    // 升级前已启用的项目唤醒不应隐式唤醒历史主控积压；新范围从部署时刻开始。
    return this.store.transaction(() => {
      const old = this.settings();
      if (old.enabled && !old.mainEnabledAt) this.store.setSetting("native:desktop-wake:settings", { ...old, mainEnabledAt: at });
    });
  }
  status() {
    const attempts = this.store.db.prepare("SELECT value FROM settings WHERE id LIKE 'native:desktop-wake:attempt:%' ORDER BY rowid DESC")
      .all().map(r => JSON.parse(String(r.value)) as Attempt);
    const blockedReason = this.store.setting("native:paused", "") ? "主控已暂停" : this.unsafeOperations() ? "存在尚未核对的操作回执" : "";
    return { ...this.settings(), recent: attempts.slice(0, 20), unknownCount: attempts.filter(a => ["claimed", "uncertain"].includes(a.state)).length, blockedReason };
  }
  reconcile(messages: ConversationMessage[]) {
    const byId = new Map(messages.map(m => [m.id, m]));
    this.store.transaction(() => {
      for (const row of this.store.db.prepare("SELECT id,value FROM settings WHERE id LIKE 'native:desktop-wake:attempt:%'").all()) {
        const attempt = JSON.parse(String(row.value)) as Attempt, message = byId.get(attempt.messageId);
        if (!message || !["claimed", "requested", "uncertain"].includes(attempt.state)) continue;
        // 只记录原消息已被哪个回合消费；不能将该事实等同于导航请求成功或业务成功。
        if (message.turnId && ["running", "completed", "failed"].includes(message.status))
          this.store.setSetting(String(row.id), { ...attempt, state: "observed", turnId: message.turnId, observedStatus: message.status });
        else if (message.status === "interrupted_reviewed")
          this.store.setSetting(String(row.id), { ...attempt, state: "reviewed", turnId: message.turnId || undefined, observedStatus: message.status });
      }
    });
  }
  private unsafeOperations() {
    // 操作记录无法可靠关联所有外部副作用；存在未知回执时保守等待人工核对。
    return this.store.db.prepare("SELECT value FROM settings WHERE id LIKE 'native:operation:%'").all()
      .some(r => { try { return ["processing", "uncertain"].includes(JSON.parse(String(r.value)).status); } catch { return true; } });
  }
  async maybeWake(rpc: Rpc, message: ConversationMessage, appPath: string, at = Date.now()): Promise<boolean> {
    const settings = this.settings(), createdAt = Date.parse(message.createdAt);
    if (!settings.enabled || !settings.enabledAt || this.store.setting("native:paused", "") ||
        !["executor", "user", "report"].includes(message.kind) || message.status !== "queued" || message.turnId || !uuid.test(message.threadId) ||
        !["/Applications/ChatGPT.app", "/Applications/Codex.app"].includes(appPath) ||
        !Number.isFinite(createdAt) || createdAt < settings.enabledAt || at - createdAt < 30000 ||
        this.store.setting(`native:desktop-wake:attempt:${message.id}`, null) ||
        at - this.store.setting("native:desktop-wake:last-attempt", 0) < 60000 || this.unsafeOperations()) return false;
    // 主控消息在处理前可能尚未关联任务；只允许绑定的主控会话，项目消息仍要求唯一运行中任务。
    const eligible = (m: ConversationMessage) => {
      if (m.kind === "executor") {
        if (m.taskIds.length !== 1) return false;
        const task = this.store.maybe("tasks", m.taskIds[0]);
        if (!task || task.controllerMode !== "native" || task.controllerSession !== m.threadId || task.status !== "running") return false;
      } else if (!["user", "report"].includes(m.kind) || !settings.mainEnabledAt || createdAt < settings.mainEnabledAt ||
          this.store.setting<any>("native:config", {}).mainThreadId !== m.threadId) return false;
      if (this.store.all("groups").some(g => m.taskIds.includes(g.requestId) && ["running", "verifying"].includes(g.status))) return false;
      if (this.store.all("outbox").some(o => o.taskIds?.some(id => m.taskIds.includes(id)) && ["sending", "uncertain"].includes(o.status))) return false;
      // 同一会话的另一条未决消息可能已有回合或副作用，不能通过导航绕过它。
      return !this.store.db.prepare("SELECT value FROM settings WHERE id LIKE 'native:message:%'").all().some(r => {
        const other = JSON.parse(String(r.value)) as ConversationMessage;
        return other.id !== m.id && other.threadId === m.threadId && ["queued", "running", "uncertain"].includes(other.status);
      });
    };
    if (!eligible(message)) return false;
    let entry: ReturnType<NativeOutbox["get"]>;
    try { entry = this.box.get(message.id); } catch { return false; }
    if (entry.state !== "queued" || !entry.submissionId || entry.threadId !== message.threadId) return false;
    const submissionId = entry.submissionId;

    // 必须确认原队列项尚在且没有对应回合；查询失败或分页未完成一律不唤醒。
    const readPages = async (method: string, params: Record<string, unknown>) => {
      let cursor: string | undefined; const all: any[] = [];
      for (let page = 0; page < 100; page++) {
        const result = await rpc.request(method, { ...params, limit: 100, cursor });
        if (!Array.isArray(result.data)) throw new Error("队列或回合格式不可识别");
        all.push(...result.data);
        if (!result.nextCursor) return all;
        cursor = result.nextCursor;
      }
      throw new Error("队列或回合扫描不完整");
    };
    const queue = await readPages("thread/queue/list", { threadId: message.threadId });
    const matches = queue.filter(x => x.clientUserMessageId === message.id && x.id === submissionId);
    // 导航会唤醒整个会话，而非只启动指定条目；存在其他队列项时不能猜测顺序。
    if (matches.length !== 1 || queue.length !== 1) return false;
    const turns = await readPages("thread/turns/list", { threadId: message.threadId, itemsView: "full" });
    if (!turns.length || turns[0].status !== "completed" || turns.some(t => !Array.isArray(t.items) || t.items.some((i: any) => i.type === "userMessage" && i.clientId === message.id))) return false;
    // 队列与历史不是同一快照；任一结果变化时保留消息，交由后续核对。
    const checkedQueue = await readPages("thread/queue/list", { threadId: message.threadId });
    const checkedTurns = await readPages("thread/turns/list", { threadId: message.threadId, itemsView: "full" });
    const turnFacts = (items: any[]) => items.map(t => ({ id: t.id, status: t.status,
      matching: Array.isArray(t.items) && t.items.some((i: any) => i.type === "userMessage" && i.clientId === message.id) }));
    if (checkedQueue.length !== 1 || checkedQueue[0].id !== submissionId || checkedQueue[0].clientUserMessageId !== message.id ||
        checkedTurns.some(t => !Array.isArray(t.items)) || JSON.stringify(turnFacts(turns)) !== JSON.stringify(turnFacts(checkedTurns))) return false;

    // 导航前原子保存唯一意图；崩溃或系统回执不明时绝不自动再打开同一消息。
    const key = `native:desktop-wake:attempt:${message.id}`;
    const claimed = this.store.transaction(() => {
      const fresh = this.settings();
      const current = this.store.setting<ConversationMessage | null>(`native:message:${message.id}`, null);
      let currentEntry: ReturnType<NativeOutbox["get"]>;
      try { currentEntry = this.box.get(message.id); } catch { return false; }
      if (!fresh.enabled || fresh.enabledAt !== settings.enabledAt || fresh.mainEnabledAt !== settings.mainEnabledAt || this.store.setting("native:paused", "") ||
          this.store.setting(key, null) || at - this.store.setting("native:desktop-wake:last-attempt", 0) < 60000 || this.unsafeOperations() ||
          !current || current.status !== "queued" || current.turnId || current.threadId !== message.threadId || current.kind !== message.kind ||
          JSON.stringify(current.taskIds) !== JSON.stringify(message.taskIds) ||
          currentEntry.state !== "queued" || currentEntry.submissionId !== submissionId ||
          !eligible(current)) return false;
      this.store.setSetting(key, { messageId: message.id, threadId: message.threadId, submissionId, at, state: "claimed" } satisfies Attempt);
      this.store.setSetting("native:desktop-wake:last-attempt", at);
      return true;
    });
    if (!claimed) return false;
    if (!this.settings().enabled || this.store.setting("native:paused", "")) {
      this.store.setSetting(key, { messageId: message.id, threadId: message.threadId, submissionId, at, state: "canceled" } satisfies Attempt);
      return false;
    }
    try {
      await this.open(appPath, message.threadId);
      this.store.setSetting(key, { messageId: message.id, threadId: message.threadId, submissionId, at, state: "requested" } satisfies Attempt);
    } catch {
      this.store.setSetting(key, { messageId: message.id, threadId: message.threadId, submissionId, at, state: "uncertain", error: "打开结果未知，请核对 App 会话和原消息" } satisfies Attempt);
    }
    return true;
  }
}
