import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  Task,
  Project,
  Group,
  Run,
  Evidence,
  Delivery,
  WorkEvent,
  Skill,
} from "../src/domain";
import { CodexImport, ProjectForm } from "./projects";
import { labels, repositoriesOf, projectIssues } from "../src/domain";
import "./style.css";
import { Icon, Modal } from "./ui";
import { filterTasks, plainSummary } from "./presentation";
import { NativeControllerPanel } from "./native";
import { categoryLabels, type QueryCategory } from "../src/task-query";

type TaskView = {
  id: string;
  category: QueryCategory;
  stage: string;
  action: string;
};

let token = "";
async function api<T = any>(
  url: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
): Promise<T> {
  if (method !== "GET" && !token)
    token = (await fetch("/api/session").then((r) => r.json())).token;
  const r = await fetch(url, {
    method,
    headers: {
      "content-type": "application/json",
      ...(method === "GET" ? {} : { "x-workbench-token": token }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "请求失败");
  return data;
}
type Detail = {
  task: Task;
  groups: Group[];
  subtasks: Task[];
  runs: Run[];
  evidence: Evidence[];
  deliveries: Delivery[];
  events: WorkEvent[];
};
const date = (s: string) =>
  new Date(s).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
function Badge({ status }: { status: Task["status"] }) {
  return (
    <span className={`badge ${status}`}>
      <i />
      {labels[status]}
    </span>
  );
}
function App() {
  const [page, setPage] = useState("overview"),
    [tasks, setTasks] = useState<Task[]>([]),
    [taskViews, setTaskViews] = useState<TaskView[]>([]),
    [queryReady, setQueryReady] = useState(false),
    [projects, setProjects] = useState<Project[]>([]),
    [settings, setSettings] = useState<any>(null),
    [metrics, setMetrics] = useState<any>({}),
    [skills, setSkills] = useState<Skill[]>([]);
  const [settingsTab, setSettingsTab] = useState<
    "execution" | "channels" | "runtime"
  >("execution");
  const [selected, setSelected] = useState<string | null>(null),
    [detail, setDetail] = useState<Detail | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [pending, setPending] = useState(false),
    [dialog, setDialog] = useState<
      "task" | "project" | "skill" | "import" | null
    >(null),
    [editProject, setEditProject] = useState<Project | null>(null),
    [supplement, setSupplement] = useState("");
  const [taskFilter, setTaskFilter] = useState<QueryCategory | "all">("all");
  const [projectTab, setProjectTab] = useState<"projects" | "knowledge">(
    "projects",
  );
  const [skillId, setSkillId] = useState("");
  const [detailTab, setDetailTab] = useState<
    "result" | "requirements" | "activity"
  >("result");
  const [search, setSearch] = useState(""),
    [projectFilter, setProjectFilter] = useState("");
  const [oldest, setOldest] = useState(false),
    [listPage, setListPage] = useState(1);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [loaded, setLoaded] = useState(false),
    [refreshError, setRefreshError] = useState("");
  const [lastUpdated, setLastUpdated] = useState("");
  const [confirmation, setConfirmation] = useState<{
    title: string;
    body: string;
    run: () => void;
  } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const dialogDirty = useRef(false);
  const [discardWarning, setDiscardWarning] = useState(false);
  useEffect(() => {
    dialogDirty.current = false;
    setDiscardWarning(false);
  }, [dialog, editProject]);
  function closeDialog() {
    // 只在用户主动离开已编辑表单时提示；成功提交后的关闭不重复确认。
    if (pending) return;
    if (dialogDirty.current) {
      setDiscardWarning(true);
      return;
    }
    setDialog(null);
  }
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  function navigate(next: string) {
    setPage(next);
    setSidebarOpen(false);
  }
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        navigate("tasks");
        requestAnimationFrame(() => searchRef.current?.focus());
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  useEffect(() => {
    setListPage(1);
  }, [search, projectFilter, taskFilter, oldest]);
  const [diffs, setDiffs] = useState<
    Record<
      string,
      { stat: string; patch: string; headSha: string; note: string }
    >
  >({});
  const refresh = useCallback(async () => {
    const [ts, ps, ss, ms, sk, views] = await Promise.all([
      api<Task[]>("/api/tasks"),
      api<Project[]>("/api/projects"),
      api("/api/settings"),
      api("/api/metrics"),
      api<Skill[]>("/api/skills"),
      // 服务尚未升级时继续显示原任务记录，不把旧记录推断为实际运行状态。
      api<TaskView[]>("/api/task-query").catch(() => null),
    ]);
    setTasks(ts);
    setTaskViews(views || []);
    setQueryReady(views !== null);
    setProjects(ps);
    setSettings(ss);
    setMetrics(ms);
    setSkills(sk);
    // 切换任务后丢弃旧请求的详情，避免把其他任务的结果放入当前审阅区。
    if (selected) {
      const nextDetail = await api<Detail>(`/api/tasks/${selected}`);
      if (selectedRef.current === selected) setDetail(nextDetail);
    }
    setLoaded(true);
    setRefreshError("");
    setLastUpdated(new Date().toISOString());
  }, [selected]);
  useEffect(() => {
    void refresh().catch((e) => setRefreshError(e.message));
    const stream = new EventSource("/api/events");
    stream.onmessage = () =>
      void refresh().catch((e) => setRefreshError(e.message));
    const interval = setInterval(
      () => void refresh().catch((e) => setRefreshError(e.message)),
      5000,
    );
    return () => {
      stream.close();
      clearInterval(interval);
    };
  }, [refresh]);
  async function action(fn: () => Promise<any>, message = "操作已完成") {
    setPending(true);
    setError("");
    try {
      const result = await fn();
      setNotice(result?.message || message);
      await refresh();
      return result;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setPending(false);
    }
  }
  function openTask(id: string) {
    // 重复打开当前任务沿用已加载详情；切换任务时才展示加载态。
    if (selectedRef.current !== id) setDetail(null);
    selectedRef.current = id;
    setSelected(id);
    setSupplement("");
    setDetailTab("result");
    navigate("task");
  }
  const viewOf = (id: string) => taskViews.find((v) => v.id === id);
  const running = tasks.filter((t) => viewOf(t.id)?.category === "running");
  const waiting = tasks.filter((t) => viewOf(t.id)?.category === "user");
  const openProject = (p: Project | null) => {
    setEditProject(p);
    setDialog("project");
  };
  const filteredTasks = filterTasks(tasks, taskViews, {
    category: taskFilter,
    project: projectFilter,
    search,
    oldest,
    queryReady,
  });
  const pageCount = Math.max(1, Math.ceil(filteredTasks.length / 8));
  const currentListPage = Math.min(listPage, pageCount);
  const selectedSkill = skills.find((s) => s.id === skillId) || skills[0];
  const recent = [...tasks].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );
  const title =
    page === "overview"
      ? "工作总览"
      : page === "tasks"
        ? "全部任务"
        : page === "projects"
          ? "项目与知识"
          : page === "settings"
            ? "系统设置"
            : detail?.task.title || "任务详情";
  return (
    <div className="layout">
      {sidebarOpen && (
        <button
          className="sidebar-scrim"
          aria-label="关闭导航"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <aside className={`app-sidebar ${sidebarOpen ? "is-open" : ""}`}>
        <button className="brand" onClick={() => navigate("overview")}>
          个人工作台
        </button>
        <button
          className="sidebar-create"
          onClick={() => setDialog("task")}
          disabled={!projects.length}
        >
          <Icon name="plus" />
          新建任务
        </button>
        <button
          className="sidebar-search"
          onClick={() => {
            navigate("tasks");
            requestAnimationFrame(() => searchRef.current?.focus());
          }}
        >
          <Icon name="search" />
          搜索任务<kbd>⌘ K</kbd>
        </button>
        <nav aria-label="主导航">
          {[
            ["overview", "grid", "工作总览"],
            ["tasks", "list", "全部任务"],
            ["projects", "folder", "项目与知识"],
          ].map(([key, icon, name]) => (
            <button
              key={key}
              className={
                page === key || (key === "tasks" && page === "task")
                  ? "active"
                  : ""
              }
              aria-current={page === key ? "page" : undefined}
              onClick={() => navigate(key)}
            >
              <Icon name={icon} />
              {name}
              {key === "tasks" && <em>{tasks.length}</em>}
            </button>
          ))}
        </nav>
        <div className="sidebar-scroll">
          <div className="workspace-label">
            项目
            <button
              className="icon-button"
              aria-label="注册项目"
              onClick={() => openProject(null)}
            >
              <Icon name="plus" size={15} />
            </button>
          </div>
          {projects.slice(0, 6).map((p) => (
            <button
              className="sidebar-link"
              key={p.id}
              title={p.name}
              onClick={() => {
                setProjectFilter(p.id);
                setTaskFilter("all");
                navigate("tasks");
              }}
            >
              <Icon name="folder" size={16} />
              <span>{p.name}</span>
            </button>
          ))}
          <div className="workspace-label">最近任务</div>
          {recent.slice(0, 4).map((t) => (
            <button
              key={t.id}
              className="sidebar-link"
              title={t.title}
              onClick={() => openTask(t.id)}
            >
              <i
                className={`status-dot ${viewOf(t.id)?.category || "other"}`}
              />
              <span>{t.title}</span>
            </button>
          ))}
        </div>
        <div className="aside-bottom">
          <button
            className={`sidebar-link ${page === "settings" ? "active" : ""}`}
            onClick={() => navigate("settings")}
          >
            <Icon name="settings" />
            系统设置
          </button>
          <div className="service-state">
            <span
              className={`live-dot ${!loaded || refreshError ? "offline" : ""}`}
            />
            {refreshError
              ? "服务连接异常"
              : loaded
                ? "本机服务在线"
                : "正在连接…"}
          </div>
        </div>
      </aside>
      <main>
        <header>
          <div className="breadcrumb">
            <button
              className="icon-button mobile-menu"
              aria-label="展开导航"
              aria-expanded={sidebarOpen}
              onClick={() => setSidebarOpen(!sidebarOpen)}
            >
              <Icon name="menu" />
            </button>
            {page === "task" ? (
              <button className="text-button" onClick={() => navigate("tasks")}>
                全部任务 / 任务详情
              </button>
            ) : (
              title
            )}
          </div>
          <div className="header-right">
            <span className="connection">本地工作空间</span>
            <span className="avatar">我</span>
          </div>
        </header>
        <div className="content">
          <div className="page-heading">
            <div>
              <h1>{title}</h1>
              <p>
                {page === "overview"
                  ? "先处理需要你的决定，再查看任务进展。"
                  : page === "projects"
                    ? "从本地仓库开始，为每个项目约定完成标准。"
                    : page === "settings"
                      ? "查看执行能力、消息连接与运行配置。"
                      : page === "tasks"
                        ? "查看任务进度、结果与待处理事项。"
                        : `${detail?.task.id ?? ""} · ${projects.find((p) => p.id === detail?.task.projectId)?.name ?? ""}`}
              </p>
            </div>
            <div className="actions">
              {page === "projects" ? (
                <button className="primary" onClick={() => openProject(null)}>
                  ＋ 注册项目
                </button>
              ) : page === "overview" || page === "tasks" ? (
                <button
                  className="primary"
                  onClick={() => setDialog("task")}
                  disabled={!projects.length}
                >
                  <Icon name="plus" size={16} /> 新建任务
                </button>
              ) : null}
            </div>
          </div>
          {refreshError && (
            <div className="alert error" role="alert">
              <span>
                数据更新失败：{refreshError}。
                {lastUpdated
                  ? `保留 ${date(lastUpdated)} 的结果，当前状态待核对。`
                  : "尚未取得数据。"}
              </span>
              <button
                onClick={() =>
                  void refresh().catch((e) => setRefreshError(e.message))
                }
              >
                重试
              </button>
            </div>
          )}
          {!loaded && !refreshError && (
            <div className="loading-state" role="status">
              正在加载工作空间…
            </div>
          )}
          {error && (
            <div className="alert error" role="alert">
              {error}
              <button onClick={() => setError("")}>关闭</button>
            </div>
          )}
          {notice && (
            <div className="alert success" role="status">
              {notice}
              <button onClick={() => setNotice("")}>关闭</button>
            </div>
          )}
          {loaded &&
            !queryReady &&
            (page === "overview" || page === "tasks" || page === "task") && (
              <div className="alert">
                任务状态查询服务不可用；以下状态统计暂不可用，请核对服务版本。
              </div>
            )}
          {page === "overview" && loaded && (
            <>
              <div className="stat-grid">
                {[
                  [
                    queryReady ? running.length : "—",
                    "已观察到运行",
                    "以会话当前状态为准",
                  ],
                  [
                    queryReady ? waiting.length : "—",
                    "待用户处理",
                    "等待你的决定或补充",
                  ],
                  [
                    queryReady
                      ? taskViews.filter((v) => v.category === "review").length
                      : "—",
                    "待核对",
                    "核对记录和会话",
                  ],
                  [
                    queryReady
                      ? taskViews.filter((v) => v.category === "completed")
                          .length
                      : "—",
                    "已完成",
                    "已交付或用户已确认",
                  ],
                ].map(([n, label, hint], i) => (
                  <button
                    className={`stat stat-${i}`}
                    key={String(label)}
                    disabled={!queryReady}
                    onClick={() => {
                      setTaskFilter(
                        (["running", "user", "review", "completed"] as const)[
                          i
                        ],
                      );
                      setProjectFilter("");
                      setSearch("");
                      navigate("tasks");
                    }}
                  >
                    <span>{label}</span>
                    <strong>{n}</strong>
                    <small>{hint}</small>
                  </button>
                ))}
              </div>
              {!projects.length ? (
                <section className="onboarding">
                  <div>
                    <span className="pill">从一个真实项目开始</span>
                    <h2>你的第一个 AI 执行空间</h2>
                    <p>
                      注册一个本地 Git
                      仓库，设置验证命令。随后直接发送需求，主控会整理任务、执行并提交交付证据。
                    </p>
                    <button
                      className="primary"
                      onClick={() => openProject(null)}
                    >
                      注册本地项目 →
                    </button>
                  </div>
                  <ol>
                    <li>
                      <b>01</b>
                      <span>
                        连接项目<small>本地路径与目标分支</small>
                      </span>
                    </li>
                    <li>
                      <b>02</b>
                      <span>
                        明确完成标准<small>真实运行与验证命令</small>
                      </span>
                    </li>
                    <li>
                      <b>03</b>
                      <span>
                        确认交付<small>查看版本后批准合并</small>
                      </span>
                    </li>
                  </ol>
                </section>
              ) : null}
              <div className="overview-sections">
                <section className="panel">
                  <div className="section-title">
                    <h2>
                      需要你的决定{" "}
                      <span>{queryReady ? waiting.length : "—"}</span>
                    </h2>
                  </div>
                  {!queryReady ? (
                    <p>状态查询不可用。</p>
                  ) : waiting.length ? (
                    waiting
                      .slice(0, 6)
                      .map((t) => (
                        <TaskRow
                          key={t.id}
                          task={t}
                          view={queryReady ? viewOf(t.id) : undefined}
                          project={
                            projects.find((p) => p.id === t.projectId)?.name
                          }
                          open={openTask}
                        />
                      ))
                  ) : (
                    <Empty
                      title="现在没有待处理事项"
                      text="需要补充信息或确认交付时，会在这里提醒你。"
                    />
                  )}
                </section>
                <section className="panel">
                  <div className="section-title">
                    <h2>最近任务</h2>
                    <button
                      className="text-button"
                      onClick={() => setPage("tasks")}
                    >
                      查看全部 →
                    </button>
                  </div>
                  {!queryReady ? (
                    <p>状态查询不可用。</p>
                  ) : recent.length ? (
                    recent
                      .slice(0, 6)
                      .map((t) => (
                        <TaskRow
                          key={t.id}
                          task={t}
                          view={queryReady ? viewOf(t.id) : undefined}
                          project={
                            projects.find((p) => p.id === t.projectId)?.name
                          }
                          open={openTask}
                        />
                      ))
                  ) : (
                    <Empty
                      title="还没有任务"
                      text="新建任务后，主控会自动整理目标并安排执行。"
                    />
                  )}
                </section>
              </div>
            </>
          )}
          {page === "tasks" && loaded && (
            <section className="task-list">
              <div className="tabs" aria-label="任务状态筛选">
                {(
                  [
                    "all",
                    "running",
                    "user",
                    "review",
                    "queued",
                    "completed",
                    "other",
                  ] as const
                ).map((key) => (
                  <button
                    key={key}
                    disabled={!queryReady && key !== "all"}
                    className={
                      taskFilter === key || (!queryReady && key === "all")
                        ? "active"
                        : ""
                    }
                    aria-pressed={
                      queryReady ? taskFilter === key : key === "all"
                    }
                    onClick={() => setTaskFilter(key)}
                  >
                    {key === "all" ? "全部" : categoryLabels[key]}{" "}
                    <span>
                      {key === "all"
                        ? tasks.length
                        : queryReady
                          ? taskViews.filter((v) => v.category === key).length
                          : "—"}
                    </span>
                  </button>
                ))}
              </div>
              <div className="list-toolbar">
                <label className="search-field">
                  <Icon name="search" />
                  <input
                    ref={searchRef}
                    aria-label="搜索任务名称或编号"
                    placeholder="搜索任务名称或编号"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </label>
                <select
                  aria-label="筛选所属项目"
                  value={projectFilter}
                  onChange={(e) => setProjectFilter(e.target.value)}
                >
                  <option value="">所有项目</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="任务排序"
                  value={oldest ? "oldest" : "newest"}
                  onChange={(e) => setOldest(e.target.value === "oldest")}
                >
                  <option value="newest">最近更新优先</option>
                  <option value="oldest">最早更新优先</option>
                </select>
              </div>
              <div className="task-table-heading">
                <span>任务 / 最新进展</span>
                <span>所属项目</span>
                <span>状态</span>
                <span>更新时间</span>
              </div>
              {filteredTasks
                .slice((currentListPage - 1) * 8, currentListPage * 8)
                .map((t) => (
                  <TaskRow
                    key={t.id}
                    task={t}
                    view={queryReady ? viewOf(t.id) : undefined}
                    project={projects.find((p) => p.id === t.projectId)?.name}
                    open={openTask}
                  />
                ))}
              {!filteredTasks.length && (
                <Empty
                  title={tasks.length ? "没有符合条件的任务" : "还没有任务"}
                  text={
                    tasks.length
                      ? "尝试其他关键词、项目或状态。"
                      : "注册项目后即可创建第一个任务。"
                  }
                />
              )}
              {!filteredTasks.length && tasks.length > 0 && (
                <button
                  onClick={() => {
                    setSearch("");
                    setProjectFilter("");
                    setTaskFilter("all");
                  }}
                >
                  清除筛选
                </button>
              )}
              <div className="pagination">
                <span>
                  共 {filteredTasks.length} 项 · 第 {currentListPage} /{" "}
                  {pageCount} 页
                </span>
                <div>
                  <button
                    disabled={currentListPage === 1}
                    onClick={() => setListPage(currentListPage - 1)}
                  >
                    上一页
                  </button>
                  <button
                    disabled={currentListPage === pageCount}
                    onClick={() => setListPage(currentListPage + 1)}
                  >
                    下一页
                  </button>
                </div>
              </div>
            </section>
          )}
          {page === "projects" && loaded && (
            <>
              <div className="tabs" aria-label="项目与知识分类">
                <button
                  className={projectTab === "projects" ? "active" : ""}
                  aria-pressed={projectTab === "projects"}
                  onClick={() => setProjectTab("projects")}
                >
                  项目 {projects.length}
                </button>
                <button
                  className={projectTab === "knowledge" ? "active" : ""}
                  aria-pressed={projectTab === "knowledge"}
                  onClick={() => setProjectTab("knowledge")}
                >
                  知识与 Skill {skills.length}
                </button>
              </div>
              {projectTab === "projects" ? (
                <>
                  <div className="import-banner">
                    <Icon name="folder" size={24} />
                    <div>
                      <h2>从 Codex 导入项目</h2>
                      <p>先选择目录，再预览并确认导入。</p>
                    </div>
                    <button onClick={() => setDialog("import")}>
                      扫描并导入
                    </button>
                  </div>
                  <div className="section-title">
                    <h2>已注册项目</h2>
                    <span className="muted">{projects.length} 个项目</span>
                  </div>
                  <div className="project-list">
                    {projects.map((p) => (
                      <details className="project-item" key={p.id}>
                        <summary>
                          <Icon name="folder" />
                          <span className="project-title">
                            <strong>{p.name}</strong>
                            <small>
                              {repositoriesOf(p).length} 个仓库 ·{" "}
                              {p.deliveryMode === "local"
                                ? "本地交付"
                                : "GitHub PR"}
                            </small>
                          </span>
                          <span
                            className="project-branches"
                            title={repositoriesOf(p)
                              .map((r) => r.baseBranch)
                              .join(" / ")}
                          >
                            {repositoriesOf(p)
                              .map((r) => r.baseBranch)
                              .join(" / ")}
                          </span>
                          <span
                            className={`pill ${projectIssues(p).length ? "review" : "completed"}`}
                          >
                            {projectIssues(p).length ? "待配置" : "可执行"}
                          </span>
                          <span>查看详情</span>
                        </summary>
                        <div className="project-expanded">
                          {projectIssues(p).length > 0 && (
                            <p className="error-text">
                              {projectIssues(p).join("；")}
                            </p>
                          )}
                          {repositoriesOf(p).map((r) => (
                            <section
                              className="repository-detail"
                              key={r.repositoryId}
                            >
                              <h3>{r.name}</h3>
                              <dl>
                                <dt>仓库目录</dt>
                                <dd>
                                  <code>{r.repoPath}</code>
                                </dd>
                                <dt>目标分支</dt>
                                <dd>{r.baseBranch}</dd>
                                <dt>交付方式</dt>
                                <dd>
                                  {r.deliveryMode === "local"
                                    ? "本地交付"
                                    : "GitHub PR"}
                                </dd>
                              </dl>
                              <h3>完成验证</h3>
                              {r.verifyCommands.length ? (
                                r.verifyCommands.map((cmd) => (
                                  <pre key={cmd}>{cmd}</pre>
                                ))
                              ) : (
                                <p className="muted">尚未配置验证命令</p>
                              )}
                            </section>
                          ))}
                          {p.instructions && (
                            <>
                              <h3>项目约定</h3>
                              <p className="preserve">{p.instructions}</p>
                            </>
                          )}
                          <div className="button-row">
                            <button onClick={() => openProject(p)}>
                              编辑项目
                            </button>
                            <button
                              onClick={() => {
                                setProjectFilter(p.id);
                                setTaskFilter("all");
                                navigate("tasks");
                              }}
                            >
                              查看项目任务
                            </button>
                          </div>
                        </div>
                      </details>
                    ))}
                  </div>
                  {!projects.length && (
                    <Empty
                      title="添加一个本地项目"
                      text="从 Codex 导入，或注册本地 Git 仓库。"
                    />
                  )}
                </>
              ) : (
                <>
                  <div className="section-title">
                    <h2>项目知识与 Skill</h2>
                    <button
                      onClick={() => setDialog("skill")}
                      disabled={!projects.length}
                    >
                      <Icon name="plus" size={16} />
                      新建草稿
                    </button>
                  </div>
                  {selectedSkill ? (
                    <div className="knowledge-layout">
                      <div className="skill-list" aria-label="知识列表">
                        {skills.map((sk) => (
                          <button
                            key={sk.id}
                            className={
                              selectedSkill.id === sk.id ? "active" : ""
                            }
                            onClick={() => setSkillId(sk.id)}
                          >
                            <Icon name="book" />
                            <span>
                              <strong>{sk.name}</strong>
                              <small>
                                {
                                  projects.find((p) => p.id === sk.projectId)
                                    ?.name
                                }{" "}
                                · {sk.status === "active" ? "已启用" : "草稿"}
                              </small>
                            </span>
                          </button>
                        ))}
                      </div>
                      <section className="skill-content">
                        <span className="pill">
                          {selectedSkill.status === "active"
                            ? "已启用"
                            : "草稿"}
                        </span>
                        <h2>{selectedSkill.name}</h2>
                        <p className="muted">
                          {
                            projects.find(
                              (p) => p.id === selectedSkill.projectId,
                            )?.name
                          }{" "}
                          · 版本 {selectedSkill.version.slice(0, 12)}
                        </p>
                        <pre>{selectedSkill.content}</pre>
                        {selectedSkill.status === "draft" && (
                          <>
                            <p className="muted">
                              草稿不会自动参与任务执行，确认启用后才会进入工作包。
                            </p>
                            <button
                              className="primary"
                              disabled={pending}
                              onClick={() =>
                                setConfirmation({
                                  title: "确认启用此 Skill？",
                                  body: `启用“${selectedSkill.name}”版本 ${selectedSkill.version.slice(0, 12)}，后续任务将记录使用版本。`,
                                  run: () =>
                                    void action(
                                      () =>
                                        api(
                                          `/api/skills/${selectedSkill.id}/activate`,
                                          {},
                                        ),
                                      "Skill 已启用",
                                    ),
                                })
                              }
                            >
                              确认启用
                            </button>
                          </>
                        )}
                      </section>
                    </div>
                  ) : (
                    <Empty
                      title="从重复成功的流程中积累"
                      text="新建知识草稿，审阅后再启用。"
                    />
                  )}
                </>
              )}
            </>
          )}
          {page === "task" && !detail && !refreshError && (
            <div className="loading-state" role="status">
              正在加载任务详情…
            </div>
          )}
          {page === "task" && detail && (
            <>
              <div className="detail-workspace">
                <div className="detail-main">
                  <div className="tabs" aria-label="任务详情分类">
                    {(
                      [
                        ["result", "结果与证据"],
                        ["requirements", "需求与补充"],
                        ["activity", "执行记录"],
                      ] as const
                    ).map(([key, label]) => (
                      <button
                        key={key}
                        className={detailTab === key ? "active" : ""}
                        aria-pressed={detailTab === key}
                        onClick={() => setDetailTab(key)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <div hidden={detailTab !== "requirements"}>
                    <section className="panel padded">
                      <div className="section-title">
                        <h2>目标与完成条件</h2>
                        {detail.task.status === "delivered" && (
                          <button
                            disabled={pending}
                            onClick={() =>
                              void action(
                                () =>
                                  api(`/api/tasks/${selected}/skill-draft`, {}),
                                "已生成草稿，请到项目与知识检查后启用",
                              )
                            }
                          >
                            提炼 Skill 草稿
                          </button>
                        )}
                      </div>
                      <details className="share-image">
                        <summary>发送页面截图到微信</summary>
                        <form
                          onSubmit={async (e) => {
                            e.preventDefault();
                            const form = e.currentTarget;
                            const file = new FormData(form).get("image");
                            if (!(file instanceof File) || !file.size) return;
                            const bytes = new Uint8Array(
                              await file.arrayBuffer(),
                            );
                            let binary = "";
                            for (let i = 0; i < bytes.length; i += 8192)
                              binary += String.fromCharCode(
                                ...bytes.subarray(i, i + 8192),
                              );
                            const ok = await action(
                              () =>
                                api(
                                  `/api/tasks/${detail.task.id}/weixin-image`,
                                  { image: btoa(binary) },
                                ),
                              "图片已加入微信发送队列，请在微信核对",
                            );
                            if (ok) form.reset();
                          }}
                        >
                          <label>
                            页面截图（PNG 或 JPEG，最多 10 MiB）
                            <input
                              name="image"
                              type="file"
                              accept="image/png,image/jpeg"
                              required
                            />
                          </label>
                          <button type="submit" disabled={pending}>
                            发送截图到微信
                          </button>
                        </form>
                      </details>
                      <p className="preserve">{detail.task.goal}</p>
                      {detail.task.criteria.length > 0 && (
                        <ul className="criteria">
                          {detail.task.criteria.map((c, i) => (
                            <li key={i}>{c}</li>
                          ))}
                        </ul>
                      )}
                      {detail.task.question && (
                        <div className="question">
                          需要你回答：{detail.task.question}
                        </div>
                      )}
                      <form
                        onSubmit={async (e) => {
                          e.preventDefault();
                          const ok = await action(
                            () =>
                              api(`/api/tasks/${selected}/supplement`, {
                                text: supplement,
                              }),
                            "补充已记录",
                          );
                          if (ok) setSupplement("");
                        }}
                      >
                        <label>
                          补充要求或回答问题
                          <textarea
                            value={supplement}
                            onChange={(e) => setSupplement(e.target.value)}
                            placeholder="写下必要的背景、约束或验收意见…"
                            required
                          />
                        </label>
                        <button
                          disabled={
                            pending ||
                            !supplement.trim() ||
                            ["delivered", "cancelled"].includes(
                              detail.task.status,
                            )
                          }
                        >
                          发送补充
                        </button>
                      </form>
                    </section>
                  </div>
                  <div hidden={detailTab !== "result"}>
                    <section className="panel padded result-summary">
                      <h2>任务结果</h2>
                      {detail.task.summary ? (
                        <p className="preserve">{detail.task.summary}</p>
                      ) : (
                        <p className="muted">
                          尚未收到最终结果。请在执行记录查看进展。
                        </p>
                      )}
                      <button onClick={() => setDetailTab("requirements")}>
                        补充要求或回答问题
                      </button>
                    </section>
                    {detail.deliveries
                      .filter(
                        (d) => d.status === "pending" || d.status === "merged",
                      )
                      .map((d) => (
                        <section className="panel padded delivery" key={d.id}>
                          <div className="section-title">
                            <h2>
                              {d.status === "merged"
                                ? "已核实交付"
                                : "等待你确认交付"}
                            </h2>
                            <span className="pill">
                              {d.mode === "local" ? "本地 Git" : "GitHub PR"}
                            </span>
                          </div>
                          <p>
                            {d.status === "merged"
                              ? "已完成合并，并核对目标分支包含此交付提交。"
                              : d.mode === "local"
                                ? "确认后将合并到本地目标分支。"
                                : "确认后将核对 PR 与必需 CI，再合并。"}
                          </p>
                          <dl>
                            <dt>仓库</dt>
                            <dd>{d.repositoryName || d.repo}</dd>
                            <dt>目标分支</dt>
                            <dd>{d.base}</dd>
                            <dt>交付分支</dt>
                            <dd>{d.branch}</dd>
                            <dt>提交 SHA</dt>
                            <dd>
                              <code>{d.headSha}</code>
                            </dd>
                            <dt>确认编号</dt>
                            <dd>{d.token}</dd>
                          </dl>
                          {d.url && (
                            <a href={d.url} target="_blank" rel="noreferrer">
                              打开 GitHub PR ↗
                            </a>
                          )}
                          <details
                            onToggle={(event) => {
                              if (event.currentTarget.open && !diffs[d.id])
                                void api(`/api/groups/${d.groupId}/diff`)
                                  .then((result) =>
                                    setDiffs((current) => ({
                                      ...current,
                                      [d.id]: result,
                                    })),
                                  )
                                  .catch((e) => setError(e.message));
                            }}
                          >
                            <summary>查看代码差异</summary>
                            {diffs[d.id] ? (
                              <>
                                <pre>{diffs[d.id].stat}</pre>
                                <pre>{diffs[d.id].patch}</pre>
                                {diffs[d.id].patch.length > 1900000 && (
                                  <p className="muted">{diffs[d.id].note}</p>
                                )}
                              </>
                            ) : (
                              <p className="muted">正在读取提交差异…</p>
                            )}
                          </details>
                          {d.status === "pending" ? (
                            <button
                              className="primary"
                              disabled={pending}
                              onClick={() => {
                                if (
                                  window.confirm(
                                    `确认将提交 ${d.headSha} 合并到 ${d.base}？`,
                                  )
                                )
                                  void action(() =>
                                    api(`/api/tasks/${selected}/approve`, {
                                      token: d.token,
                                    }),
                                  );
                              }}
                            >
                              确认合并指定版本
                            </button>
                          ) : (
                            <p>
                              合并提交：<code>{d.mergeSha}</code>
                            </p>
                          )}
                        </section>
                      ))}
                    <section className="panel padded">
                      <h2>验证证据</h2>
                      {detail.evidence.length ? (
                        detail.evidence.map((e) => (
                          <div className="evidence" key={e.id}>
                            <b>
                              {e.exitCode === 0 ? "✓" : "!"} {e.command}
                            </b>
                            <small>
                              {detail.groups.find((g) => g.id === e.groupId)
                                ?.repository?.name || ""}{" "}
                              · {e.headSha.slice(0, 12)}
                            </small>
                            <pre>{e.summary}</pre>
                            {e.logPath && (
                              <a
                                href={`/api/evidence/${e.id}/file`}
                                target="_blank"
                              >
                                打开完整日志 ↗
                              </a>
                            )}
                            {e.artifacts.map((_, i) => (
                              <a
                                key={i}
                                href={`/api/evidence/${e.id}/file?artifact=${i}`}
                                target="_blank"
                              >
                                查看产物 {i + 1} ↗{" "}
                              </a>
                            ))}
                          </div>
                        ))
                      ) : (
                        <p className="muted">
                          尚未产生验证证据。执行 Agent
                          的完成声明不会直接被当作验收通过。
                        </p>
                      )}
                    </section>
                  </div>
                  <div hidden={detailTab !== "activity"}>
                    <section className="panel padded">
                      <h2>执行分组</h2>
                      {detail.groups.map((g) => (
                        <div className="group" key={g.id}>
                          <b>
                            {g.repository?.name
                              ? `${g.repository.name} / `
                              : ""}
                            {g.title}
                          </b>
                          <Badge status={g.status} />
                          <small>
                            返工 {g.reworks}/2 · {g.id}
                          </small>
                          <code>{g.worktree || "等待创建工作目录"}</code>
                          {g.dependsOn.length > 0 && (
                            <small>
                              等待前置组交付：{g.dependsOn.join(", ")}
                            </small>
                          )}
                          {g.progress && (
                            <details>
                              <summary>最新输出</summary>
                              <pre>{g.progress}</pre>
                            </details>
                          )}
                        </div>
                      ))}
                    </section>
                    <section className="panel padded">
                      <h2>任务时间线</h2>
                      <div className="timeline">
                        {detail.events
                          .slice()
                          .reverse()
                          .map((e) => (
                            <div key={e.id}>
                              <small>{date(e.createdAt)}</small>
                              {e.type === "command" ? (
                                <details>
                                  <summary>执行命令</summary>
                                  <pre>{e.message}</pre>
                                </details>
                              ) : (
                                <p>{e.message}</p>
                              )}
                            </div>
                          ))}
                      </div>
                    </section>
                    <section className="panel padded">
                      <h2>运行记录</h2>
                      {detail.runs.map((r) => (
                        <details key={r.id} className="run">
                          <summary>
                            {r.role === "controller"
                              ? "主控规划"
                              : r.role === "executor"
                                ? "执行会话"
                                : "验收步骤"}{" "}
                            · {r.status}
                          </summary>
                          <small>{r.sessionId}</small>
                          <pre>{r.error || r.summary}</pre>
                        </details>
                      ))}
                    </section>
                  </div>
                </div>
                <section className="review-rail">
                  <h2>审阅与操作</h2>{" "}
                  <div className="review-actions">
                    <span className="pill">
                      {viewOf(detail.task.id)?.stage ||
                        `记录状态：${labels[detail.task.status]}`}
                    </span>
                    <span>创建于 {date(detail.task.createdAt)}</span>
                    {viewOf(detail.task.id)?.category === "review" && (
                      <button
                        className="primary"
                        disabled={pending}
                        onClick={() => {
                          setConfirmation({
                            title: "确认完成此任务？",
                            body: "请确认已查看最终结果且满足要求。此操作仅关闭任务，不会合并代码。后端将再次核对是否存在活动执行或待处理投递。",
                            run: () =>
                              void action(() =>
                                api(
                                  `/api/tasks/${selected}/confirm-complete`,
                                  {},
                                ),
                              ),
                          });
                        }}
                      >
                        确认完成
                      </button>
                    )}
                    {viewOf(detail.task.id)?.category === "queued" && (
                      <button
                        disabled={pending}
                        onClick={() =>
                          void action(() =>
                            api(`/api/tasks/${selected}/resend`, {}),
                          )
                        }
                      >
                        重发
                      </button>
                    )}
                    <button
                      disabled={
                        pending ||
                        ["cancelled", "delivered"].includes(detail.task.status)
                      }
                      onClick={() =>
                        void action(
                          () => api(`/api/tasks/${selected}/stop`, {}),
                          "任务已停止",
                        )
                      }
                    >
                      停止任务
                    </button>
                    {detail.task.status === "blocked" && (
                      <button
                        disabled={pending}
                        onClick={() =>
                          void action(
                            () => api(`/api/tasks/${selected}/resume`, {}),
                            "已请求恢复",
                          )
                        }
                      >
                        恢复执行
                      </button>
                    )}
                  </div>
                  <p className="muted">
                    确认完成只关闭任务；代码交付仍需单独确认指定版本。状态与操作条件由服务端核对。
                  </p>
                  <h3>任务信息</h3>
                  <dl>
                    <dt>所属项目</dt>
                    <dd>
                      {projects.find((p) => p.id === detail.task.projectId)
                        ?.name || "—"}
                    </dd>
                    <dt>更新时间</dt>
                    <dd>{date(detail.task.updatedAt)}</dd>
                    <dt>执行模式</dt>
                    <dd>
                      {detail.task.controllerMode === "native"
                        ? "Codex App 主控"
                        : "本地执行器"}
                    </dd>
                    <dt>需求版本</dt>
                    <dd>{detail.task.revision || 1}</dd>
                  </dl>
                  {detail.task.controllerSession && (
                    <a
                      href={`codex://threads/${encodeURIComponent(detail.task.controllerSession)}`}
                    >
                      打开负责会话 ↗
                    </a>
                  )}
                  <h3>最近活动</h3>
                  <div className="timeline">
                    {detail.events
                      .slice(-3)
                      .reverse()
                      .map((e) => (
                        <div key={e.id}>
                          <small>{date(e.createdAt)}</small>
                          <p>{plainSummary(e.message)}</p>
                        </div>
                      ))}
                  </div>
                  <button
                    className="text-button"
                    onClick={() => setDetailTab("activity")}
                  >
                    查看完整执行记录 →
                  </button>
                </section>
              </div>
            </>
          )}
          {page === "settings" && settings && (
            <div className="settings-page">
              <div className="settings-tabs" aria-label="设置分类">
                {(
                  [
                    ["execution", "执行与主控"],
                    ["channels", "消息通道"],
                    ["runtime", "运行状态"],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    className={settingsTab === key ? "active" : ""}
                    aria-pressed={settingsTab === key}
                    onClick={() => setSettingsTab(key)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div hidden={settingsTab !== "execution"}>
                <div className="settings-group-heading">
                  <h2>执行与主控</h2>
                  <p>配置工作台的执行能力与主控连接。</p>
                </div>
                <NativeControllerPanel
                  openTask={(id) => void openTask(id)}
                  status={settings.native}
                  pending={pending}
                  save={(value) =>
                    void action(() => api("/api/settings/native", value, "PUT"))
                  }
                  check={() =>
                    void action(() => api("/api/settings/native/check", {}))
                  }
                  setDesktopWake={(enabled) =>
                    void action(() =>
                      api(
                        "/api/settings/native/desktop-wake",
                        { enabled },
                        "PUT",
                      ),
                    )
                  }
                  resolve={(id, turnId, reason) =>
                    void action(
                      () =>
                        api(
                          `/api/channel-messages/${encodeURIComponent(id)}/resolve-interrupted`,
                          { turnId, reason },
                        ),
                      "已结案，后续消息将继续处理",
                    )
                  }
                />
                <section className="panel padded settings-card">
                  <div className="section-title">
                    <h2>Codex 执行器</h2>
                    <span className="pill">已实现</span>
                  </div>
                  <dl>
                    <dt>认证来源</dt>
                    <dd>{settings.codex.authentication}</dd>
                    <dt>模型</dt>
                    <dd>{settings.codex.model}</dd>
                    <dt>可执行文件</dt>
                    <dd>
                      <code>{settings.codex.executable}</code>
                    </dd>
                    <dt>能力</dt>
                    <dd>恢复会话 · 中断执行 · 结构化结果</dd>
                  </dl>
                  <button
                    disabled={pending}
                    onClick={() =>
                      void action(
                        () => api("/api/settings/check-codex", {}),
                        "已刷新认证状态",
                      )
                    }
                  >
                    重新检查
                  </button>
                  <p className="muted">
                    登录状态不代表请求已成功；实际执行结果记录在任务中。
                  </p>
                </section>
              </div>
              <div hidden={settingsTab !== "channels"}>
                <div className="settings-group-heading">
                  <h2>消息通道</h2>
                  <p>连接消息入口并查看通道状态。</p>
                </div>
                <div className="settings-channel-grid">
                  <section className="panel padded settings-card">
                    <div className="section-title">
                      <h2>钉钉消息通道</h2>
                      <span className="pill">
                        {settings.dingtalk.connected
                          ? "已连接"
                          : settings.dingtalk.connecting
                            ? "正在连接"
                            : settings.dingtalk.configured
                              ? "已配置，未连接"
                              : "待配置"}
                      </span>
                    </div>
                    <DingTalkForm
                      status={settings.dingtalk}
                      pending={pending}
                      save={async (data) =>
                        !!(await action(() =>
                          api("/api/settings/dingtalk", data, "PUT"),
                        ))
                      }
                    />
                    {settings.dingtalk.error && (
                      <p className="error-text">{settings.dingtalk.error}</p>
                    )}
                    <button
                      disabled={pending || !settings.dingtalk.configured}
                      onClick={() =>
                        void action(() =>
                          api("/api/settings/test-dingtalk", {}),
                        )
                      }
                    >
                      向我发送测试消息
                    </button>
                    <p className="muted">
                      待发送消息：{settings.dingtalk.pending}；回执待核对：
                      {settings.dingtalk.uncertain?.length || 0}
                      。未配置时保留队列，回执未知时不自动重发。
                    </p>
                  </section>
                  {settings.weixin && (
                    <section className="panel padded settings-card">
                      <div className="section-title">
                        <h2>微信消息通道</h2>
                        <span className="pill">
                          {settings.weixin.connected
                            ? "已连接"
                            : settings.weixin.configured
                              ? "已绑定，未连接"
                              : "待绑定"}
                        </span>
                      </div>
                      <p className="muted">
                        使用微信扫码绑定本人
                        ClawBot，支持文本消息和任务截图发送。请先在微信发送消息，建立回复上下文。
                      </p>
                      <button
                        disabled={pending}
                        onClick={() =>
                          void action(
                            () => api("/api/settings/weixin/bind", {}),
                            "请使用微信扫码绑定",
                          )
                        }
                      >
                        {settings.weixin.configured
                          ? "重新绑定微信"
                          : "绑定微信"}
                      </button>
                      {settings.weixin.login && (
                        <div>
                          <p>
                            {(
                              {
                                wait: "请使用微信扫描二维码",
                                scaned: "已扫码，请在手机上确认",
                                need_verifycode: "请输入手机微信显示的数字",
                                expired: "二维码已过期，请重新绑定",
                                verify_code_blocked:
                                  "验证码错误次数过多，请重新绑定",
                                binded_redirect: "账号已绑定，请检查原有绑定",
                              } as Record<string, string>
                            )[settings.weixin.login.status] ||
                              "正在等待微信确认"}
                          </p>
                          <img
                            src={settings.weixin.login.image}
                            alt="微信绑定二维码"
                            width="220"
                            height="220"
                          />
                          {settings.weixin.login.status.includes(
                            "need_verifycode",
                          ) && (
                            <form
                              onSubmit={(e) => {
                                e.preventDefault();
                                const code = String(
                                  new FormData(e.currentTarget).get("code") ||
                                    "",
                                );
                                void action(() =>
                                  api("/api/settings/weixin/verify-code", {
                                    code,
                                  }),
                                );
                              }}
                            >
                              <input
                                name="code"
                                inputMode="numeric"
                                placeholder="手机微信显示的数字"
                                required
                              />
                              <button disabled={pending}>提交验证码</button>
                            </form>
                          )}
                        </div>
                      )}
                      {settings.weixin.error && (
                        <p className="error-text">{settings.weixin.error}</p>
                      )}
                      <p className="muted">
                        待发送消息：{settings.weixin.pending}；回执待核对：
                        {settings.weixin.uncertain.length}。
                      </p>
                      {settings.weixin.uncertain.map(
                        (item: { id: string; error: string }) => (
                          <p className="error-text" key={item.id}>
                            {item.id}：{item.error}
                          </p>
                        ),
                      )}
                    </section>
                  )}
                </div>
              </div>
              <div hidden={settingsTab !== "runtime"}>
                <div className="settings-group-heading">
                  <h2>运行状态</h2>
                  <p>管理执行容量并查看工作台运行信息。</p>
                </div>
                <section className="panel padded settings-card">
                  <h2>运行与可观测性</h2>
                  <form
                    className="inline-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const data = new FormData(e.currentTarget);
                      void action(
                        () =>
                          api(
                            "/api/settings",
                            {
                              maxConcurrent: Number(data.get("maxConcurrent")),
                            },
                            "PUT",
                          ),
                        "并发配置已更新",
                      );
                    }}
                  >
                    <label>
                      最大执行组数
                      <input
                        type="number"
                        name="maxConcurrent"
                        min="1"
                        max="8"
                        defaultValue={settings.maxConcurrent}
                        key={settings.maxConcurrent}
                      />
                    </label>
                    <button disabled={pending}>保存</button>
                  </form>
                  <p>
                    数据目录：<code>{settings.dataDir}</code>
                  </p>
                  <p className="muted">
                    电脑休眠或关机时，执行和通知都会中断。恢复时会核对已有工作，不自动重复交付。
                  </p>
                  <dl>
                    <dt>人工补充次数</dt>
                    <dd>{metrics.interventions ?? 0}</dd>
                    <dt>自动返工次数</dt>
                    <dd>{metrics.reworks ?? 0}</dd>
                    <dt>平均交付耗时</dt>
                    <dd>
                      {metrics.averageDeliveredMinutes == null
                        ? "暂无数据"
                        : `${metrics.averageDeliveredMinutes.toFixed(1)} 分钟`}
                    </dd>
                    <dt>准确费用</dt>
                    <dd>未知</dd>
                  </dl>
                </section>
              </div>
            </div>
          )}
          <footer>
            个人 AI 工作台 <span>执行有记录，交付有证据。</span>
          </footer>
        </div>
      </main>
      {dialog && (
        <Modal
          label={
            dialog === "task"
              ? "创建新任务"
              : dialog === "project"
                ? "项目配置"
                : dialog === "import"
                  ? "从 Codex 导入项目"
                  : "创建 Skill 草稿"
          }
          onClose={closeDialog}
          onDirty={() => {
            dialogDirty.current = true;
          }}
        >
          <div className="section-title">
            <h2>
              {dialog === "task"
                ? "创建新任务"
                : dialog === "project"
                  ? editProject
                    ? "编辑项目"
                    : "注册本地项目"
                  : dialog === "import"
                    ? "导入项目"
                    : "创建 Skill 草稿"}
            </h2>
            <button
              className="close"
              aria-label="关闭弹窗"
              disabled={pending}
              onClick={closeDialog}
            >
              ×
            </button>
          </div>
          {discardWarning && (
            <div className="alert" role="alert">
              <span>有尚未保存的修改，是否放弃？</span>
              <button
                type="button"
                autoFocus
                onClick={() => setDiscardWarning(false)}
              >
                继续编辑
              </button>
              <button type="button" onClick={() => setDialog(null)}>
                放弃修改并关闭
              </button>
            </div>
          )}
          {error && <div className="alert error">{error}</div>}
          {dialog === "import" && (
            <CodexImport
              api={api}
              projects={projects}
              onImported={refresh}
              onOpenProject={(id) =>
                openProject(projects.find((p) => p.id === id) || null)
              }
            />
          )}
          {dialog === "task" && (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const d = Object.fromEntries(new FormData(e.currentTarget));
                const result = await action(
                  () => api("/api/tasks", d),
                  "任务已提交",
                );
                if (result) {
                  setDialog(null);
                  openTask(result.id);
                }
              }}
            >
              <label>
                项目
                <select name="projectId">
                  {projects.map((p) => (
                    <option
                      value={p.id}
                      key={p.id}
                      disabled={projectIssues(p).length > 0}
                    >
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                任务标题
                <input
                  name="title"
                  required
                  placeholder="例如：给订单列表增加 CSV 导出"
                  maxLength={160}
                />
              </label>
              <label>
                目标与约束
                <textarea
                  name="goal"
                  required
                  rows={6}
                  placeholder="描述希望得到的行为、范围和判断完成的依据。"
                />
              </label>
              <p className="muted">
                提交后主控会自动分析；信息不足时会向你提问。
              </p>
              <button className="primary" disabled={pending}>
                提交给主控
              </button>
            </form>
          )}
          {dialog === "project" && (
            <ProjectForm
              project={editProject}
              pending={pending}
              save={async (data) => {
                const result = await action(
                  () =>
                    api(
                      editProject
                        ? `/api/projects/${editProject.id}`
                        : "/api/projects",
                      data,
                      editProject ? "PUT" : "POST",
                    ),
                  "项目已保存",
                );
                if (result) setDialog(null);
              }}
            />
          )}
          {dialog === "skill" && (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const data = Object.fromEntries(new FormData(e.currentTarget));
                if (
                  await action(
                    () => api("/api/skills", data),
                    "草稿已保存，尚未启用",
                  )
                )
                  setDialog(null);
              }}
            >
              <label>
                项目
                <select name="projectId">
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                名称
                <input name="name" required />
              </label>
              <label>
                Markdown 内容
                <textarea name="content" rows={12} required />
              </label>
              <button className="primary" disabled={pending}>
                保存为草稿
              </button>
            </form>
          )}
        </Modal>
      )}
      {confirmation && (
        <Modal label={confirmation.title} onClose={() => setConfirmation(null)}>
          <h2>{confirmation.title}</h2>
          <p>{confirmation.body}</p>
          <div className="modal-actions">
            <button onClick={() => setConfirmation(null)}>返回审阅</button>
            <button
              className="primary"
              onClick={() => {
                const run = confirmation.run;
                setConfirmation(null);
                run();
              }}
            >
              确认
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
function TaskRow({
  task,
  view,
  project,
  open,
}: {
  task: Task;
  view?: TaskView;
  project?: string;
  open: (id: string) => void;
}) {
  return (
    <button className="task-row" onClick={() => open(task.id)}>
      <span className="task-description">
        <Icon name="file" />
        <span>
          <strong title={task.title}>{task.title}</strong>
          <small title={view?.action || task.summary}>
            {plainSummary(view?.action || task.summary || "无已记录待处理事项")}
          </small>
        </span>
      </span>
      <span className="task-project" title={project}>
        {project || "—"}
      </span>
      <span
        className={`pill ${view?.category || "other"}`}
        title={view?.stage || `记录状态：${labels[task.status]}`}
      >
        {view?.stage || `记录状态：${labels[task.status]}`}
      </span>
      <time dateTime={task.updatedAt}>{date(task.updatedAt)}</time>
    </button>
  );
}
function Empty({ title, text }: { title: string; text: string }) {
  return (
    <div className="empty">
      <div className="empty-icon">◌</div>
      <b>{title}</b>
      <p>{text}</p>
    </div>
  );
}
type DingTalkSettings = {
  clientId: string;
  robotCode: string;
  ownerId: string;
  ownerMobile: string;
  secretConfigured: boolean;
};
function DingTalkForm({
  status,
  pending,
  save,
}: {
  status: DingTalkSettings;
  pending: boolean;
  save: (data: Record<string, string>) => Promise<boolean>;
}) {
  const [saving, setSaving] = useState(false);
  const [clientId, setClientId] = useState(status.clientId);
  const [clientSecret, setClientSecret] = useState("");
  const [robotCode, setRobotCode] = useState(status.robotCode);
  const [ownerMobile, setOwnerMobile] = useState(status.ownerMobile);
  // 状态轮询不会覆盖尚未保存的输入；仅已保存字段变化时同步表单。
  useEffect(() => {
    setClientId(status.clientId);
    setRobotCode(status.robotCode);
    setOwnerMobile(status.ownerMobile);
    setClientSecret("");
  }, [
    status.clientId,
    status.robotCode,
    status.ownerMobile,
    status.secretConfigured,
  ]);
  const secretRequired =
    !status.secretConfigured || clientId.trim() !== status.clientId;
  return (
    <form
      style={{ marginBottom: 16 }}
      onSubmit={async (event) => {
        event.preventDefault();
        setSaving(true);
        try {
          if (await save({ clientId, clientSecret, robotCode, ownerMobile }))
            setClientSecret("");
        } finally {
          setSaving(false);
        }
      }}
    >
      <p className="muted">
        使用企业内部机器人，开启 Stream 模式及主动单聊权限。
      </p>
      <label>
        Client ID / AppKey
        <input
          name="dingtalk-client-id"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          required
          maxLength={256}
          disabled={pending}
          autoComplete="off"
          placeholder="在钉钉开发者后台的应用凭证中获取"
        />
      </label>
      <label>
        Client Secret / AppSecret
        <input
          name="dingtalk-client-secret"
          type="password"
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
          required={secretRequired}
          maxLength={256}
          disabled={pending}
          autoComplete="new-password"
          placeholder={
            status.secretConfigured
              ? "已保存；留空保留，填写可替换"
              : "填写应用密钥"
          }
        />
      </label>
      {status.secretConfigured && (
        <p className="muted">
          密钥已保存，不会回显。更换 AppKey 时请填写对应的新密钥。
        </p>
      )}
      <label>
        Robot Code
        <input
          name="dingtalk-robot-code"
          value={robotCode}
          onChange={(e) => setRobotCode(e.target.value)}
          required
          maxLength={256}
          disabled={pending}
          autoComplete="off"
          placeholder="机器人配置中的 Robot Code"
        />
      </label>
      <label>
        接收人手机号
        <input
          name="dingtalk-owner-mobile"
          type="tel"
          value={ownerMobile}
          onChange={(e) => setOwnerMobile(e.target.value)}
          required
          maxLength={256}
          disabled={pending}
          autoComplete="off"
          placeholder="企业通讯录中的中国大陆 11 位手机号"
        />
      </label>
      <p className="muted">
        保存时根据手机号绑定企业成员；应用需开通“根据手机号查询用户”权限。查询失败不会替换已有配置。
      </p>
      {status.ownerId && !status.ownerMobile && (
        <p className="muted">
          已有接收人绑定继续有效；下次保存请填写对应手机号。
        </p>
      )}
      <p className="muted">配置仅保存在本机。保存后自动连接，无需重启服务。</p>
      <button className="primary" disabled={pending}>
        {saving ? "正在查询并连接…" : "保存并连接"}
      </button>
    </form>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
