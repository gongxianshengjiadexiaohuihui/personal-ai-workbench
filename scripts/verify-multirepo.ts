// Scripted model decisions; Git worktrees, commands, sandbox and merges are real.
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { CodexAdapter } from "../src/adapters/codex.js";
import { Store } from "../src/store.js";
import { Engine } from "../src/engine.js";
import { GitService, git } from "../src/git.js";
import { ProjectService } from "../src/projects.js";
import { Verifier } from "../src/verification.js";
import type { AgentAdapter, AgentInput } from "../src/adapters/agent.js";
import type { ProjectRepository } from "../src/domain.js";
const live = process.env.VERIFY_AGENT === "codex";
await mkdir(path.resolve(".data/verification"), { recursive: true });
const root = await realpath(
    await mkdtemp(
      live
        ? path.resolve(".data/verification/live-multi-")
        : path.join(os.tmpdir(), "pai-multirepo-"),
    ),
  ),
  data = path.join(root, "data");
const store = new Store(path.join(data, "workbench.sqlite"));
const gitService = new GitService(data),
  service = new ProjectService(store, gitService);
const passed: string[] = [];
async function repo(name: string) {
  const r = path.join(root, name);
  await mkdir(r);
  await git(r, ["init", "-b", "main"]);
  await git(r, ["config", "user.name", "Fixture"]);
  await git(r, ["config", "user.email", "fixture@localhost"]);
  await writeFile(path.join(r, "value.txt"), "0\n");
  await git(r, ["add", "."]);
  await git(r, ["commit", "-m", "base"]);
  return r;
}
class Agent implements AgentAdapter {
  running = 0;
  max = 0;
  byRepo = new Map<string, number>();
  duplicate = false;
  upstream = "";
  executions: string[] = [];
  capabilities() {
    return {
      id: "fixture",
      resume: true,
      interrupt: true,
      structuredOutput: true,
    };
  }
  async start(input: AgentInput) {
    input.onSession(input.sessionId || `fixture-${Math.random()}`);
    let output: unknown;
    if (input.role === "controller") {
      const members: ProjectRepository[] = JSON.parse(
        input.prompt.match(/项目仓库清单：(.*?)。每个执行组/s)![1],
      );
      const key = input.prompt.includes("independent")
        ? "parallel"
        : input.prompt.includes("shared-one")
          ? "shared-one"
          : input.prompt.includes("shared-two")
            ? "shared-two"
            : "dependent";
      output = {
        action: "plan",
        summary: "脚本计划",
        question: "",
        groups: members.map((r, i) => ({
          key: String(i),
          repositoryId: input.prompt.includes("invalid-repository")
            ? "outside"
            : r.repositoryId,
          title: r.name,
          goal: `${key}-${i}`,
          criteria: ["value.txt 等于 1"],
          dependsOn: key === "dependent" && i > 0 ? ["0"] : [],
          tasks: [{ title: r.name, goal: "更新值", criteria: ["值为 1"] }],
        })),
      };
    } else if (input.role === "executor") {
      const common = await git(input.cwd, ["rev-parse", "--git-common-dir"]);
      const n = (this.byRepo.get(common) || 0) + 1;
      this.byRepo.set(common, n);
      if (n > 1) this.duplicate = true;
      this.running++;
      this.max = Math.max(this.max, this.running);
      const key = input.prompt.match(/目标：([^\n]+)/)![1];
      this.executions.push(key);
      try {
        if (key === "dependent-1")
          assert.equal(
            (
              await readFile(path.join(this.upstream, "value.txt"), "utf8")
            ).trim(),
            "1",
          );
        await new Promise((r) => setTimeout(r, 180));
        await writeFile(path.join(input.cwd, "value.txt"), "1\n");
        if (key.startsWith("shared-"))
          await writeFile(path.join(input.cwd, `${key}.txt`), "shared\n");
        output = {
          summary: "脚本修改值",
          blocked: false,
          question: "",
          artifacts: [],
        };
      } finally {
        this.running--;
        this.byRepo.set(common, n - 1);
      }
    } else
      output = {
        decision: "pass",
        summary: "实际命令已通过",
        feedback: "",
        artifacts: [],
      };
    return {
      sessionId: input.sessionId || "fixture",
      turnId: "turn",
      output: JSON.stringify(output),
      usage: null,
    };
  }
  resume(input: AgentInput & { sessionId: string }) {
    return this.start(input);
  }
  async observe(sessionId: string) {
    return { thread: { id: sessionId, turns: [] } };
  }
  async interrupt() {}
}
class ObservedVerifier extends Verifier {
  running = 0;
  max = 0;
  override async run(...args: Parameters<Verifier["run"]>) {
    this.running++;
    this.max = Math.max(this.max, this.running);
    try {
      return await super.run(...args);
    } finally {
      this.running--;
    }
  }
}
const agent = new Agent(),
  verifier = new ObservedVerifier("codex", data);
