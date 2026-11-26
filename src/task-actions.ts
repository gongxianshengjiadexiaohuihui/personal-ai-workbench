import type { Store } from "./store.js";
import { now } from "./domain.js";
import { queryTasks, taskMessages } from "./task-query.js";

// 用户确认只记录对当前最终结果的认可，不冒充交付、合并或内部核对的完成。
export function confirmTask(store: Store, id: string, actor: string) {
  return store.transaction(() => {
    const task = store.get("tasks", id);
    const messages = taskMessages(store).filter(m => m.kind === "executor" && m.taskIds.includes(id));
    const latest = messages.at(-1);
    const view = queryTasks(store, taskMessages(store)).find(t => t.id === id);
    if (view?.category === "completed") return { message: "任务已完成" };
    if (task.parentId || view?.category !== "review" || task.status !== "clarifying" || !latest || latest.status !== "completed" || !latest.finalText || messages.some(m => !["completed", "failed", "interrupted_reviewed"].includes(m.status))) throw new Error("当前不是可确认的项目最终结果；请先核对执行、回执或待批准交付");
    const groups = store.all("groups").filter(g => g.requestId === id);
    if (groups.some(g => ["running", "verifying"].includes(g.status)) || store.all("runs").some(r => (r.taskId === id || groups.some(g => g.id === r.groupId)) && r.status === "running")) throw new Error("仍有执行记录运行中，请先核对");
    store.setSetting(`task:confirmation:${id}`, { taskSnapshot: JSON.stringify(task), messageId: latest.id, finalText: latest.finalText, actor, at: now() });
    return { message: "已记录用户确认，任务显示为已完成" };
  });
}

// 仅唤醒原始待发消息；已入队、已消费或回执不明时绝不构造第二条执行消息。
export function requestResend(store: Store, id: string, wake: () => void) {
  const task = store.get("tasks", id);
  const messages = taskMessages(store).filter(m => m.kind === "executor" && m.taskIds.includes(id));
  const view = queryTasks(store, taskMessages(store)).find(t => t.id === id);
  if (task.parentId || view?.category !== "queued") throw new Error("任务当前不处于待执行状态，请刷新并核对");
  const groups = store.all("groups").filter(g => g.requestId === id);
  if (messages.length !== 1 || messages[0].status !== "pending" || messages[0].turnId || groups.length || store.all("runs").some(r => r.taskId === id || groups.some(g => g.id === r.groupId))) throw new Error("已有派发、执行或回执证据，不能重复发送；请核对原队列和项目会话");
  wake();
  return { message: "已请求处理原待发消息；实际投递和执行以队列及会话状态为准" };
}
