import type { Task } from "../src/domain";
import type { QueryCategory } from "../src/task-query";

// 列表仅展示摘要；完整原文继续保留在详情中，不更改任务或执行状态。
export function plainSummary(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1（图片）")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[#*`>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
export function filterTasks(
  tasks: Task[],
  views: { id: string; category: QueryCategory }[],
  options: {
    category: QueryCategory | "all";
    project: string;
    search: string;
    oldest: boolean;
    queryReady: boolean;
  },
) {
  const query = options.search.trim().toLocaleLowerCase();
  const categories = new Map(views.map((v) => [v.id, v.category]));
  return tasks
    .filter(
      (t) =>
        (!options.queryReady ||
          options.category === "all" ||
          categories.get(t.id) === options.category) &&
        (!options.project || t.projectId === options.project) &&
        (!query || `${t.title} ${t.id}`.toLocaleLowerCase().includes(query)),
    )
    .sort(
      (a, b) =>
        (options.oldest ? 1 : -1) *
        (a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id)),
    );
}
