import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { Store } from "../src/store.js";
import { GitService, git } from "../src/git.js";
import { Verifier } from "../src/verification.js";
import { Engine } from "../src/engine.js";
import { CodexAdapter } from "../src/adapters/codex.js";
import { DingTalkChannel } from "../src/channels/dingtalk.js";
import { buildServer } from "../src/server.js";
import type { AgentAdapter, AgentInput } from "../src/adapters/agent.js";

const live = process.env.VERIFY_AGENT === "codex";
const parent = path.resolve(".data", "verification");
await mkdir(parent, { recursive: true });
const root = await mkdtemp(path.join(parent, live ? "live-" : "fixture-")),
  repo = path.join(root, "repo"),
  dataDir = path.join(root, "data");
await mkdir(repo, { recursive: true });
await git(repo, ["init", "-b", "main"]);
await git(repo, ["config", "user.name", "Workbench Verification"]);
await git(repo, ["config", "user.email", "verify@localhost"]);
await writeFile(
  path.join(repo, "math.mjs"),
  "export const add = (a, b) => a - b;\n",
);
await git(repo, ["add", "."]);
await git(repo, [
  "commit",
  "-m",
  "Create deliberately failing acceptance fixture",
]);
const base = await git(repo, ["rev-parse", "HEAD"]);
class ScriptedAgent implements AgentAdapter {
  counter = 0;
  capabilities() {
    return {
      id: "scripted-verification-only",
      resume: true,
      interrupt: true,
      structuredOutput: true,
    };
  }
  async start(input: AgentInput) {
    const sessionId = input.sessionId || `fixture-${++this.counter}`,
      turnId = `turn-${this.counter}`;
    input.onSession(sessionId);
    input.onTurn?.(turnId);
    let output;
    if (input.role === "controller")
      output = {
        action: "plan",
        summary: "直接验证用脚本计划，不是模型输出",
        question: "",
        groups: [
          {
            key: "math",
            title: "修复加法函数",
            goal: "math.mjs 的 add 应当求和",
            criteria: ["add(2, 3) 等于 5", "add(-1, 1) 等于 0"],
            dependsOn: [],
            tasks: [
              {
                title: "修复 add",
                goal: "将减法修正为加法",
                criteria: ["加法断言通过"],
              },
            ],
          },
        ],
      };
    else if (input.role === "executor") {
      await writeFile(
        path.join(input.cwd, "math.mjs"),
        "export const add = (a, b) => a + b;\n",
      );
      output = {
        summary: "脚本执行器修正了运算符；非真实 AI 开发结果",
        blocked: false,
        question: "",
        artifacts: [],
      };
    } else
      output = {
        decision: "pass",
        summary: "脚本验收：客观断言已由独立命令运行",
        feedback: "",
        artifacts: [],
      };
    return { sessionId, turnId, output: JSON.stringify(output), usage: null };
  }
  resume(input: AgentInput & { sessionId: string }) {
    return this.start(input);
  }
  async observe(sessionId: string) {
    return { thread: { id: sessionId, turns: [] } };
  }
  async interrupt() {}
}
const config = {
  port: 48761,
  maxConcurrent: 2,
  dataDir,
  codexBin: process.env.CODEX_BIN || "/usr/local/bin/codex",
  model: process.env.CODEX_MODEL || undefined,
  dingtalk: { clientId: "", clientSecret: "", robotCode: "", ownerId: "" },
};
const store = new Store(path.join(dataDir, "workbench.sqlite"));
const adapter = live
  ? new CodexAdapter(config.codexBin, config.model)
  : new ScriptedAgent();
const engine = new Engine(
  store,
  adapter,
  new GitService(dataDir),
  new Verifier(config.codexBin, dataDir),
  dataDir,
);
const channel = new DingTalkChannel(config.dingtalk, store, (text, id) =>
  engine.handleMessage(text, id),
);
const app = await buildServer(engine, channel, config);
const host = { host: "127.0.0.1:48761" };
const csrf = (await app.inject({ url: "/api/session", headers: host })).json()
  .token;
