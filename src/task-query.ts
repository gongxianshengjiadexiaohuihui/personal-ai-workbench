import type { Store } from "./store.js";
import { labels } from "./domain.js";
import type { ConversationMessage } from "./native/conversations.js";

export type QueryCategory = "running" | "user" | "review" | "queued" | "completed" | "other";
export const categoryLabels: Record<QueryCategory, string> = { running: "运行", user: "待用户处理", review: "待核对", queued: "待执行", completed: "完成", other: "其他" };
export function taskMessages(store: Store): ConversationMessage[] {
  return store.db.prepare("SELECT value FROM settings WHERE id LIKE 'native:message:%' ORDER BY rowid").all().map(r => JSON.parse(String(r.value)));
}

// 根任务是唯一计数单位；回合证据只能描述最后观察到的状态，不推断桌面会话当前仍在运行。
export function queryTasks(store: Store, messages: ConversationMessage[]) {
  const groups = store.all("groups"), runs = store.all("runs"), deliveries = store.all("deliveries"), events = store.all("events");
  return store.all("tasks").filter(t => !t.parentId).reverse().map(t => {
    const relevant = messages.filter(m => m.kind === "executor" && m.taskIds.includes(t.id));
    const latest = relevant.at(-1);
    const pendingDelivery = deliveries.some(d => d.requestId === t.id && d.status === "pending");
    let category: QueryCategory, stage: string, action = t.question || "";
    const confirmation = store.setting<{ taskSnapshot: string; messageId: string; finalText: string } | null>(`task:confirmation:${t.id}`, null);
    const taskGroups = groups.filter(g => g.requestId === t.id);
    const active = taskGroups.some(g => ["running", "verifying"].includes(g.status)) || runs.some(r => (r.taskId === t.id || taskGroups.some(g => g.id === r.groupId)) && r.status === "running");
    if (t.status === "delivered") { category = "completed"; stage = "已交付"; }
    else if (t.status === "cancelled") { category = "other"; stage = "已取消"; }
    else if (pendingDelivery || t.status === "awaiting_approval") { category = "user"; stage = "等待用户确认交付"; action ||= "请核对交付并决定是否确认"; }
    else if (confirmation && !active && relevant.every(m => ["completed", "failed", "interrupted_reviewed"].includes(m.status)) && confirmation.taskSnapshot === JSON.stringify(t) && latest?.id === confirmation.messageId && latest.status === "completed" && latest.finalText === confirmation.finalText) { category = "completed"; stage = "用户已确认完成"; action = ""; }
    else if (t.controllerMode === "native" && latest && ["uncertain", "failed", "interrupted_reviewed"].includes(latest.status)) { category = "review"; stage = "项目消息或回合待核对"; action ||= latest.error || "核对消息及回合结果"; }
    else if (t.controllerMode === "native" && latest && ["pending", "queued"].includes(latest.status)) { category = "queued"; stage = latest.status === "pending" ? "项目消息等待派发；实际执行未知" : "项目消息已入队，未观察到消费；实际执行未知"; action ||= "等待消费或核对派发状态"; }
    else if (t.controllerMode === "native" && latest?.status === "running" && latest.error?.includes("回合已结束")) { category = "review"; stage = "项目回合已结束，等待最终答复落盘"; action ||= "核对回合最终答复"; }
    else if (t.controllerMode === "native" && latest?.status === "running") { category = "running"; stage = "已观察到项目回合运行，当前执行情况需以会话为准"; }
    else if (t.status === "blocked") { category = "review"; stage = "任务受阻，待核对"; action ||= "核对阻塞原因"; }
    else if (t.status === "clarifying") {
      const userQuestion = t.controllerMode !== "native" && !!t.question;
      category = userQuestion ? "user" : "review"; stage = userQuestion ? "等待用户补充" : "主控整理或核对中";
      action ||= "等待主控整理或核对";
    } else if (t.status === "queued") { category = "queued"; stage = "任务待执行"; }
    else if (t.controllerMode === "native" && t.status === "running") { category = "review"; stage = "记录为运行，实际执行未知"; action ||= "核对项目会话及派发状态"; }
    else if (["running", "verifying"].includes(t.status)) {
      const active = runs.some(r => r.taskId === t.id && r.status === "running") || groups.some(g => g.requestId === t.id && ["running", "verifying"].includes(g.status));
      category = active ? "running" : "review"; stage = active ? `记录显示${labels[t.status]}，当前情况需核对` : `记录为${labels[t.status]}，实际执行未知`;
      if (!active) action ||= "核对执行记录";
    } else { category = "other"; stage = labels[t.status]; }
    const event = events.filter(e => e.taskId === t.id).at(-1);
    return { id: t.id, title: t.title, projectId: t.projectId, category, stage, action, summary: t.summary, recordStatus: t.status, messageStatus: latest?.status ?? null, sessionId: t.controllerSession, latestEvent: event ? { type: event.type, message: event.message, createdAt: event.createdAt } : null, updatedAt: t.updatedAt };
  });
}

export function taskQueryCommand(text: string, store: Store, messages: ConversationMessage[]): string | null {
  const input = text.trim();
  const list = input.match(/^(?:任务|查询任务|查看任务)(?:\s+(运行|待用户处理|待核对|待执行|完成|全部))?$/);
  const detail = input.match(/^(?:查看|任务详情|查询任务)\s+(T-[\w-]+)$/i);
  if (!list && !detail) return null;
  const tasks = queryTasks(store, messages);
  const format = (t: typeof tasks[number]) => `${t.id} ${t.title}\n阶段：${t.stage}\n待处理：${t.action || "无已记录事项"}\n摘要：${t.summary || "无"}${t.category === "review" ? `\n操作：确认完成 ${t.id}（需有可核对的项目最终结果）` : t.category === "queued" ? `\n操作：重发 ${t.id}（仅处理安全的原待发消息）` : ""}`;
  if (detail) { const t = tasks.find(x => x.id.toLowerCase() === detail[1].toLowerCase()); return t ? format(t) : "未找到该根任务，请核对任务编号。"; }
  const category = Object.entries(categoryLabels).find(([, label]) => label === list![1])?.[0];
  const filtered = category ? tasks.filter(t => t.category === category) : tasks;
  return `${list![1] || "全部"}任务：${filtered.length} 个\n${filtered.map(format).join("\n\n") || "无"}`;
}
