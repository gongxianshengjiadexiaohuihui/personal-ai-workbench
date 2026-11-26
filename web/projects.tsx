import React, { useEffect, useState } from "react";
import type { Project } from "../src/domain";
import { repositoriesOf } from "../src/domain";
import type { Discovery, DiscoveredProject } from "../src/codex-projects";
import type { ImportPreview } from "../src/project-import";
type Api = (url: string, body?: unknown, method?: string) => Promise<any>;
type Member = {
  name: string;
  repoPath: string;
  baseBranch: string;
  verifyCommands: string[];
  deliveryMode: "local" | "github";
  githubRepo: string;
  runtimeKey: string;
};
const blank = (): Member => ({
  name: "",
  repoPath: "",
  baseBranch: "main",
  verifyCommands: [],
  deliveryMode: "local",
  githubRepo: "",
  runtimeKey: "",
});
function RepositoryFields({
  value,
  onChange,
  disabled = false,
  fixedPath = false,
}: {
  value: Member;
  onChange: (r: Member) => void;
  disabled?: boolean;
  fixedPath?: boolean;
}) {
  const set = (key: keyof Member, v: unknown) =>
    onChange({ ...value, [key]: v });
  return (
    <fieldset disabled={disabled} className="repository-fields">
      <div className="form-grid">
        <label>
          仓库名称
          <input
            value={value.name}
            onChange={(e) => set("name", e.target.value)}
          />
        </label>
        <label>
          目标分支
          <input
            required
            value={value.baseBranch}
            placeholder="选择已存在的本地分支"
            onChange={(e) => set("baseBranch", e.target.value)}
          />
        </label>
      </div>
      <label>
        本地 Git 仓库根目录
        <input
          required
          readOnly={fixedPath}
          value={value.repoPath}
          onChange={(e) => set("repoPath", e.target.value)}
        />
      </label>
      <label>
        交付方式
        <select
          value={value.deliveryMode}
          onChange={(e) => set("deliveryMode", e.target.value)}
        >
          <option value="local">本地确认后合并</option>
          <option value="github">GitHub PR</option>
        </select>
      </label>
      {value.deliveryMode === "github" && (
        <label>
          GitHub 仓库
          <input
            required
            value={value.githubRepo}
            placeholder="owner/repository"
            onChange={(e) => set("githubRepo", e.target.value)}
          />
        </label>
      )}
      <label>
        验证命令（每行一条）
        <textarea
          rows={3}
          value={value.verifyCommands.join("\n")}
          onChange={(e) => set("verifyCommands", e.target.value.split("\n"))}
          placeholder="确认项目适用的验证命令；留空将标记为待配置"
        />
      </label>
      <label>
        共享运行环境标识
        <input
          value={value.runtimeKey}
          onChange={(e) => set("runtimeKey", e.target.value)}
          placeholder="使用同一数据库或服务的仓库填写相同标识"
        />
      </label>
    </fieldset>
  );
}
const cleaned = (r: Member) => ({
  ...r,
  verifyCommands: r.verifyCommands.map((s) => s.trim()).filter(Boolean),
});
export function ProjectForm({
  project,
  pending,
  save,
}: {
  project: Project | null;
  pending: boolean;
  save: (data: unknown) => Promise<void>;
}) {
  const [name, setName] = useState(project?.name || ""),
    [instructions, setInstructions] = useState(project?.instructions || "");
  const [members, setMembers] = useState<Member[]>(
    project ? repositoriesOf(project) : [blank()],
  );
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save({ name, instructions, repositories: members.map(cleaned) });
      }}
    >
      <label>
        项目名称
        <input
          required
          maxLength={100}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      {members.map((r, i) => (
        <section className="import-repository" key={i}>
          <div className="section-title">
            <h3>仓库 {i + 1}</h3>
            {members.length > 1 && (
              <button
                type="button"
                disabled={pending}
                onClick={() => setMembers(members.filter((_, j) => j !== i))}
              >
                移除
              </button>
            )}
          </div>
          <RepositoryFields
            value={r}
            disabled={pending}
            onChange={(v) =>
              setMembers(members.map((x, j) => (j === i ? v : x)))
            }
          />
        </section>
      ))}
      <button
        type="button"
        disabled={pending}
        onClick={() => setMembers([...members, blank()])}
      >
        ＋ 添加仓库
      </button>
      <label>
        项目约定
        <textarea
          rows={3}
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
        />
      </label>
      <p className="muted">
        每个仓库独立执行、验证和确认合并。验证命令会运行仓库代码，请预先准备依赖；配置未完成时项目不能启动任务。
      </p>
      <button className="primary" disabled={pending}>
        保存项目
      </button>
    </form>
  );
}
type Draft = {
  name: string;
  instructions: string;
  updateId?: string;
  members: { enabled: boolean; config: Member }[];
};
export function CodexImport({
  api,
  projects,
  onImported,
  onOpenProject,
}: {
  api: Api;
  projects: Project[];
  onImported: () => Promise<void>;
  onOpenProject: (id: string) => void;
}) {
  const [discovery, setDiscovery] = useState<Discovery | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Record<string, boolean>>({}),
    [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [previews, setPreviews] = useState<ImportPreview[]>([]),
    [files, setFiles] = useState<Record<string, Record<string, string[]>>>({}),
    [done, setDone] = useState<Record<string, string>>({});
  async function scan() {
    setBusy(true);
    setError("");
    try {
      const d: Discovery = await api("/api/projects/discover");
      setDiscovery(d);
      setSelected({});
      setPreviews([]);
      setDone({});
      const next: Record<string, Draft> = {};
      for (const p of d.projects) {
        const existing = projects.find((x) => x.id === p.importedId);
        next[p.id] = {
          name: existing?.name || p.name,
          instructions: existing?.instructions || "",
          updateId: existing?.id,
          members: p.roots.map((r) => ({
            enabled: r.kind !== "invalid",
            config: {
              ...blank(),
              name: r.name,
              baseBranch: r.branch,
              verifyCommands: r.suggestedCommands,
              ...repositoriesOfSafe(existing).find(
                (x) => x.repoPath === r.repoPath || (r.repositoryId && x.repositoryId === r.repositoryId),
              ),
              repoPath: r.repoPath,
            },
          })),
        };
      }
      setDrafts(next);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void scan();
  }, []);
  function edit(id: string, patch: Partial<Draft>) {
    setDrafts((current) => ({
      ...current,
      [id]: { ...current[id], ...patch },
    }));
  }
  async function preview() {
    setBusy(true);
    setError("");
    setPreviews([]);
    setDone({});
    try {
      const list: ImportPreview[] = [],
        choices: Record<string, Record<string, string[]>> = {};
      for (const p of discovery!.projects.filter((p) => selected[p.id])) {
        const d = drafts[p.id];
        const result = await api("/api/projects/import/preview", {
          sourceId: p.id,
          name: d.name,
          instructions: d.instructions,
          updateId: d.updateId,
          repositories: d.members
            .filter((r) => r.enabled)
            .map((r) => cleaned(r.config)),
        });
        if (result.existingProjectId) continue;
        list.push(result);
        choices[result.token] = Object.fromEntries(
          result.directories
            .filter((r: any) => r.initialize)
            .map((r: any) => [
              r.repoPath,
              r.snapshot.files.map((f: any) => f.path),
            ]),
        );
      }
      setPreviews(list);
      setFiles(choices);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function confirm() {
    setBusy(true);
    setError("");
    try {
      for (const p of previews) {
        if (done[p.token]) continue;
        const result = await api("/api/projects/import/confirm", {
          token: p.token,
          selectedFiles: files[p.token],
        });
        setDone((current) => ({ ...current, [p.token]: result.project.id }));
      }
      await onImported();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      await onImported();
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel padded codex-import">
      <div className="section-title">
        <div>
          <h2>从 Codex 导入项目</h2>
          <p className="muted">
            自动发现本机项目，保留多仓库分组。勾选并确认后才注册或初始化 Git。
          </p>
        </div>
        <button disabled={busy} onClick={() => void scan()}>
          {busy ? "正在处理…" : "重新扫描"}
        </button>
      </div>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {discovery && (
        <>
          <p className="muted">
            来源：
            {discovery.source === "sqlite"
              ? "Codex 项目数据库（只读）"
              : "Codex 兼容项目列表（只读）"}{" "}
            · {discovery.projects.length} 个项目 {discovery.warning}
          </p>
          {!discovery.projects.length && (
            <p>Codex 尚未保存项目；仍可手动注册。</p>
          )}
          {!previews.length && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void preview();
              }}
            >
              {discovery.projects.map((p) => {
                const d = drafts[p.id];
                if (!d) return null;
                return (
                  <div className="import-candidate" key={p.id}>
                    <label className="check-label">
                      <input
                        type="checkbox"
                        disabled={
                          busy || !p.roots.some((r) => r.kind !== "invalid")
                        }
                        checked={!!selected[p.id]}
                        onChange={(e) =>
                          setSelected({ ...selected, [p.id]: e.target.checked })
                        }
                      />
                      <b>{p.name}</b>
                      <span>
                        {p.roots.length} 个目录 ·{" "}
                        {p.importedId ? `已导入 ${p.importedId}` : "未导入"}
                      </span>
                    </label>
                    {p.importedId && (
                      <button
                        type="button"
                        className="text-button"
                        disabled={busy}
                        onClick={() => onOpenProject(p.importedId!)}
                      >
                        打开已注册项目
                      </button>
                    )}
                    <ul className="import-roots">
                      {p.roots.map((r, i) => (
                        <li key={i}>
                          <code>{r.path}</code>{" "}
                          <span>
                            {
                              {
                                git: "Git 仓库",
                                directory: "需初始化 Git",
                                invalid: "路径不可用",
                                subdirectory: "使用所属仓库根目录",
                              }[r.kind]
                            }
                          </span>
                          {r.message && <small>{r.message}</small>}
                          {r.aliases.length > 1 && (
                            <small>合并重复目录：{r.aliases.join("、")}</small>
                          )}
                        </li>
                      ))}
                    </ul>
                    {p.importedId &&
                      (p.added.length > 0 || p.removed.length > 0) && (
                        <p className="muted">
                          目录变化：新增 {p.added.join("、") || "无"}；移除{" "}
                          {p.removed.join("、") || "无"}
                          。勾选更新后才应用，现有配置保留供确认。
                        </p>
                      )}
                    {selected[p.id] && (
                      <div className="import-config">
                        <label>
                          工作台项目名称
                          <input
                            required
                            value={d.name}
                            onChange={(e) =>
                              edit(p.id, { name: e.target.value })
                            }
                          />
                        </label>
                        {d.members.map((member, i) => (
                          <section key={i} className="import-repository">
                            <label className="check-label">
                              <input
                                type="checkbox"
                                disabled={busy || p.roots[i].kind === "invalid"}
                                checked={member.enabled}
                                onChange={(e) =>
                                  edit(p.id, {
                                    members: d.members.map((r, j) =>
                                      j === i
                                        ? { ...r, enabled: e.target.checked }
                                        : r,
                                    ),
                                  })
                                }
                              />
                              纳入 {p.roots[i].name}
                            </label>
                            {member.enabled && (
                              <>
                                <RepositoryFields
                                  value={member.config}
                                  disabled={busy}
                                  fixedPath
                                  onChange={(config) =>
                                    edit(p.id, {
                                      members: d.members.map((r, j) =>
                                        j === i ? { ...r, config } : r,
                                      ),
                                    })
                                  }
                                />
                                <p className="muted">
                                  {p.roots[i].kind === "directory"
                                    ? "将初始化 main 分支；下一步预览首次提交文件。"
                                    : `本地分支：${p.roots[i].branches.join("、") || "尚无提交"}`}
                                </p>
                              </>
                            )}
                          </section>
                        ))}
                        <label>
                          项目约定
                          <textarea
                            value={d.instructions}
                            onChange={(e) =>
                              edit(p.id, { instructions: e.target.value })
                            }
                          />
                        </label>
                      </div>
                    )}
                  </div>
                );
              })}
              <button
                className="primary"
                disabled={busy || !Object.values(selected).some(Boolean)}
              >
                预览选中项目
              </button>
            </form>
          )}
          {previews.length > 0 && (
            <div className="import-previews">
              <h3>确认导入内容</h3>
              <p>
                首次提交仅包含勾选文件。默认排除规则不等于敏感信息审计，请核对清单。
              </p>
              {previews.map((p) => (
                <section key={p.token} className="import-repository">
                  <h3>
                    {p.selection.name}{" "}
                    {done[p.token] && `· 已导入 ${done[p.token]}`}
                  </h3>
                  {p.directories.map((d) => (
                    <div key={d.repoPath}>
                      <code>{d.repoPath}</code>
                      {!d.initialize ? (
                        <p>使用现有 Git 仓库，不新增初始提交。</p>
                      ) : (
                        <>
                          <p>
                            {d.snapshot!.files.length} 个候选文件 ·{" "}
                            {(d.snapshot!.bytes / 1024).toFixed(1)} KB；创建
                            main 分支和首次提交。
                          </p>
                          <div className="import-files">
                            {d.snapshot!.files.map((f) => (
                              <label className="check-label" key={f.path}>
                                <input
                                  type="checkbox"
                                  disabled={busy || !!done[p.token]}
                                  checked={
                                    files[p.token]?.[d.repoPath]?.includes(
                                      f.path,
                                    ) || false
                                  }
                                  onChange={(e) =>
                                    setFiles((current) => ({
                                      ...current,
                                      [p.token]: {
                                        ...current[p.token],
                                        [d.repoPath]: e.target.checked
                                          ? [
                                              ...current[p.token][d.repoPath],
                                              f.path,
                                            ]
                                          : current[p.token][d.repoPath].filter(
                                              (x) => x !== f.path,
                                            ),
                                      },
                                    }))
                                  }
                                />
                                <code>{f.path}</code>
                                <small>{f.size} B</small>
                              </label>
                            ))}
                          </div>
                          <details>
                            <summary>
                              查看已排除条目（{d.snapshot!.excluded.length}）
                            </summary>
                            <ul>
                              {d.snapshot!.excluded.map((f) => (
                                <li key={f.path}>
                                  <code>{f.path}</code> — {f.reason}
                                </li>
                              ))}
                            </ul>
                          </details>
                        </>
                      )}
                    </div>
                  ))}
                </section>
              ))}
              <div className="button-row">
                <button
                  disabled={busy}
                  onClick={() => {
                    setPreviews([]);
                    setDone({});
                  }}
                >
                  返回配置
                </button>
                <button
                  className="primary"
                  disabled={busy || previews.every((p) => done[p.token])}
                  onClick={() => void confirm()}
                >
                  {previews.every((p) => done[p.token])
                    ? "导入完成"
                    : "确认导入并创建所选初始提交"}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
function repositoriesOfSafe(p?: Project) {
  return p ? repositoriesOf(p) : [];
}
