import assert from "node:assert/strict";
import { filterTasks, plainSummary } from "../web/presentation.js";
import type { Task } from "../src/domain.js";

const makeTask = (
  id: string,
  title: string,
  projectId: string,
  updatedAt: string,
): Task => ({
  id,
  title,
  projectId,
  updatedAt,
  createdAt: updatedAt,
  parentId: null,
  groupId: null,
  goal: "",
  criteria: [],
  status: "queued",
  question: "",
  summary: "",
  controllerSession: null,
  source: "web",
  interventions: 0,
});
const tasks = [
  makeTask("T-a", "图片接收", "p1", "2026-11-25T00:00:00Z"),
  makeTask("T-c", "界面调整", "p2", "2026-11-26T00:00:00Z"),
  makeTask("T-b", "文件接收", "p1", "2026-11-26T00:00:00Z"),
];
const original = JSON.stringify(tasks);
const views = [
  { id: "T-a", category: "review" as const },
  { id: "T-b", category: "completed" as const },
];
const defaults = {
  category: "all" as const,
  project: "",
  search: "",
  oldest: false,
  queryReady: true,
};
const ids = (options = {}) =>
  filterTasks(tasks, views, { ...defaults, ...options }).map((t) => t.id);
assert.deepEqual(ids(), ["T-c", "T-b", "T-a"]);
assert.deepEqual(ids({ oldest: true }), ["T-a", "T-b", "T-c"]);
assert.deepEqual(ids({ category: "review" }), ["T-a"]);
assert.deepEqual(ids({ category: "review", queryReady: false }), [
  "T-c",
  "T-b",
  "T-a",
]);
assert.deepEqual(ids({ project: "p1" }), ["T-b", "T-a"]);
assert.deepEqual(ids({ project: "p1", search: "  T-A  " }), ["T-a"]);
assert.deepEqual(ids({ search: "不存在" }), []);
assert.equal(JSON.stringify(tasks), original, "筛选不能改变源任务与顺序");
assert.equal(
  plainSummary("## **结果**\n![截图](/private/shot.png) [文档](/tmp/doc.md)"),
  "结果 截图（图片） 文档",
);
assert.equal(plainSummary(""), "");
console.log("UI presentation: 10 assertions passed");