const engine = new Engine(
  store,
  live
    ? new CodexAdapter(process.env.CODEX_BIN || "/usr/local/bin/codex")
    : agent,
  gitService,
  verifier,
  data,
  2,
);
if (live)
  engine.events.on("change", (e) => {
    if (
      [
        "plan",
        "claimed",
        "delivery",
        "delivered",
        "blocked",
        "question",
      ].includes(e.type)
    )
      console.log(`${e.type}: ${e.message}`);
  });
async function wait(fn: () => boolean, label: string) {
  const deadline = Date.now() + (live ? 15 * 60 * 1000 : 25000);
  while (Date.now() < deadline) {
    if (fn()) return;
    if (
      live &&
      store
        .all("tasks")
        .some((t) => !t.parentId && (t.status === "blocked" || !!t.question))
    )
      throw new Error(
        `真实 Codex 任务阻塞：${JSON.stringify(store.all("events").slice(-3))}`,
      );
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`${label}: ${JSON.stringify(store.all("events").slice(-5))}`);
}
const verify = `"${process.execPath}" --input-type=module -e 'import {readFileSync} from "node:fs";import assert from "node:assert/strict";assert.equal(readFileSync("value.txt","utf8").trim(),"1")'`;
try {
  const a = await repo("upstream"),
    b = await repo("downstream");
  agent.upstream = a;
  await service.migrate();
  const project = await service.save({
    name: "跨仓库",
    repositories: [
      {
        name: "上游",
        repoPath: a,
        baseBranch: "main",
        verifyCommands: [verify],
        runtimeKey: "shared-test-environment",
      },
      {
        name: "下游",
        repoPath: b,
        baseBranch: "main",
        verifyCommands: [
          verify,
          `"${process.execPath}" --input-type=module -e 'import {readFileSync,writeFileSync} from "node:fs";import assert from "node:assert/strict";assert.equal(readFileSync(${JSON.stringify(path.join(a, "value.txt"))},"utf8").trim(),"1");assert.throws(()=>writeFileSync(${JSON.stringify(path.join(a, "blocked.txt"))},"denied"));'`,
        ],
        runtimeKey: "shared-test-environment",
      },
    ],
  });
  await engine.start();
  const t = engine.request(
    project.id,
    "跨仓库",
    live
      ? "只完成两处文件变更：先将上游仓库 value.txt 从 0 改成 1；用户确认上游合并后，再将下游仓库 value.txt 从 0 改成 1。明确创建两个执行组，下游依赖上游，不添加其他文件，不执行 git 提交/合并。系统提供的验证命令负责验证，上游源目录只读。无需澄清。"
      : "dependent",
  );
  console.log(
    JSON.stringify({
      mode: live ? "real-codex" : "scripted-agent",
      root,
      taskId: t.id,
    }),
  );
  await wait(
    () => store.all("deliveries").some((d) => d.requestId === t.id),
    "上游交付",
  );
  const upstream = store.all("deliveries").find((d) => d.requestId === t.id)!;
  assert.equal(
    store
      .all("groups")
      .filter((g) => g.requestId === t.id && g.status === "queued").length,
    1,
  );
  assert.equal(agent.executions.includes("dependent-1"), false);
  assert.equal((await readFile(path.join(a, "value.txt"), "utf8")).trim(), "0");
  assert.equal((await readFile(path.join(b, "value.txt"), "utf8")).trim(), "0");
  await assert.rejects(engine.approve(t.id, "wrong-token"));
  await engine.approve(t.id, upstream.token);
  await wait(
    () =>
      store.all("deliveries").filter((d) => d.requestId === t.id).length === 2,
    "下游交付",
  );
  assert.notEqual(store.get("tasks", t.id).status, "delivered");
  const downstream = store
    .all("deliveries")
    .find((d) => d.requestId === t.id && d.id !== upstream.id)!;
  assert.notEqual(upstream.repositoryId, downstream.repositoryId);
  assert.notEqual(upstream.token, downstream.token);
  await engine.approve(t.id, downstream.token);
  assert.equal(store.get("tasks", t.id).status, "delivered");
  assert.equal((await readFile(path.join(b, "value.txt"), "utf8")).trim(), "1");
  passed.push(
    "跨仓库工作树独立；上游确认前下游不执行；逐仓库确认后整体完成；验证沙箱拒绝写其他仓库",
  );
  if (!live) {
    const invalid = engine.request(
      project.id,
      "非法仓库引用",
      "invalid-repository",
    );
    await wait(
      () => store.get("tasks", invalid.id).status === "blocked",
      "拒绝非法仓库",
    );
    assert.equal(
      store.all("groups").some((g) => g.requestId === invalid.id),
      false,
    );
    await engine.stop(invalid.id);
    passed.push("项目外仓库在规划阶段被拒绝");
    const c = await repo("parallel-c"),
      d = await repo("parallel-d");
    const parallel = await service.save({
      name: "独立并行",
      repositories: [c, d].map((repoPath) => ({
        repoPath,
        baseBranch: "main",
        verifyCommands: [verify],
        runtimeKey: "same-environment",
      })),
    });
    agent.max = 0;
    verifier.max = 0;
    const independent = engine.request(parallel.id, "独立仓库", "independent");
    await wait(
      () =>
        store.all("deliveries").filter((d) => d.requestId === independent.id)
          .length === 2,
      "独立仓库执行",
    );
    assert.equal(agent.max, 2);
    assert.equal(verifier.max, 1);
    await engine.stop(independent.id);
    passed.push("两个独立仓库并行执行，共享环境的验证串行");
    const p1 = await service.save({
      name: "共享仓库一",
      repositories: [
        { repoPath: c, baseBranch: "main", verifyCommands: [verify] },
      ],
    });
    const p2 = await service.save({
      name: "共享仓库二",
      repositories: [
        { repoPath: c, baseBranch: "main", verifyCommands: [verify] },
      ],
    });
    agent.max = 0;
    const s1 = engine.request(p1.id, "共享一", "shared-one"),
      s2 = engine.request(p2.id, "共享二", "shared-two");
    await wait(
      () =>
        store
          .all("deliveries")
          .filter((d) => d.requestId === s1.id || d.requestId === s2.id)
          .length === 2,
      "共享仓库执行",
    );
    assert.equal(agent.max, 1);
    assert.equal(agent.duplicate, false);
    const first = store.all("deliveries").find((d) => d.requestId === s1.id)!,
      second = store.all("deliveries").find((d) => d.requestId === s2.id)!;
    await engine.approve(s1.id, first.token);
    await assert.rejects(engine.approve(s2.id, second.token), /变化/);
    assert.equal(store.get("deliveries", second.id).status, "stale");
    await engine.stop(s2.id);
    passed.push("不同项目共享仓库时执行串行，旧基线交付确认失效");
    const pending = await service.save({
      name: "待配置",
      repositories: [{ repoPath: b, baseBranch: "main", verifyCommands: [] }],
    });
    assert.throws(
      () => engine.request(pending.id, "不应执行", "test"),
      /待配置/,
    );
    passed.push("未配置验证命令的项目拒绝启动任务");
  }
  const report = {
    mode: live
      ? "real-codex-real-git-and-sandbox"
      : "scripted-agent-real-git-and-sandbox",
    passed,
    root,
    time: new Date().toISOString(),
  };
  if (live)
    await writeFile(
      path.resolve(".data/verification/latest-live-multirepo.json"),
      JSON.stringify(report, null, 2),
    );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await engine.shutdown();
  store.close();
  if (!live) await rm(root, { recursive: true, force: true });
}
