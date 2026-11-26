import { Store } from "../store.js";
import type { ConversationMessage } from "./conversations.js";

type Evidence = {
  messageId: string; threadId: string; turnId: string | null; taskIds: string[];
  status: ConversationMessage["status"]; delivery: string; observedAt: string;
};
type Investigation = {
  messageId: string; firstSeenAt: string; lastSeenAt: string;
  state: "needs_review" | "resolved"; latest: Evidence; history: Evidence[];
};

// 这是排查依据，不是回合终止或操作失败的证明；未知结果不得触发重放。
export class RepairEvidence {
  constructor(private store: Store, private delivery: (id: string) => string) {}
  observe(messages: ConversationMessage[], at = Date.now(), waitMs = 300_000) {
    this.store.transaction(() => {
      for (const message of messages) {
        const key = `native:investigation:${message.id}`;
        const previous = this.store.setting<Investigation | null>(key, null);
        const oldEnough = Number.isFinite(Date.parse(message.createdAt)) && at - Date.parse(message.createdAt) >= waitMs;
        const suspect = message.status === "uncertain" || (["pending", "queued"].includes(message.status) && oldEnough);
        if (!previous && !suspect) continue;
        const observedAt = new Date(at).toISOString();
        const evidence: Evidence = { messageId: message.id, threadId: message.threadId, turnId: message.turnId,
          taskIds: [...message.taskIds], status: message.status, delivery: this.delivery(message.id), observedAt };
        // 回合恢复运行不代表原故障已解决；仅由既有对话流程确认的终态结束排查。
        const terminal = ["completed", "interrupted_reviewed"].includes(message.status);
        const { observedAt: _previousTime, ...previousFacts } = previous?.latest || evidence;
        const { observedAt: _currentTime, ...currentFacts } = evidence;
        const history = previous?.history || (previous ? [previous.latest] : []);
        if (!history.length || JSON.stringify(previousFacts) !== JSON.stringify(currentFacts)) history.push(evidence);
        const record: Investigation = { messageId: message.id, firstSeenAt: previous?.firstSeenAt || observedAt,
          lastSeenAt: observedAt, state: terminal ? "resolved" : "needs_review", latest: evidence, history };
        this.store.setSetting(key, record);
      }
    });
  }
  active() {
    return this.store.db.prepare("SELECT value FROM settings WHERE id LIKE 'native:investigation:%' ORDER BY rowid DESC")
      .all().map(r => JSON.parse(String(r.value)) as Investigation).filter(i => i.state === "needs_review");
  }
}
