import { randomUUID } from "node:crypto";
import { enqueueReply } from "../channels/messages.js";
import type { MessageOrigin } from "../domain.js";
import { Store } from "../store.js";

type Incident = { id: string; kind: string; startedAt: number; lastSeenAt: number; alertedAt?: number; resolvedAt?: number; origin?: MessageOrigin; detail: string };

// 事件及告警意图在同一数据库事务中保存；回执未知由渠道发件箱保留，不能重新发送。
export class NativeMonitor {
  constructor(private store: Store, private origins: () => MessageOrigin[], private threshold = 30_000) {}
  private key(kind: string) { return `native:monitor:active:${kind}`; }
  observe(kind: string, detail: string, at = Date.now()) {
    this.store.transaction(() => {
      let incident = this.store.setting<Incident | null>(this.key(kind), null);
      if (!incident) incident = { id: randomUUID(), kind, startedAt: at, lastSeenAt: at, detail };
      incident.lastSeenAt = at;
      incident.detail = detail;
      if (!incident.alertedAt && at - incident.startedAt >= this.threshold) {
        const origin = this.origins()[0];
        if (origin) {
          enqueueReply(this.store, `native-monitor-${incident.id}-alert`, `工作台监测到${detail}。开始时间：${new Date(incident.startedAt).toISOString()}。待处理消息和操作记录已保留，请在工作台核对。`, origin.senderId, origin);
          incident.alertedAt = at;
          incident.origin = origin;
        }
      }
      this.store.setSetting(this.key(kind), incident);
      this.store.setSetting(`native:monitor:incident:${incident.id}`, incident);
    });
  }
  resolve(kind: string, detail: string, at = Date.now()) {
    this.store.transaction(() => {
      const incident = this.store.setting<Incident | null>(this.key(kind), null);
      if (!incident) return;
      // 只有曾排队告警才排队恢复通知；使用同一接收人和固定编号，重启后仍可去重。
      if (incident.alertedAt && incident.origin) enqueueReply(this.store, `native-monitor-${incident.id}-recovery`, `工作台监测恢复：${detail}。请继续核对积压消息和操作回执。`, incident.origin.senderId, incident.origin);
      incident.resolvedAt = at;
      this.store.setSetting(`native:monitor:incident:${incident.id}`, incident);
      this.store.setSetting(this.key(kind), null);
    });
  }
}
