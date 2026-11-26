import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexAdapter } from "../src/adapters/codex.js";
const cwd = await mkdtemp(path.join(os.tmpdir(), "pai-codex-probe-"));
const adapter = new CodexAdapter(
  process.env.CODEX_BIN || "/usr/local/bin/codex",
  process.env.CODEX_MODEL || undefined,
);
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 120000);
try {
  const result = await adapter.start({
    cwd,
    role: "controller",
    schema: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
      additionalProperties: false,
    },
    prompt:
      "这是只读接入验证。不要使用工具、读文件或运行命令。只返回 JSON，其中 message 为 codex-connected。",
    signal: controller.signal,
    onSession: (id) => console.log(`会话已建立：${id}`),
  });
  const output = JSON.parse(result.output);
  if (output.message !== "codex-connected")
    throw new Error("结构化输出与预期不符");
  const observed: any = await adapter.observe(result.sessionId, cwd);
  if (observed.thread?.id !== result.sessionId) throw new Error("会话读取失败");
  const resumed = await adapter.resume({
    cwd,
    role: "controller",
    sessionId: result.sessionId,
    schema: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
      additionalProperties: false,
    },
    prompt:
      "继续只读接入验证。不要使用工具，返回 JSON，其中 message 为 codex-resumed。",
    signal: controller.signal,
    onSession: (id) => {
      if (id !== result.sessionId) throw new Error("恢复后会话标识变化");
    },
  });
  if (JSON.parse(resumed.output).message !== "codex-resumed")
    throw new Error("恢复会话输出不正确");
  console.log(
    JSON.stringify({
      result: "Codex 真实请求、会话读取和同一会话恢复通过",
      sessionId: result.sessionId,
      turnId: result.turnId,
      output,
    }),
  );
} finally {
  clearTimeout(timeout);
}