const headers = { ...host, "x-workbench-token": csrf };
const results: string[] = [];
try {
  await engine.start();
  const bad = await app.inject({
    method: "POST",
    url: "/api/projects",
    headers: host,
    payload: {},
  });
  assert.equal(bad.statusCode, 403);
  results.push("本地写操作需要工作台令牌");
  const pResponse = await app.inject({
    method: "POST",
    url: "/api/projects",
    headers,
    payload: {
      name: live ? "真实 Codex 本地验收项目" : "脚本执行器验收夹具",
      repoPath: repo,
      baseBranch: "main",
      deliveryMode: "local",
      githubRepo: "",
      verifyCommands: [
        `"${process.execPath}" --input-type=module -e 'import assert from "node:assert/strict"; import {add} from "./math.mjs"; assert.equal(add(2,3),5); assert.equal(add(-1,1),0); console.log("2 arithmetic assertions passed")'`,
      ],
      instructions:
        "这是隔离的验收仓库。只修正 math.mjs 中 add 的加法行为，修改一个运算符即可；不新增文件，不访问外部网络，不提交 Git。",
    },
  });
  assert.equal(pResponse.statusCode, 200, pResponse.body);
  const project = pResponse.json();
  results.push("通过真实 API 注册本地 Git 项目");
  const response = await app.inject({
    method: "POST",
    url: "/api/tasks",
    headers,
    payload: {
      projectId: project.id,
      title: "修正加法函数并验证",
      goal: "math.mjs 中 add 误写成减法。只修改该文件让 add(2,3)=5、add(-1,1)=0，验证通过后准备本地交付。无需向我追问。",
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  const task = response.json();
  console.log(
    JSON.stringify({
      mode: live ? "真实 Codex" : "脚本执行器（非真实 AI）",
      root,
      taskId: task.id,
    }),
  );
  const deadline = Date.now() + (live ? 15 * 60 * 1000 : 30000);
  let last = "";
  while (Date.now() < deadline) {
    const t = store.get("tasks", task.id);
    if (t.status !== last) {
      last = t.status;
      console.log(`任务状态：${last}`);
    }
    if (t.status === "awaiting_approval") break;
    if (t.status === "blocked")
      throw new Error(
        JSON.stringify(
          store
            .all("events")
            .filter((e) => e.taskId === task.id)
            .slice(-3),
        ),
      );
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.equal(
    store.get("tasks", task.id).status,
    "awaiting_approval",
    "任务必须生成待确认交付",
  );
  assert.equal(await git(repo, ["rev-parse", "HEAD"]), base);
  assert.match(await readFile(path.join(repo, "math.mjs"), "utf8"), /a - b/);
  results.push("执行修改只在独立 worktree；未经确认目标分支保持原样");
  const delivery = store
    .all("deliveries")
    .find((d) => d.requestId === task.id)!;
  assert.ok(delivery);
  assert.ok(
    store
      .all("evidence")
      .some((e) => e.exitCode === 0 && e.command.includes("assert")),
  );
  results.push("真实 macOS 沙箱运行两个加法断言并保存证据");
  const denied = await app.inject({
    method: "POST",
    url: `/api/tasks/${task.id}/approve`,
    headers,
    payload: { token: "wrong" },
  });
  assert.equal(denied.statusCode, 400);
  assert.equal(await git(repo, ["rev-parse", "HEAD"]), base);
  results.push("错误确认编号不能合并");
  const merged = await app.inject({
    method: "POST",
    url: `/api/tasks/${task.id}/approve`,
    headers,
    payload: { token: delivery.token },
  });
  assert.equal(merged.statusCode, 200, merged.body);
  assert.equal(store.get("tasks", task.id).status, "delivered");
  await git(repo, ["merge-base", "--is-ancestor", delivery.headSha, "main"]);
  assert.match(await readFile(path.join(repo, "math.mjs"), "utf8"), /a \+ b/);
  results.push("明确确认后实际合并到本地 main，并核对提交包含关系");
  const again = await app.inject({
    method: "POST",
    url: `/api/tasks/${task.id}/approve`,
    headers,
    payload: { token: delivery.token },
  });
  assert.equal(again.statusCode, 200);
  results.push("重复确认返回已有交付，不再次合并");
  const detail = await app.inject({ url: `/api/tasks/${task.id}`, headers });
  assert.equal(detail.statusCode, 200);
  assert.ok(detail.json().runs.length >= 3);
  results.push("API 可读取规划、执行、验收、交付全过程记录");
  const report = {
    mode: live ? "real-codex" : "scripted-agent",
    root,
    taskId: task.id,
    passed: results,
    limitations: [
      "钉钉真实收发未验证（无凭据）",
      "GitHub PR 未验证（此场景使用本地 Git）",
    ],
    time: new Date().toISOString(),
  };
  await writeFile(
    path.join(root, "report.json"),
    JSON.stringify(report, null, 2),
  );
  await writeFile(
    path.join(parent, live ? "latest-live.json" : "latest-fixture.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await engine.shutdown();
  await app.close();
  store.close();
}
