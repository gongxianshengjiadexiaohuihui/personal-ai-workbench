import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  stat,
  realpath,
  symlink,
  rm,
  readdir,
} from "node:fs/promises";
import os from "node:os";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/store.js";
import { GitService, git } from "../src/git.js";
import { ProjectService, inspectRepository } from "../src/projects.js";
import { CodexProjectSource } from "../src/codex-projects.js";
import { ProjectImporter } from "../src/project-import.js";
import { buildServer } from "../src/server.js";
import { Engine } from "../src/engine.js";
import { Verifier } from "../src/verification.js";
import { CodexAdapter } from "../src/adapters/codex.js";
import { DingTalkChannel } from "../src/channels/dingtalk.js";
import { command } from "../src/process.js";

const root = await realpath(
  await mkdtemp(path.join(os.tmpdir(), "pai-projects-")),
);
const data = path.join(root, "data"),
  home = path.join(root, "codex");
await mkdir(home);
const store = new Store(path.join(data, "store.sqlite")),
  service = new ProjectService(store, new GitService(data));
const passed: string[] = [];
const check = (message: string) => passed.push(message);
async function repo(name: string) {
  const dir = path.join(root, name);
  await mkdir(dir);
  await git(dir, ["init", "-b", "main"]);
  await writeFile(path.join(dir, "one.txt"), "one\n");
  await git(dir, ["add", "one.txt"]);
  await git(dir, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@localhost",
    "commit",
    "-m",
    "fixture",
  ]);
  return dir;
}
try {
  const a = await repo("a"),
    b = await repo("b"),
    docs = path.join(root, "docs");
  await mkdir(docs);
  await writeFile(path.join(docs, "note.txt"), "approved contents\n");
  await writeFile(path.join(docs, "other.txt"), "unselected\n");
  await writeFile(path.join(docs, ".env"), "fake-secret\n");
  await writeFile(path.join(docs, ".gitignore"), "custom-output/\n!.env\n!node_modules/\n");
  await mkdir(path.join(docs, "custom-output"));
  await writeFile(path.join(docs, "custom-output", "ignored.txt"), "ignore\n");
  await mkdir(path.join(docs, "node_modules"));
  await writeFile(path.join(docs, "node_modules", "x.js"), "ignore\n");
  await symlink(a, path.join(docs, "external-link"));
  await mkdir(path.join(docs, "nested"));
  await git(path.join(docs, "nested"), ["init", "-b", "main"]);
  await symlink(a, path.join(root, "alias-a"));
  const old = store.create("projects", {
    name: "old",
    repoPath: a,
    baseBranch: "main",
    deliveryMode: "local",
    githubRepo: "",
    verifyCommands: ["true"],
    runtimeKey: "",
    instructions: "",
  });
  const sha = await git(a, ["rev-parse", "HEAD"]);
  const oldGroup = store.create("groups", {
    projectId: old.id,
    requestId: "T-legacy",
    title: "legacy",
    goal: "legacy",
    criteria: [],
    taskIds: [],
    dependsOn: [],
    runtimeKey: a,
    status: "awaiting_approval",
    branch: "main",
    worktree: a,
    baseSha: sha,
    headSha: sha,
    sessionId: "legacy-session",
    reworks: 0,
    feedback: "",
    lastSummaryAt: "",
    lastSummary: "",
    progress: "",
  });
  const oldDelivery = store.create("deliveries", {
    groupId: oldGroup.id,
    requestId: "T-legacy",
    mode: "local",
    repo: a,
    base: "main",
    baseSha: sha,
    headSha: sha,
    branch: "main",
    url: "",
    number: 0,
    token: "legacy-approval-token",
    status: "pending",
    approvedAt: null,
    mergeSha: null,
  });
  await service.migrate();
  assert.equal(store.get("groups", oldGroup.id).sessionId, "legacy-session");
  assert.equal(
    store.get("deliveries", oldDelivery.id).token,
    oldDelivery.token,
  );
  assert.equal(store.get("deliveries", oldDelivery.id).headSha, sha);
  assert.equal(
    store.get("deliveries", oldDelivery.id).repositoryId,
    store.get("groups", oldGroup.id).repositoryId,
  );
  check(
    "historical groups and pending approval retain session, SHA, token and status",
  );
  assert.equal(store.get("projects", old.id).repositories?.length, 1);
  const backup = store.setting<string>("multi-repository-backup", "");
  assert.equal((await stat(backup)).mode & 0o777, 0o600);
  const backupDb = new DatabaseSync(backup, { readOnly: true });
  assert.equal(
    JSON.parse(
      String(
        backupDb.prepare("select data from projects where id=?").get(old.id)!
          .data,
      ),
    ).repositories,
    undefined,
  );
  backupDb.close();
  check("migration backs up pre-migration project and preserves IDs");
  const db = new DatabaseSync(path.join(home, "state_5.sqlite"));
  db.exec(
    "CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,position INTEGER);CREATE TABLE project_roots(project_id TEXT,path TEXT,position INTEGER)",
  );
  db.prepare("INSERT INTO projects VALUES(?,?,?)").run("multi", "Multi", 0);
  for (const [i, p] of [a, b, docs, path.join(root, "missing")].entries())
    db.prepare("INSERT INTO project_roots VALUES(?,?,?)").run("multi", p, i);
  db.close();
  const source = new CodexProjectSource(home),
    importer = new ProjectImporter(service, source);
  const discovery = await source.discover(store.all("projects"));
  assert.equal(discovery.source, "sqlite");
  assert.equal(discovery.projects[0].roots.length, 4);
  assert.equal(discovery.projects[0].roots[3].kind, "invalid");
  check(
    "read-only SQLite discovery preserves multi-root grouping and invalid diagnostics",
  );
  const fingerprint = await readFile(path.join(home, "state_5.sqlite"));
  assert.equal(
    (await inspectRepository(path.join(root, "alias-a"))).commonDir,
    (await inspectRepository(a)).commonDir,
  );
  const worktree = path.join(root, "a-worktree");
  await git(a, ["worktree", "add", "--detach", worktree]);
  assert.equal(
    (await inspectRepository(worktree)).commonDir,
    (await inspectRepository(a)).commonDir,
  );
  assert.equal((await inspectRepository(worktree)).branch, "");
  await assert.rejects(service.save({name:"invalid branch", repositories:[{repoPath:worktree, baseBranch:"missing", verifyCommands:["true"]}]}), /有效的本地目标分支/);
  await mkdir(path.join(a, "sub"));
  assert.equal(
    (await source.inspect(path.join(a, "sub"))).kind,
    "subdirectory",
  );
  check(
    "symlinks/worktrees share repository identity; subdirectories and detached HEAD are identified",
  );
  const selection = {
    sourceId: "multi",
    name: "Multi",
    repositories: [a, b, docs].map((repoPath) => ({
      repoPath,
      baseBranch: "main",
      verifyCommands: ["true"],
    })),
  };
  const pre = await importer.preview(selection);
  assert.ok("token" in pre);
  assert.equal(
    await stat(path.join(docs, ".git")).then(
      () => true,
      () => false,
    ),
    false,
  );
  const snapshot = pre.directories.find((d) => d.repoPath === docs)!.snapshot!;
  assert.deepEqual(
    snapshot.files.map((f) => f.path),
    [".gitignore", "note.txt", "other.txt"],
  );
  assert.ok(snapshot.excluded.some((f) => f.path === ".env"));
  assert.ok(snapshot.excluded.some((f) => f.path === "nested"));
  assert.ok(snapshot.excluded.some((f) => f.path === "external-link"));
  check(
    "preview respects ignores, credentials, symlinks and nested repositories without creating .git",
  );
  await writeFile(path.join(docs, "later.txt"), "new file\n");
  await assert.rejects(
    importer.confirm({
      token: pre.token,
      selectedFiles: { [docs]: ["note.txt"] },
    }),
    /重新预览/,
  );
  assert.equal(
    await stat(path.join(docs, ".git")).then(
      () => true,
      () => false,
    ),
    false,
  );
  check("new files invalidate preview before Git writes");
  const fresh = await importer.preview(selection);
  assert.ok("token" in fresh);
  const result = await importer.confirm({
    token: fresh.token,
    selectedFiles: { [docs]: ["note.txt"] },
  });
  assert.equal(result.project.repositories?.length, 3);
  assert.equal(await git(docs, ["ls-tree", "--name-only", "HEAD"]), "note.txt");
  // 用户的反向忽略规则保持不变；仍不可使默认排除项进入首次提交。
  assert.equal(await git(docs, ["status", "--porcelain"]), "?? .env\n?? node_modules/");
  assert.equal(await readFile(path.join(docs, ".gitignore"), "utf8"), "custom-output/\n!.env\n!node_modules/\n");
  assert.equal(
    await readFile(path.join(docs, "other.txt"), "utf8"),
    "unselected\n",
  );
  const head = await git(docs, ["rev-parse", "HEAD"]);
  assert.equal(
    (
      await importer.confirm({
        token: fresh.token,
        selectedFiles: { [docs]: ["note.txt"] },
      })
    ).project.id,
    result.project.id,
  );
  assert.equal(await git(docs, ["rev-parse", "HEAD"]), head);
  assert.equal(
    ((await importer.preview(selection)) as { existingProjectId: string })
      .existingProjectId,
    result.project.id,
  );
  check(
    "only selected files committed; excluded files preserved; retry/import are idempotent",
  );
  assert.deepEqual(
    await readFile(path.join(home, "state_5.sqlite")),
    fingerprint,
  );
  check("Codex source database remains byte-for-byte unchanged");
  const shared = await service.save({
    name: "shared",
    repositories: [{ repoPath: a, baseBranch: "main", verifyCommands: [] }],
  });
  assert.equal(
    shared.repositories![0].repositoryId,
    result.project.repositories![0].repositoryId,
  );
  assert.ok(shared.repositories![0].issues.length);
  check("shared repository identity and pending validation configuration");
  const empty = path.join(root, "empty");
  await mkdir(empty);
  await writeFile(
    path.join(home, ".codex-global-state.json"),
    JSON.stringify({
      "local-projects": {
        empty: { name: "Empty", rootPaths: [empty] },
        aliases: {name: "Aliases", rootPaths: [a, path.join(root, "alias-a"), worktree]},
      },
    }),
  );
  await rm(path.join(home, "state_5.sqlite"));
  const fallback = await source.discover();
  assert.equal(fallback.source, "legacy-json");
  assert.equal(fallback.projects[1].roots.length, 1);
  assert.equal(fallback.projects[1].roots[0].aliases.length, 3);
  const emptyPre = await importer.preview({
    sourceId: "empty",
    name: "Empty",
    repositories: [{ repoPath: empty, baseBranch: "main" }],
  });
  assert.ok("token" in emptyPre);
  await importer.confirm({ token: emptyPre.token });
  assert.equal(await git(empty, ["rev-list", "--count", "HEAD"]), "1");
  check("legacy discovery and empty initial commit");
  // A failure after Git initialization/commit but before registration can be retried after restart.
  const retryDir = path.join(root, "retry");
  await mkdir(retryDir);
  await writeFile(path.join(retryDir, "kept.txt"), "kept");
  await writeFile(
    path.join(home, ".codex-global-state.json"),
    JSON.stringify({
      "local-projects": { retry: { name: "Retry", rootPaths: [retryDir] } },
    }),
  );
  const retry = await importer.preview({
    sourceId: "retry",
    name: "Retry",
    repositories: [
      { repoPath: retryDir, baseBranch: "main", verifyCommands: ["true"] },
    ],
  });
  assert.ok("token" in retry);
  const originalSetting = store.setSetting.bind(store);
  const refLock = path.join(retryDir, ".git/refs/heads/main.lock");
  store.setSetting = (key, value) => {
    originalSetting(key, value);
    if (key === `import:${retry.token}` && (value as any).progress[retryDir]?.initialized && !(value as any).progress[retryDir]?.commit)
      writeFileSync(refLock, "fixture concurrent ref lock");
  };
  await assert.rejects(importer.confirm({token: retry.token, selectedFiles:{[retryDir]:["kept.txt"]}}), /main.lock/);
  store.setSetting = originalSetting;
  await assert.rejects(git(retryDir, ["rev-parse", "--verify", "HEAD"]));
  const pendingCommit = store.setting<any>(`import:${retry.token}`, null).progress[retryDir].commit;
  assert.ok(pendingCommit);
  await rm(refLock);
  check("failed initial ref update retains progress for retry without committing unconfirmed files");
  const originalSave = service.save.bind(service);
  service.save = async () => {
    throw new Error("fixture registration failure");
  };
  await assert.rejects(
    importer.confirm({
      token: retry.token,
      selectedFiles: { [retryDir]: ["kept.txt"] },
    }),
    /registration failure/,
  );
  const retryHead = await git(retryDir, ["rev-parse", "HEAD"]);
  assert.equal(retryHead, pendingCommit);
  service.save = originalSave;
  const recovered = new ProjectImporter(service, source);
  await recovered.confirm({
    token: retry.token,
    selectedFiles: { [retryDir]: ["kept.txt"] },
  });
  assert.equal(await git(retryDir, ["rev-parse", "HEAD"]), retryHead);
  assert.equal(await git(retryDir, ["rev-list", "--count", "HEAD"]), "1");
  check(
    "failed registration resumes from persisted import progress without duplicate commit",
  );
  const oldHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  const config = {
    dataDir: data,
    port: 48761,
    maxConcurrent: 2,
    codexBin: "/usr/bin/false",
    model: undefined,
    dingtalk: { clientId: "", clientSecret: "", robotCode: "", ownerId: "" },
  };
  const engine = new Engine(
    store,
    new CodexAdapter(config.codexBin),
    service.gitService,
    new Verifier(config.codexBin, data),
    data,
  );
  const channel = new DingTalkChannel(config.dingtalk, store, async () => "");
  const app = await buildServer(engine, channel, config);
  try {
    const host = { host: "127.0.0.1:48761" };
    const token = (
      await app.inject({ url: "/api/session", headers: host })
    ).json().token;
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/projects/import/confirm",
          headers: host,
          payload: { token: retry.token },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({ url: "/api/projects/discover", headers: host })
      ).json().projects[0].importedId,
      store.all("projects").find((p) => p.source?.id === "retry")!.id,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/projects/import/confirm",
          headers: { ...host, "x-workbench-token": token },
          payload: {
            token: retry.token,
            selectedFiles: { [retryDir]: ["kept.txt"] },
          },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/projects/import/preview",
          headers: {
            ...host,
            "x-workbench-token": token,
            origin: "https://untrusted.invalid",
          },
          payload: {},
        })
      ).statusCode,
      403,
    );
    check(
      "discovery and idempotent confirmation API work; mutations require token and allowed origin",
    );
  } finally {
    await app.close();
    if (oldHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = oldHome;
  }
  await writeFile(path.join(home, ".codex-global-state.json"), "{}");
  await assert.rejects(source.discover(), /格式不兼容/);
  check("invalid source is an error, not an empty project list");
  console.log(JSON.stringify({ passed }, null, 2));
} finally {
  store.close();
  await rm(root, { recursive: true, force: true });
}
