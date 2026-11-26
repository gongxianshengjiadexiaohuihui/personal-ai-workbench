import path from "node:path";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { checked, command, executionEnv } from "./process.js";
import type { Project, Group, Delivery } from "./domain.js";
export const git = (cwd: string, args: string[]) =>
  checked("git", ["-c", "core.hooksPath=/dev/null", ...args], cwd);
export class GitService {
  constructor(public dataDir: string) {}
  async validateProject(
    project: Pick<
      Project,
      "repoPath" | "baseBranch" | "deliveryMode" | "githubRepo"
    >,
  ) {
    const root = await realpath(project.repoPath);
    const actual = await git(root, ["rev-parse", "--show-toplevel"]);
    if ((await realpath(actual)) !== root)
      throw new Error("请使用 Git 仓库根目录");
    await git(root, ["check-ref-format", "--branch", project.baseBranch]);
    await git(root, [
      "rev-parse",
      "--verify",
      `refs/heads/${project.baseBranch}^{commit}`,
    ]);
    if (project.deliveryMode === "github")
      await this.checkRemote({ ...project, repoPath: root });
    return root;
  }
  async checkRemote(p: Pick<Project, "repoPath" | "githubRepo">) {
    const remote = await git(p.repoPath, [
      "remote",
      "get-url",
      "--push",
      "origin",
    ]);
    const match = remote.match(
      /^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?$/,
    );
    if (!match || match[1].toLowerCase() !== p.githubRepo.toLowerCase())
      throw new Error("origin 推送地址与配置的 GitHub 仓库不一致");
  }
  async prepare(p: Project, g: Group) {
    const branch = `codex/pai-${g.id.toLowerCase()}`;
    const worktree = path.join(this.dataDir, "worktrees", g.id);
    await mkdir(path.dirname(worktree), { recursive: true });
    if (p.deliveryMode === "github") {
      await this.checkRemote(p);
      await git(p.repoPath, ["fetch", "origin", p.baseBranch]);
    }
    const base =
      p.deliveryMode === "github"
        ? `refs/remotes/origin/${p.baseBranch}`
        : `refs/heads/${p.baseBranch}`;
    const baseSha = await git(p.repoPath, [
      "rev-parse",
      "--verify",
      `${base}^{commit}`,
    ]);
    if (g.worktree) {
      // 同一仓库的前一组已交付时，把新基线正常合并进执行分支并重新验收，不改写已有提交。
      if (baseSha !== g.baseSha) {
        const merge = await command(
          "git",
          [
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "user.name=Personal AI Workbench",
            "-c",
            "user.email=workbench@localhost",
            "merge",
            "--no-edit",
            baseSha,
          ],
          g.worktree,
        );
        if (merge.code !== 0) {
          const conflicts = await git(g.worktree, [
            "diff",
            "--name-only",
            "--diff-filter=U",
          ]);
          if (!conflicts)
            throw new Error(
              `整合目标分支失败：${merge.stderr || merge.stdout}`,
            );
          return {
            worktree: g.worktree,
            branch: g.branch,
            baseSha,
            feedback: `${g.feedback}\n目标分支已推进，服务已发起合并。请解决这些文件的冲突，仅编辑文件，由服务提交：\n${conflicts}`,
          };
        }
      }
      return { worktree: g.worktree, branch: g.branch, baseSha };
    }
    await git(p.repoPath, ["worktree", "add", "-b", branch, worktree, baseSha]);
    return { worktree, branch, baseSha };
  }
  async snapshot(g: Group) {
    await git(g.worktree, ["add", "--all"]);
    const changed = await git(g.worktree, ["diff", "--cached", "--name-only"]);
    const merging = await command(
      "git",
      ["rev-parse", "--verify", "MERGE_HEAD"],
      g.worktree,
    );
    if (changed || merging.code === 0)
      await git(g.worktree, [
        "-c",
        "user.name=Personal AI Workbench",
        "-c",
        "user.email=workbench@localhost",
        "commit",
        "-m",
        `Implement: ${g.title.slice(0, 150)}`,
      ]);
    const sha = await git(g.worktree, ["rev-parse", "HEAD"]);
    if (sha === g.baseSha)
      throw new Error("没有代码变更；请检查任务范围与执行结果");
    return sha;
  }
  async diff(g: Group) {
    return git(g.worktree, ["diff", "--stat", g.baseSha, g.headSha || "HEAD"]);
  }
  async propose(
    p: Project,
    g: Group,
    summary: string,
  ): Promise<Omit<Delivery, "id" | "createdAt" | "updatedAt">> {
    const common = {
      groupId: g.id,
      repositoryId: g.repositoryId,
      repositoryName: g.repository?.name || p.name,
      requestId: g.requestId,
      mode: p.deliveryMode,
      repo: p.deliveryMode === "github" ? p.githubRepo : p.repoPath,
      base: p.baseBranch,
      baseSha: g.baseSha,
      branch: g.branch,
      headSha: g.headSha,
      token: randomBytes(6).toString("hex"),
      status: "pending" as const,
      approvedAt: null,
      mergeSha: null,
    };
    if (p.deliveryMode === "local") return { ...common, url: "", number: 0 };
    await this.checkRemote(p);
    await git(g.worktree, [
      "push",
      "origin",
      `${g.headSha}:refs/heads/${g.branch}`,
    ]);
    const existing = JSON.parse(
      await checked(
        "gh",
        [
          "pr",
          "list",
          "--repo",
          p.githubRepo,
          "--head",
          g.branch,
          "--state",
          "open",
          "--json",
          "number,url,headRefOid,baseRefName",
        ],
        g.worktree,
      ),
    );
    if (existing.length > 1) throw new Error("存在多个匹配 PR，需要人工确认");
    if (existing.length === 1) {
      if (existing[0].baseRefName !== p.baseBranch)
        throw new Error("已有 PR 的目标分支不一致");
      return { ...common, url: existing[0].url, number: existing[0].number };
    }
    const bodyFile = path.join(this.dataDir, "artifacts", `${g.id}-pr.md`);
    await mkdir(path.dirname(bodyFile), { recursive: true });
    await writeFile(
      bodyFile,
      `${summary}\n\n提交：${g.headSha}\n\n完成条件：\n${g.criteria.map((c) => `- ${c}`).join("\n")}\n\n验证命令：\n${p.verifyCommands.map((c) => `- \`${c}\``).join("\n")}\n\n由个人 AI 工作系统准备；等待用户确认后合并。\n`,
    );
    const url = await checked(
      "gh",
      [
        "pr",
        "create",
        "--repo",
        p.githubRepo,
        "--base",
        p.baseBranch,
        "--head",
        g.branch,
        "--title",
        g.title,
        "--body-file",
        bodyFile,
      ],
      g.worktree,
    );
    const pr = await this.pr(p, url);
    return { ...common, url: pr.url, number: pr.number };
  }
  async pr(p: Project, id: string | number) {
    return JSON.parse(
      await checked(
        "gh",
        [
          "pr",
          "view",
          String(id),
          "--repo",
          p.githubRepo,
          "--json",
          "number,url,headRefOid,baseRefName,state,mergedAt,mergeCommit,mergeable",
        ],
        p.repoPath,
      ),
    );
  }
  async validateDelivery(p: Project, g: Group, d: Delivery) {
    if ((await git(g.worktree, ["rev-parse", "HEAD"])) !== d.headSha)
      throw new Error("交付版本已变化，请重新验证和确认");
    if (await git(g.worktree, ["status", "--porcelain"]))
      throw new Error("执行 worktree 存在未提交修改，请重新验证");
    if (p.deliveryMode === "local") {
      if (
        (await git(p.repoPath, ["symbolic-ref", "--short", "HEAD"])) !== d.base
      )
        throw new Error(`请先在本地仓库检出 ${d.base} 分支`);
      if (await git(p.repoPath, ["status", "--porcelain"]))
        throw new Error("本地目标工作区有未提交修改，未执行合并");
      if ((await git(p.repoPath, ["rev-parse", "HEAD"])) !== d.baseSha)
        throw new Error("目标分支已经变化，请重新基于当前版本执行和验收");
    } else {
      await this.checkRemote(p);
      const pr = await this.pr(p, d.number);
      if (
        pr.headRefOid !== d.headSha ||
        pr.baseRefName !== d.base ||
        pr.state !== "OPEN"
      )
        throw new Error("PR 状态、目标分支或提交已变化");
      if (pr.mergeable !== "MERGEABLE") throw new Error("PR 尚不可合并");
      const required = await command(
        "gh",
        [
          "pr",
          "checks",
          String(d.number),
          "--repo",
          p.githubRepo,
          "--required",
          "--json",
          "name,state,bucket",
        ],
        p.repoPath,
      );
      // gh 无必需检查时可能返回非零；只接受明确的无检查结果，其他错误不能当作通过。
      if (
        required.code !== 0 &&
        !/no (required )?checks reported/i.test(
          required.stderr + required.stdout,
        )
      )
        throw new Error(
          `必需 CI 未通过：${required.stderr || required.stdout}`,
        );
      if (
        required.code === 0 &&
        JSON.parse(required.stdout || "[]").some(
          (c: any) => c.bucket !== "pass",
        )
      )
        throw new Error("必需 CI 尚未全部通过");
      await git(p.repoPath, ["fetch", "origin", d.base]);
      if (
        (await git(p.repoPath, [
          "rev-parse",
          `refs/remotes/origin/${d.base}`,
        ])) !== d.baseSha
      )
        throw new Error("远端目标分支已变化，需要重新验证");
    }
  }
  async merge(p: Project, g: Group, d: Delivery) {
    await this.validateDelivery(p, g, d);
    if (d.mode === "local") {
      await git(p.repoPath, [
        "merge",
        "--no-ff",
        d.headSha,
        "-m",
        `Merge approved AI task ${g.id}`,
      ]);
      await git(p.repoPath, ["merge-base", "--is-ancestor", d.headSha, "HEAD"]);
      return git(p.repoPath, ["rev-parse", "HEAD"]);
    }
    await checked(
      "gh",
      [
        "pr",
        "merge",
        String(d.number),
        "--repo",
        p.githubRepo,
        "--merge",
        "--match-head-commit",
        d.headSha,
      ],
      p.repoPath,
    );
    const pr = await this.pr(p, d.number);
    if (pr.state !== "MERGED") throw new Error("GitHub 尚未确认合并");
    await git(p.repoPath, ["fetch", "origin", d.base]);
    await git(p.repoPath, [
      "merge-base",
      "--is-ancestor",
      d.headSha,
      `refs/remotes/origin/${d.base}`,
    ]);
    return pr.mergeCommit.oid;
  }
  async reconcile(p: Project, d: Delivery): Promise<string | null> {
    if (d.mode === "github") {
      const pr = await this.pr(p, d.number);
      if (pr.state === "MERGED" && pr.headRefOid === d.headSha) {
        await git(p.repoPath, ["fetch", "origin", d.base]);
        await git(p.repoPath, [
          "merge-base",
          "--is-ancestor",
          d.headSha,
          `refs/remotes/origin/${d.base}`,
        ]);
        return pr.mergeCommit.oid;
      }
      return null;
    }
    const r = await command(
      "git",
      ["merge-base", "--is-ancestor", d.headSha, `refs/heads/${d.base}`],
      p.repoPath,
    );
    return r.code === 0
      ? git(p.repoPath, ["rev-parse", `refs/heads/${d.base}`])
      : null;
  }
}
