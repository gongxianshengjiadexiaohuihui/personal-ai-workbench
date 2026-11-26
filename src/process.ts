import { spawn } from "node:child_process";
export function executionEnv() {
  // AI 和验证进程不继承钉钉/GitHub 服务凭据。Codex 自己读取已有登录配置。
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) => !/^(DINGTALK_|GITHUB_|GH_|AWS_|AZURE_|GOOGLE_)/.test(k),
    ),
  );
}
export async function command(
  bin: string,
  args: string[],
  cwd?: string,
  options: {
    input?: string | Buffer;
    signal?: AbortSignal;
    timeout?: number;
    env?: NodeJS.ProcessEnv;
    onData?: (s: string) => void;
  } = {},
) {
  return new Promise<{ stdout: string; stderr: string; code: number }>(
    (resolve, reject) => {
      const child = spawn(bin, args, {
        cwd,
        env: options.env ?? executionEnv(),
        stdio: [
          options.input === undefined ? "ignore" : "pipe",
          "pipe",
          "pipe",
        ],
        detached: process.platform !== "win32",
      });
      if (options.input !== undefined) {
        child.stdin?.on("error", () => {});
        child.stdin?.end(options.input);
      }
      let stdout = "",
        stderr = "",
        timedOut = false;
      let killTimer: NodeJS.Timeout | undefined;
      const terminate = () => {
        if (child.exitCode === null && child.pid) {
          const pid = child.pid;
          try {
            process.kill(process.platform === "win32" ? pid : -pid, "SIGTERM");
          } catch {}
          if (!killTimer)
            killTimer = setTimeout(() => {
              if (child.exitCode === null)
                try {
                  process.kill(
                    process.platform === "win32" ? pid : -pid,
                    "SIGKILL",
                  );
                } catch {}
            }, 3000);
        }
      };
      const timeout = setTimeout(() => {
        timedOut = true;
        terminate();
      }, options.timeout ?? 120000);
      const abort = () => terminate();
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
      const cleanup = () => {
        clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        options.signal?.removeEventListener("abort", abort);
      };
      child.stdout!.on("data", (b) => {
        const s = String(b);
        stdout = (stdout + s).slice(-2_000_000);
        options.onData?.(s);
      });
      child.stderr!.on("data", (b) => {
        const s = String(b);
        stderr = (stderr + s).slice(-500_000);
        options.onData?.(s);
      });
      child.once("error", (e) => {
        cleanup();
        reject(e);
      });
      child.once("exit", (code, signal) => {
        cleanup();
        if (timedOut) reject(new Error("命令执行超时"));
        else if (options.signal?.aborted) reject(new Error("操作已停止"));
        else resolve({ stdout, stderr, code: code ?? (signal ? 130 : 1) });
      });
    },
  );
}
export async function checked(
  bin: string,
  args: string[],
  cwd?: string,
  options: Parameters<typeof command>[3] = {},
) {
  const r = await command(bin, args, cwd, options);
  if (r.code !== 0)
    throw new Error(
      `${bin} 执行失败 (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`,
    );
  return r.stdout.trim();
}
