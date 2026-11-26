import { DatabaseSync } from "node:sqlite";
import { readdir, readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspectRepository, repositoryId } from "./projects.js";
import { repositoriesOf, type Project } from "./domain.js";

export interface DiscoveredRoot {
  aliases: string[];
  path: string;
  repoPath: string;
  name: string;
  kind: "git" | "directory" | "invalid" | "subdirectory";
  repositoryId: string;
  branch: string;
  branches: string[];
  hasCommit: boolean;
  message: string;
  suggestedCommands: string[];
}
export interface DiscoveredProject {
  id: string;
  name: string;
  roots: DiscoveredRoot[];
  importedId?: string;
  added: string[];
  removed: string[];
}
export interface Discovery {
  source: "sqlite" | "legacy-json";
  warning: string;
  projects: DiscoveredProject[];
}
type SourceProject = { id: string; name: string; paths: string[] };
export class CodexProjectSource {
  constructor(
    public home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
  ) {}
  async read(): Promise<{
    source: Discovery["source"];
    warning: string;
    projects: SourceProject[];
  }> {
    const files = await readdir(this.home).catch(() => {
      throw new Error("无法读取 Codex 数据目录，请检查 CODEX_HOME");
    });
    const databases = files
      .filter((n) => /^state_\d+\.sqlite$/.test(n))
      .sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0]));
    let incompatible = false;
    for (const file of databases.slice(0, 1)) {
      let db: DatabaseSync | undefined;
      try {
        db = new DatabaseSync(path.join(this.home, file), { readOnly: true });
        db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=2000;");
        // 只读取项目名称和根目录；同一读取事务避免跨表看到迁移中的半份数据。
        db.exec("BEGIN");
        const rows = db
          .prepare("SELECT id,name FROM projects ORDER BY position,id")
          .all();
        const roots = db
          .prepare(
            "SELECT project_id,path FROM project_roots ORDER BY position",
          )
          .all();
        const projects = rows.map((r) => ({
          id: String(r.id),
          name: String(r.name),
          paths: roots
            .filter((x) => x.project_id === r.id)
            .map((x) => String(x.path)),
        }));
        db.exec("COMMIT");
        return { source: "sqlite", warning: "", projects };
      } catch {
        incompatible = true;
      } finally {
        db?.close();
      }
    }
    try {
      const data = JSON.parse(
        await readFile(
          path.join(this.home, ".codex-global-state.json"),
          "utf8",
        ),
      );
      const entries = data["local-projects"];
      if (!entries || Array.isArray(entries) || typeof entries !== "object")
        throw new Error();
      const projects = Object.entries(entries).map(([id, raw]) => {
        const p = raw as { name?: unknown; rootPaths?: unknown };
        if (
          typeof p.name !== "string" ||
          !Array.isArray(p.rootPaths) ||
          p.rootPaths.some((x) => typeof x !== "string")
        )
          throw new Error();
        return { id, name: p.name, paths: p.rootPaths as string[] };
      });
      return {
        source: "legacy-json",
        warning: incompatible
          ? "Codex 数据库不可读取或结构不兼容，使用兼容项目列表。"
          : "使用 Codex 兼容项目列表。",
        projects,
      };
    } catch {
      throw new Error(
        "Codex 项目来源不可读取或格式不兼容；可继续手动注册项目。",
      );
    }
  }
  async discover(existing: Project[] = []): Promise<Discovery> {
    const source = await this.read();
    const cache = new Map<string, Promise<DiscoveredRoot>>();
    const inspect = (p: string) => {
      if (!cache.has(p)) cache.set(p, this.inspect(p));
      return cache.get(p)!;
    };
    const projects: DiscoveredProject[] = [];
    // 有界串行探测，避免大量 git 子进程阻塞本机；同路径只检查一次。
    for (const p of source.projects) {
      const roots: DiscoveredRoot[] = [];
      for (const root of [...new Set(p.paths)]) {
        const inspected = await inspect(root);
        const match = roots.find((r) =>
          inspected.repositoryId
            ? r.repositoryId === inspected.repositoryId
            : r.repoPath === inspected.repoPath,
        );
        if (match) match.aliases.push(root);
        else roots.push({ ...inspected, aliases: [root] });
      }
      const imported = existing.find(
        (x) => x.source?.kind === "codex" && x.source.id === p.id,
      );
      const previous = imported
        ? repositoriesOf(imported).map((r) => r.repoPath)
        : [];
      const current = roots
        .filter((r) => r.kind !== "invalid")
        .map((r) => r.repoPath);
      projects.push({
        ...p,
        roots,
        importedId: imported?.id,
        added: current.filter((r) => !previous.includes(r)),
        removed: previous.filter((r) => !current.includes(r)),
      });
    }
    return { ...source, projects };
  }
  async inspect(input: string): Promise<DiscoveredRoot> {
    const base = {
      aliases: [input],
      path: input,
      repoPath: input,
      name: path.basename(input),
      repositoryId: "",
      branch: "",
      branches: [] as string[],
      hasCommit: false,
      message: "",
      suggestedCommands: [] as string[],
    };
    try {
      if (!path.isAbsolute(input)) throw new Error("仅支持本机绝对路径");
      const info = await inspectRepository(input);
      let suggestedCommands: string[] = [];
      try {
        const p = JSON.parse(
          await readFile(path.join(info.root, "package.json"), "utf8"),
        );
        const lockFiles = await readdir(info.root);
        const runner = lockFiles.includes("pnpm-lock.yaml")
          ? "pnpm"
          : lockFiles.includes("yarn.lock")
            ? "yarn"
            : "npm";
        suggestedCommands = ["check", "build"]
          .filter((k) => typeof p.scripts?.[k] === "string")
          .map((k) => `${runner} run ${k}`);
      } catch {}
      return {
        ...base,
        repoPath: info.root,
        name: path.basename(info.root),
        kind: !info.isRoot ? "subdirectory" : info.git ? "git" : "directory",
        repositoryId: info.git ? repositoryId(info.commonDir) : "",
        branch: info.branch,
        branches: info.branches,
        hasCommit: info.hasCommit,
        message: !info.isRoot
          ? `属于仓库 ${info.root}；导入使用仓库根目录`
          : !info.git
            ? "确认文件后初始化 Git"
            : !info.hasCommit
              ? "尚无初始提交"
              : "",
        suggestedCommands,
      };
    } catch (e) {
      return {
        ...base,
        kind: "invalid",
        message: e instanceof Error ? e.message : String(e),
      };
    }
  }
}
