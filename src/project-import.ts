import { createHash, randomUUID } from "node:crypto";
import {
  readFile,
  readdir,
  lstat,
  realpath,
  mkdtemp,
  rm,
  writeFile,
  appendFile,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import { CodexProjectSource } from "./codex-projects.js";
import { ProjectService, inspectRepository } from "./projects.js";
import { repositoryInput } from "./domain.js";
import { git } from "./git.js";
import { command, checked, executionEnv } from "./process.js";

const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const defaultIgnored = [
  ".env",
  ".env.*",
  ".data/",
  ".codex/",
  ".ssh/",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "id_rsa*",
  "id_ed25519*",
  "credentials*",
  "auth.json",
  ".npmrc",
  ".netrc",
  "node_modules/",
  ".venv/",
  "venv/",
  "__pycache__/",
  "dist/",
  "build/",
  "target/",
  ".cache/",
  ".DS_Store",
];
// Git 的 .gitignore 否定规则优先于 info/exclude；默认敏感/生成文件规则必须另外核对。
function isDefaultExcluded(relative: string, directory: boolean) {
  const parts = relative.split("/");
  return defaultIgnored.some((pattern) => {
    const directoriesOnly = pattern.endsWith("/");
    const name = directoriesOnly ? pattern.slice(0, -1) : pattern;
    const matcher = new RegExp("^" + name.split("*").map((part) =>
      part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    ).join(".*") + "$");
    return parts.some((part, index) =>
      (!directoriesOnly || directory || index < parts.length - 1) && matcher.test(part)
    );
  });
}
export interface ImportFile {
  path: string;
  size: number;
  hash: string;
  mode: string;
}
export interface DirectorySnapshot {
  root: string;
  identity: string;
  files: ImportFile[];
  excluded: { path: string; reason: string }[];
  hash: string;
  bytes: number;
}
const previewInput = z.object({
  sourceId: z.string().min(1),
  name: z.string().trim().min(1).max(100),
  instructions: z.string().default(""),
  updateId: z.string().optional(),
  repositories: z.array(repositoryInput).min(1).max(32),
});
type Selection = z.infer<typeof previewInput>;
export interface ImportPreview {
  token: string;
  selection: Selection;
  directories: {
    repoPath: string;
    initialize: boolean;
    snapshot?: DirectorySnapshot;
  }[];
  state: "preview" | "running" | "failed" | "complete";
  selected?: Record<string, string[]>;
  progress: Record<string, { initialized?: boolean; commit?: string }>;
  projectId?: string;
  error?: string;
}

export async function snapshotDirectory(
  input: string,
): Promise<DirectorySnapshot> {
  const root = await realpath(input),
    info = await lstat(root);
  if (!info.isDirectory()) throw new Error("导入路径不是目录");
  const temp = await mkdtemp(path.join(os.tmpdir(), "pai-import-list-"));
  try {
    // 临时 Git 元数据只用于解释嵌套 .gitignore；预览不在用户目录中创建 .git。
    await git(temp, ["init", "-q"]);
    await writeFile(
      path.join(temp, ".git/info/exclude"),
      defaultIgnored.join("\n") + "\n",
    );
    const args = [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      `--git-dir=${path.join(temp, ".git")}`,
      `--work-tree=${root}`,
    ];
    const listingResult = await command(
      "git",
      [...args, "ls-files", "--others", "--exclude-standard", "-z"],
      root,
    );
    if (listingResult.code) throw new Error("无法生成 Git 文件清单");
    const listing = listingResult.stdout;
    if (listing.length > 1_900_000)
      throw new Error("目录文件清单过大，请缩小导入范围后重试");
    const eligible = new Set(listing.split("\0").filter(Boolean));
    const ignoredResult = await command(
      "git",
      [
        ...args,
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--directory",
        "-z",
      ],
      root,
    );
    if (ignoredResult.code) throw new Error("无法读取 Git 忽略规则");
    const ignoredListing = ignoredResult.stdout;
    if (ignoredListing.length > 1_900_000)
      throw new Error("忽略清单过大，请缩小导入范围");
    const ignored = new Set(ignoredListing.split("\0").filter(Boolean));
    const files: ImportFile[] = [],
      excluded: DirectorySnapshot["excluded"] = [];
    let visited = 0;
    async function walk(relative: string) {
      for (const name of (await readdir(path.join(root, relative))).sort()) {
        if (name === ".git") continue;
        if (++visited > 10000)
          throw new Error("预览最多处理 10000 个条目，请拆分目录后重试");
        const rel = relative ? `${relative}/${name}` : name,
          full = path.join(root, rel);
        const stat = await lstat(full);
        if (stat.isSymbolicLink()) {
          excluded.push({ path: rel, reason: "符号链接不纳入首次提交" });
          continue;
        }
        if (isDefaultExcluded(rel, stat.isDirectory()) || ignored.has(rel) || ignored.has(rel + "/")) {
          excluded.push({
            path: rel,
            reason: "现有忽略规则或默认敏感/生成文件排除规则",
          });
          continue;
        }
        if (stat.isDirectory()) {
          if (
            await lstat(path.join(full, ".git")).then(
              () => true,
              () => false,
            )
          ) {
            excluded.push({ path: rel, reason: "嵌套 Git 仓库" });
            continue;
          }
          await walk(rel);
          continue;
        }
        if (!stat.isFile() || !eligible.has(rel)) {
          excluded.push({ path: rel, reason: "非普通文件或忽略规则" });
          continue;
        }
        if (stat.size > 100 * 1024 * 1024)
          throw new Error(`文件过大，无法预览：${rel}（单文件上限 100 MB）`);
        files.push({
          path: rel,
          size: stat.size,
          mode: stat.mode & 0o111 ? "100755" : "100644",
          hash: digest(await readFile(full)),
        });
      }
    }
    await walk("");
    const identity = `${info.dev}:${info.ino}`;
    return {
      root,
      identity,
      files,
      excluded,
      hash: digest(JSON.stringify({ root, identity, files, excluded })),
      bytes: files.reduce((n, f) => n + f.size, 0),
    };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
const literalIgnore = (file: string) =>
  "/" + file.replace(/[\\*?\[\]#! ]/g, "\\$&");
export class ProjectImporter {
  busy = false;
  constructor(
    public projects: ProjectService,
    public source = new CodexProjectSource(),
  ) {}
  async preview(raw: unknown) {
    const selection = previewInput.parse(raw);
    const source = await this.source.discover(
      this.projects.store.all("projects"),
    );
    const candidate = source.projects.find((p) => p.id === selection.sourceId);
    if (!candidate) throw new Error("Codex 项目已不存在，请重新扫描");
    if (selection.updateId) {
      this.projects.assertEditable(selection.updateId);
      if (candidate.importedId !== selection.updateId)
        throw new Error("更新项目与 Codex 来源不匹配");
    } else if (candidate.importedId)
      return { existingProjectId: candidate.importedId };
    const directories: ImportPreview["directories"] = [];
    for (const r of selection.repositories) {
      r.repoPath = await realpath(r.repoPath);
      if (
        !candidate.roots.some(
          (x) => x.kind !== "invalid" && x.repoPath === r.repoPath,
        )
      )
        throw new Error("导入目录不属于所选 Codex 项目，请重新扫描");
      if (directories.some((x) => x.repoPath === r.repoPath))
        throw new Error("不能重复选择同一目录");
      const info = await inspectRepository(r.repoPath);
      if (!info.isRoot) throw new Error(`请使用仓库根目录：${info.root}`);
      const initialize = !info.git;
      if (initialize && r.baseBranch !== "main")
        throw new Error("新初始化的仓库目标分支应为 main");
      if (initialize && r.deliveryMode !== "local")
        throw new Error("非 Git 目录首次导入请使用本地交付");
      directories.push({
        repoPath: r.repoPath,
        initialize,
        ...(initialize
          ? { snapshot: await snapshotDirectory(r.repoPath) }
          : {}),
      });
    }
    const preview: ImportPreview = {
      token: randomUUID(),
      selection,
      directories,
      state: "preview",
      progress: {},
    };
    this.projects.store.setSetting(`import:${preview.token}`, preview);
    return preview;
  }
  async confirm(raw: unknown) {
    const { token, selectedFiles } = z
      .object({
        token: z.string().uuid(),
        selectedFiles: z.record(z.string(), z.array(z.string())).default({}),
      })
      .parse(raw);
    if (this.busy) throw new Error("已有导入正在处理，请稍候重试");
    const key = `import:${token}`,
      store = this.projects.store;
    const preview = store.setting<ImportPreview | null>(key, null);
    if (!preview) throw new Error("预览不存在，请重新预览");
    if (preview.state === "complete")
      return {
        project: store.get("projects", preview.projectId!),
        message: "该项目已导入",
      };
    const selected: Record<string, string[]> = {};
    for (const d of preview.directories.filter((d) => d.initialize)) {
      const chosen = [...new Set(selectedFiles[d.repoPath] ?? [])].sort();
      if (chosen.some((f) => !d.snapshot!.files.some((x) => x.path === f)))
        throw new Error("选择包含未预览的文件");
      selected[d.repoPath] = chosen;
    }
    if (
      preview.selected &&
      JSON.stringify(preview.selected) !== JSON.stringify(selected)
    )
      throw new Error("已开始的导入不能修改文件选择，请重新预览");
    this.busy = true;
    try {
      if (preview.selection.updateId)
        this.projects.assertEditable(preview.selection.updateId);
      const existing = store
        .all("projects")
        .find(
          (p) =>
            p.source?.id === preview.selection.sourceId &&
            p.source.kind === "codex",
        );
      if (existing && !preview.selection.updateId) {
        preview.state = "complete";
        preview.projectId = existing.id;
        store.setSetting(key, preview);
        return { project: existing, message: "该项目已导入" };
      }
      // 先核对所有初始快照，再做任何目录写入。跨目录 Git 操作不可事务回滚，逐步持久化进度用于恢复。
      for (const d of preview.directories.filter((d) => d.initialize)) {
        const current = await snapshotDirectory(d.repoPath);
        if (current.hash !== d.snapshot!.hash)
          throw new Error(`目录内容已变化，请重新预览：${d.repoPath}`);
      }
      preview.selected = selected;
      preview.state = "running";
      store.setSetting(key, preview);
      for (const d of preview.directories.filter((d) => d.initialize))
        await this.initialize(preview, d, key);
      const project = await this.projects.save(
        preview.selection,
        preview.selection.updateId,
        { kind: "codex", id: preview.selection.sourceId },
      );
      preview.state = "complete";
      preview.projectId = project.id;
      preview.error = "";
      store.setSetting(key, preview);
      return { project, message: "项目已导入；配置完整的项目可开始执行任务" };
    } catch (e) {
      preview.state = "failed";
      preview.error = e instanceof Error ? e.message : String(e);
      store.setSetting(key, preview);
      throw new Error(
        `${preview.error}。已完成的 Git 初始化保留，可核对后重试。`,
      );
    } finally {
      this.busy = false;
    }
  }
  private async initialize(
    preview: ImportPreview,
    d: ImportPreview["directories"][number],
    key: string,
  ) {
    const store = this.projects.store,
      progress = (preview.progress[d.repoPath] ??= {}),
      root = d.repoPath;
    const info = await inspectRepository(root);
    if (info.git && !progress.initialized)
      throw new Error("目录已被其他操作初始化，请重新预览");
    if (!info.git) {
      await git(root, ["init", "-b", "main"]);
      progress.initialized = true;
      store.setSetting(key, preview);
    }
    const head = await git(root, ["rev-parse", "--verify", "HEAD"]).catch(
      () => "",
    );
    if (head) {
      if (head === progress.commit) return;
      throw new Error("仓库已有其他提交，停止初始化");
    }
    const expectedIndex: string[] = [];
    // 创建 blob 时直接读取并核对确认过的内容，禁用属性过滤器；不使用 git add .。
    for (const file of d.snapshot!.files.filter((f) =>
      preview.selected![root].includes(f.path),
    )) {
      const full = path.join(root, file.path),
        stat = await lstat(full);
      if (!stat.isFile() || (await realpath(full)) !== full)
        throw new Error("文件路径已变化，请重新预览");
      const bytes = await readFile(full);
      if (
        digest(bytes) !== file.hash ||
        (stat.mode & 0o111 ? "100755" : "100644") !== file.mode
      )
        throw new Error("文件内容已变化，请重新预览");
      const oid = await checked(
        "git",
        [
          "-c",
          "core.hooksPath=/dev/null",
          "hash-object",
          "-w",
          "--no-filters",
          "--stdin",
        ],
        root,
        { input: bytes },
      );
      expectedIndex.push(`${file.mode} ${oid} 0\t${file.path}`);
      await git(root, [
        "update-index",
        "--add",
        "--cacheinfo",
        file.mode,
        oid,
        file.path,
      ]);
    }
    const stagedResult = await command(
      "git",
      ["ls-files", "--stage", "-z"],
      root,
    );
    const staged = stagedResult.stdout.split("\0").filter(Boolean).sort();
    if (
      stagedResult.code ||
      JSON.stringify(staged) !== JSON.stringify(expectedIndex.sort())
    )
      throw new Error("暂存区与确认清单不一致，停止首次提交");
    if ((await snapshotDirectory(root)).hash !== d.snapshot!.hash)
      throw new Error("提交前目录内容已变化，请重新预览");
    // 共享 info/exclude 让未选择文件在后续 worktree/交付检查中保持未纳入，不改写用户的 .gitignore。
    const exclusions = [
      ...defaultIgnored,
      ...d
        .snapshot!.files.filter(
          (f) => !preview.selected![root].includes(f.path),
        )
        .map((f) => literalIgnore(f.path)),
      ...d.snapshot!.excluded.map((f) => literalIgnore(f.path)),
    ];
    await appendFile(
      path.join(root, ".git/info/exclude"),
      "\n# Personal AI Workbench import\n" + exclusions.join("\n") + "\n",
    );
    const tree = await git(root, ["write-tree"]);
    if (!progress.commit) {
      progress.commit = await checked(
        "git",
        [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "commit.gpgsign=false",
          "commit-tree",
          tree,
        ],
        root,
        {
          input: `Initialize repository for Personal AI Workbench\n\nImport: ${preview.token}\n`,
          env: {
            ...executionEnv(),
            GIT_AUTHOR_NAME: "Personal AI Workbench",
            GIT_AUTHOR_EMAIL: "workbench@localhost",
            GIT_COMMITTER_NAME: "Personal AI Workbench",
            GIT_COMMITTER_EMAIL: "workbench@localhost",
          },
        },
      );
      store.setSetting(key, preview);
    }
    if ((await git(root, ["rev-parse", `${progress.commit}^{tree}`])) !== tree)
      throw new Error("首次提交树与确认清单不一致");
    await git(root, [
      "update-ref",
      "refs/heads/main",
      progress.commit,
      "0000000000000000000000000000000000000000",
    ]);
  }
}
