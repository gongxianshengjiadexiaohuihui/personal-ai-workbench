import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { executionEnv } from "../process.js";

export function diagnosticError(message: unknown): string {
  return String(message)
    .replace(/(?:https?|wss?):\/\/\S+/gi, "[endpoint]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]")
    .replace(/\b(?:sk|sess|pat)-[A-Za-z0-9_-]+\b/g, "[credential]")
    .replace(/\b(?:bearer|token|api[_-]?key|secret|password)\s*[:= ]\s*["']?[^\s,"'}]+/gi, "[credential]")
    .slice(0, 1000);
}

// 桥接使用独立客户端身份，不冒充 Desktop，也不复用其 stdin 或私有 IPC。
export class NativeRpc {
  readonly events = new EventEmitter();
  readonly child: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private buffer = "";
  private ended = false;
  private pending = new Map<number, {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();

  constructor(bin: string, args = ["app-server", "--stdio"]) {
    this.child = spawn(bin, args, { env: executionEnv(), stdio: "pipe" });
    // 上游日志可能包含地址或账户信息；只输出经过字段白名单处理的诊断结果。
    this.child.stderr.resume();
    this.child.stdin.on("error", () => this.end());
    this.child.on("error", () => this.end());
    this.child.on("exit", () => this.end());
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (part: string) => {
      this.buffer += part;
      let newline: number;
      while ((newline = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        try { this.receive(JSON.parse(line)); }
        catch { this.end(); }
      }
      if (this.buffer.length > 4_000_000) this.end();
    });
  }

  private send(message: unknown) {
    if (!this.ended && !this.child.stdin.destroyed)
      this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  private receive(message: any) {
    if (message.id !== undefined && message.method) {
      // 工具交互归 App 自己处理；外部队列桥接不能扩大权限。
      this.send({ id: message.id, error: { code: -32601, message: "Queue bridge does not authorize interactive tools" } });
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`RPC ${message.error.code ?? "error"}: ${diagnosticError(message.error.message)}`));
      else pending.resolve(message.result);
      return;
    }
    this.events.emit("notification", message);
  }

  request(method: string, params: unknown, timeoutMs = 30_000): Promise<any> {
    if (this.ended) return Promise.reject(new Error("RPC disconnected"));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  async initialize() {
    await this.request("initialize", {
      clientInfo: { name: "personal_workstation_controller", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.send({ method: "initialized" });
  }

  private end() {
    if (this.ended) return;
    this.ended = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("RPC disconnected"));
    }
    this.pending.clear();
    this.events.emit("disconnect");
  }

  close() {
    this.end();
    this.child.stdin.end();
    const timer = setTimeout(() => {
      if (this.child.exitCode === null) this.child.kill("SIGTERM");
    }, 1000);
    timer.unref();
  }
}

export async function readNativeDiagnostics(rpc: Pick<NativeRpc, "request">) {
  const diagnostics: Record<string, unknown> = {};
  // 只提取类型、功能状态和计数，不把邮箱、令牌、记忆正文或配置全文写入报告。
  for (const [name, method, params, select] of [
    ["account", "account/read", { refreshToken: false }, (r: any) => ({
      type: r.account?.type ?? "signed-out", planType: r.account?.planType ?? null,
    })],
    ["memory", "memory/status", {}, (r: any) => ({
      ready: r.v2Ready === true, consolidatedThreads: r.v2ConsolidatedThreads ?? null,
    })],
    ["projects", "project/list", { limit: 100 }, (r: any) => ({
      count: r.data?.length ?? null, supported: Array.isArray(r.data),
    })],
    ["configuration", "config/read", { includeLayers: false }, (r: any) => ({
      provider: r.config?.model_provider ?? "openai", model: r.config?.model ?? null,
    })],
  ] as const) {
    try { diagnostics[name] = { status: "available", ...select(await rpc.request(method, params)) }; }
    catch (e) { diagnostics[name] = { status: "unavailable", reason: diagnosticError(e) }; }
  }
  return diagnostics;
}
