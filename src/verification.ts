import { mkdir, writeFile, realpath, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { command, executionEnv } from "./process.js";
import { git } from "./git.js";
import type { Group, Project, Evidence } from "./domain.js";
export class Verifier {
  constructor(
    public codexBin: string,
    public dataDir: string,
  ) {}
  async run(
    p: Project,
    g: Group,
    signal: AbortSignal,
    onEvidence: (e: Omit<Evidence, "id" | "createdAt" | "updatedAt">) => void,
  ) {
    const dir = path.join(this.dataDir, "artifacts", g.id);
    await mkdir(dir, { recursive: true });
    for (const [index, cmd] of p.verifyCommands.entries()) {
      if (signal.aborted) throw new Error("验证已停止");
      const logPath = path.join(dir, `verify-${Date.now()}-${index}.log`);
      let log = "";
      // 验证运行仓库代码，使用 macOS 原生沙箱限制写入和网络；不依赖 alpha CLI 的命令参数。
      if (process.platform !== "darwin")
        throw new Error("首版验证运行器仅支持 macOS，未在无沙箱模式下执行");
      const workspace = await realpath(g.worktree),
        tmp = await realpath(
          await mkdtemp(path.join(os.tmpdir(), "pai-verify-")),
        );
      const quote = (s: string) => JSON.stringify(s);
      const profile = `(version 1)(deny default)(allow file-read*)(allow process-exec)(allow process-fork)(allow sysctl-read)(allow mach-lookup)(allow signal (target same-sandbox))(allow file-write* (subpath ${quote(workspace)}) (subpath ${quote(tmp)}) (literal "/dev/null"))(deny file-write* (subpath ${quote(path.join(workspace, ".git"))}))`;
      let r;
      try {
        r = await command(
          "/usr/bin/sandbox-exec",
          ["-p", profile, "/bin/zsh", "-c", cmd],
          g.worktree,
          {
            signal,
            env: { ...executionEnv(), TMPDIR: tmp },
            timeout: 20 * 60 * 1000,
            onData: (s) => {
              log = (log + s).slice(-2_000_000);
            },
          },
        );
      } finally {
        await writeFile(logPath, log);
        await rm(tmp, { recursive: true, force: true });
      }
      onEvidence({
        groupId: g.id,
        headSha: g.headSha,
        command: cmd,
        exitCode: r.code,
        logPath,
        summary: log.slice(-6000),
        artifacts: [],
      });
      if (r.code !== 0)
        return {
          passed: false,
          feedback: `验证命令失败 (${r.code})：${cmd}\n${log.slice(-6000)}`,
        };
    }
    if (await git(g.worktree, ["status", "--porcelain"]))
      return {
        passed: false,
        feedback:
          "验证后存在未提交文件或修改。请清理构建产物、正确设置忽略项并重新验证。",
      };
    return { passed: true, feedback: "" };
  }
}
