import { createHash } from "node:crypto";
import { realpath, stat, mkdir, chmod } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { Store } from "./store.js";
import { GitService, git } from "./git.js";
import {
  projectInput,
  repositoryInput,
  repositoriesOf,
  type Project,
  type ProjectRepository,
} from "./domain.js";

export const repositoryId = (identity: string) =>
  `RE-${createHash("sha256").update(identity).digest("hex").slice(0, 24)}`;
export async function inspectRepository(repoPath: string) {
  const root = await realpath(repoPath);
  if (!(await stat(root)).isDirectory()) throw new Error("路径不是目录");
  let top: string;
  try {
    top = await git(root, ["rev-parse", "--show-toplevel"]);
  } catch {
    if (
      await git(root, ["rev-parse", "--is-bare-repository"]).then(
        (x) => x === "true",
        () => false,
      )
    )
      throw new Error("裸仓库不能作为执行目录");
    // .git 已存在但不可读/损坏时绝不当作普通目录重新初始化。
    if (
      await stat(path.join(root, ".git")).then(
        () => true,
        () => false,
      )
    )
      throw new Error("Git 元数据不可用，请先修复仓库");
    return {
      root,
      git: false as const,
      commonDir: "",
      branch: "main",
      branches: [] as string[],
      hasCommit: false,
      isRoot: true,
    };
  }
  top = await realpath(top);
  const commonDir = await realpath(
    path.resolve(root, await git(root, ["rev-parse", "--git-common-dir"])),
  );
  const branch = await git(root, ["symbolic-ref", "--short", "HEAD"]).catch(
    () => "",
  );
  const branches = (
    await git(root, [
      "for-each-ref",
      "--format=%(refname:short)",
      "refs/heads/",
    ])
  )
    .split("\n")
    .filter(Boolean);
  const hasCommit = await git(root, [
    "rev-parse",
    "--verify",
    "HEAD^{commit}",
  ]).then(
    () => true,
    () => false,
  );
  return {
    root: top,
    git: true as const,
    commonDir,
    branch,
    branches,
    hasCommit,
    isRoot: top === root,
  };
}
export class ProjectService {
  constructor(
    public store: Store,
    public gitService: GitService,
  ) {}
  async member(
    input: z.infer<typeof repositoryInput>,
  ): Promise<ProjectRepository> {
    const info = await inspectRepository(input.repoPath);
    if (!info.git) throw new Error("非 Git 目录请通过导入预览完成初始化");
    if (!info.isRoot) throw new Error(`请使用 Git 仓库根目录：${info.root}`);
    await git(info.root, ["check-ref-format", "--branch", input.baseBranch]);
    const issues: string[] = [];
    if ((info.hasCommit || info.branches.length) && !info.branches.includes(input.baseBranch))
      throw new Error("请选择有效的本地目标分支");
    if (
      !(await git(info.root, [
        "rev-parse",
        "--verify",
        `refs/heads/${input.baseBranch}^{commit}`,
      ]).then(
        () => true,
        () => false,
      ))
    )
      issues.push("目标分支没有初始提交");
    if (!input.verifyCommands.length) issues.push("请配置验证命令");
    if (input.deliveryMode === "github")
      await this.gitService.checkRemote(input);
    return {
      ...input,
      name: input.name || path.basename(info.root),
      repoPath: info.root,
      commonDir: info.commonDir,
      repositoryId: repositoryId(info.commonDir),
      issues,
    };
  }
  assertEditable(id: string) {
    if (
      this.store
        .all("tasks")
        .some(
          (t) =>
            t.projectId === id &&
            !["delivered", "cancelled"].includes(t.status),
        )
    )
      throw new Error("项目仍有未结束任务，请先完成或停止任务后修改执行配置");
  }
  async save(raw: unknown, id?: string, source?: Project["source"]) {
    const input = projectInput.parse(raw);
    if (id) this.assertEditable(id);
    const members = await Promise.all(
      input.repositories.map((r) => this.member(r)),
    );
    if (new Set(members.map((r) => r.repositoryId)).size !== members.length)
      throw new Error("同一项目不能重复包含同一仓库及其 worktree");
    return this.store.transaction(() => {
      if (id) this.assertEditable(id);
      for (const r of members)
        if (!this.store.maybe("repositories", r.repositoryId))
          this.store.create(
            "repositories",
            { repoPath: r.repoPath, commonDir: r.commonDir },
            r.repositoryId,
          );
      const value = {
        ...members[0],
        name: input.name,
        instructions: input.instructions,
        repositories: members,
        ...(source ? { source } : {}),
      };
      return id
        ? this.store.patch("projects", id, value)
        : this.store.create("projects", value);
    });
  }
  async migrate() {
    if (this.store.setting<number>("multi-repository-schema", 0) === 1) return;
    // 使用 SQLite 自身的一致性备份，包含 WAL 中的记录；备份成功才开始修改旧记录。
    const backupDir = path.join(path.dirname(this.store.file), "backups");
    await mkdir(backupDir, { recursive: true, mode: 0o700 });
    const backup = path.join(
      backupDir,
      `before-multi-repository-${Date.now()}.sqlite`,
    );
    this.store.db.prepare("VACUUM INTO ?").run(backup);
    await chmod(backup, 0o600);
    const updates = await Promise.all(
      this.store.all("projects").map(async (p) => {
        if (p.repositories) return p;
        let member: ProjectRepository;
        try {
          member = await this.member(repositoryInput.parse(p));
        } catch (e) {
          member = {
            ...repositoriesOf(p)[0],
            repositoryId: repositoryId(path.resolve(p.repoPath)),
            issues: [e instanceof Error ? e.message : String(e)],
          };
        }
        return { ...p, repositories: [member] };
      }),
    );
    this.store.transaction(() => {
      for (const p of updates) {
        this.store.put("projects", p);
        for (const r of repositoriesOf(p))
          if (!this.store.maybe("repositories", r.repositoryId))
            this.store.create(
              "repositories",
              { repoPath: r.repoPath, commonDir: r.commonDir },
              r.repositoryId,
            );
      }
      for (const g of this.store.all("groups")) {
        const p = this.store.get("projects", g.projectId);
        const r =
          repositoriesOf(p).find((r) => r.repositoryId === g.repositoryId) ??
          (repositoriesOf(p).length === 1 ? repositoriesOf(p)[0] : undefined);
        if (!r) throw new Error(`历史执行组 ${g.id} 的仓库无法确定`);
        this.store.patch("groups", g.id, {
          repositoryId: r.repositoryId,
          repository: g.repository ?? r,
        });
        for (const d of this.store
          .all("deliveries")
          .filter((d) => d.groupId === g.id))
          this.store.patch("deliveries", d.id, {
            repositoryId: r.repositoryId,
            repositoryName: r.name,
          });
      }
      this.store.setSetting("multi-repository-schema", 1);
      this.store.setSetting("multi-repository-backup", backup);
    });
  }
}
