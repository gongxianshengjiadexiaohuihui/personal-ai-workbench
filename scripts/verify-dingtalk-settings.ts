import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveDingTalkOwner } from "../src/channels/dingtalk-owner.js";
import { DWClient } from "dingtalk-stream";
import { DingTalkChannel } from "../src/channels/dingtalk.js";
import { loadDingTalkConfig } from "../src/dingtalk-config.js";
import { Store } from "../src/store.js";
import { Engine } from "../src/engine.js";
import { CodexAdapter } from "../src/adapters/codex.js";
import { GitService } from "../src/git.js";
import { Verifier } from "../src/verification.js";
import { buildServer } from "../src/server.js";

// This transport never contacts DingTalk; it exercises settings and reconnection only.
class FakeStream extends DWClient {
  disconnected = false;
  async connect() {
    this.connected = true;
  }
  disconnect() {
    this.disconnected = true;
    this.connected = false;
  }
}
const dataDir = await mkdtemp(path.join(os.tmpdir(), "workbench-dingtalk-"));
const empty = { clientId: "", clientSecret: "", robotCode: "", ownerId: "" };
const config = {
  dataDir,
  port: 48761,
  maxConcurrent: 2,
  codexBin: "/usr/bin/false",
  model: undefined,
  dingtalk: empty,
};
const store = new Store(path.join(dataDir, "workbench.sqlite"));
const engine = new Engine(
  store,
  new CodexAdapter(config.codexBin),
  new GitService(dataDir),
  new Verifier(config.codexBin, dataDir),
  dataDir,
);
const clients: FakeStream[] = [];
const channel = new DingTalkChannel(
  empty,
  store,
  async () => "simulated reply",
  () => {
    const client = new FakeStream({
      clientId: "fixture",
      clientSecret: "fixture",
      debug: false,
    });
    clients.push(client);
    return client;
  },
);
let lookupFailure = false;
const lookupRequests: { url: string; body: Record<string, string> }[] = [];
const mockFetch: typeof fetch = async (url, options) => {
  const body = JSON.parse(String(options?.body));
  lookupRequests.push({ url: String(url), body });
  if (String(url).includes("/oauth2/accessToken")) {
    return Response.json({ accessToken: "fixture-token" });
  }
  assert.equal(
    String(url),
    "https://oapi.dingtalk.com/topapi/v2/user/getbymobile?access_token=fixture-token",
  );
  if (lookupFailure)
    return Response.json({
      errcode: 60011,
      errmsg: "upstream-sensitive-detail",
    });
  return Response.json({
    errcode: 0,
    result: {
      userid: body.mobile === "13800000000" ? "test-owner" : "new-owner",
    },
  });
};
const app = await buildServer(engine, channel, config, (input) =>
  resolveDingTalkOwner(input, mockFetch),
);
const host = { host: "127.0.0.1:48761" };
const headers = {
  ...host,
  "x-workbench-token": (
    await app.inject({ url: "/api/session", headers: host })
  ).json().token,
};
const first = {
  clientId: "test-app",
  clientSecret: "fake-secret-never-networked",
  robotCode: "test-robot",
  ownerMobile: "13800000000",
};
const save = (
  payload: Record<string, string>,
  requestHeaders: Record<string, string> = headers,
) =>
  app.inject({
    method: "PUT",
    url: "/api/settings/dingtalk",
    headers: requestHeaders,
    payload,
  });
try {
  assert.deepEqual(loadDingTalkConfig(dataDir, empty), empty);
  assert.equal((await save(first, host)).statusCode, 403);
  assert.equal(
    (await save(first, { ...headers, origin: "https://untrusted.invalid" }))
      .statusCode,
    403,
  );
  assert.equal((await save({ ...first, clientSecret: "" })).statusCode, 400);
  assert.equal((await save({ ...first, robotCode: "" })).statusCode, 400);
  assert.equal(
    (await save({ ...first, ownerMobile: "not-a-phone" })).statusCode,
    400,
  );
  assert.equal(
    (await save({ ...first, ownerId: "forged-id" })).statusCode,
    400,
  );
  assert.equal(lookupRequests.length, 0);
  const saved = await save(first);
  assert.deepEqual(lookupRequests[0].body, {
    appKey: first.clientId,
    appSecret: first.clientSecret,
  });
  assert.deepEqual(lookupRequests[1].body, { mobile: first.ownerMobile });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.body.includes(first.clientSecret), false);
  assert.equal(saved.json().dingtalk.secretConfigured, true);
  assert.equal(saved.json().dingtalk.connected, true);
  const file = path.join(dataDir, "dingtalk.json");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
    ...first,
    ownerId: "test-owner",
  });
  assert.deepEqual(loadDingTalkConfig(dataDir, empty), {
    ...first,
    ownerId: "test-owner",
  });
  lookupFailure = true;
  const beforeFailure = await readFile(file, "utf8");
  const failed = await save({ ...first, ownerMobile: "13900000000" });
  assert.equal(failed.statusCode, 400);
  assert.equal(failed.body.includes("60011"), true);
  assert.equal(failed.body.includes("upstream-sensitive-detail"), false);
  assert.equal(await readFile(file, "utf8"), beforeFailure);
  assert.equal(clients.length, 1);
  assert.equal(clients[0].disconnected, false);
  assert.equal(channel.config.ownerId, "test-owner");
  lookupFailure = false;
  channel.token = "old-cached-token";
  channel.expires = Date.now() + 100000;
  const updated = await save({
    ...first,
    clientSecret: "",
    ownerMobile: "+86 139-0000-0000",
  });
  assert.equal(updated.statusCode, 200);
  assert.equal(clients[0].disconnected, true);
  assert.equal(clients.length, 2);
  assert.equal(channel.token, "");
  assert.equal(channel.expires, 0);
  assert.equal(
    loadDingTalkConfig(dataDir, empty).clientSecret,
    first.clientSecret,
  );
  assert.equal(channel.config.ownerId, "new-owner");
  assert.equal(channel.config.ownerMobile, "13900000000");
  assert.deepEqual(lookupRequests.at(-1)?.body, { mobile: "13900000000" });
  assert.equal(
    (await save({ ...first, clientId: "other-app", clientSecret: "" }))
      .statusCode,
    400,
  );
  const replacement = {
    ...first,
    clientId: "other-app",
    clientSecret: "fake-replacement-secret",
  };
  assert.equal((await save(replacement)).statusCode, 200);
  assert.equal(clients[1].disconnected, true);
  assert.deepEqual(loadDingTalkConfig(dataDir, empty), {
    ...replacement,
    ownerId: "test-owner",
  });
  assert.deepEqual(lookupRequests.at(-2)?.body, {
    appKey: replacement.clientId,
    appSecret: replacement.clientSecret,
  });
  // Authentication, malformed responses and network failures must not leak upstream details.
  for (const response of [
    Response.json({}),
    Response.json({ accessToken: "" }, { status: 401 }),
  ]) {
    await assert.rejects(
      resolveDingTalkOwner(first, async () => response),
      /应用认证失败/,
    );
  }
  await assert.rejects(
    resolveDingTalkOwner(first, async () => {
      throw new Error("fixture-token");
    }),
    /检查网络/,
  );
  for (const body of [
    { errcode: 0 },
    { errcode: 0, result: { userid: "" } },
    { errcode: 60121 },
  ]) {
    let call = 0;
    await assert.rejects(
      resolveDingTalkOwner(first, async () =>
        Response.json(++call === 1 ? { accessToken: "fixture-token" } : body),
      ),
      /无法按手机号查询/,
    );
  }
  const settings = await app.inject({ url: "/api/settings", headers: host });
  assert.equal(settings.body.includes(first.clientSecret), false);
  assert.equal(settings.body.includes(replacement.clientSecret), false);
  assert.equal("clientSecret" in settings.json().dingtalk, false);
  const messages: string[] = [];
  channel.send = async (message) => {
    messages.push(message);
  };
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/settings/test-dingtalk",
        headers,
        payload: {},
      })
    ).statusCode,
    200,
  );
  await channel.stop();
  assert.equal(messages.length, 1);
  assert.equal(clients[2].disconnected, true);
  console.log(
    "PASS: protected settings API, validation, persistence/0600, secret redaction/retention, credential rotation, phone lookup/normalization, lookup failure preserving the active config, reconnect/token reset and simulated test-message queue. No real DingTalk traffic.",
  );
} finally {
  await channel.stop();
  await app.close();
  store.close();
  await rm(dataDir, { recursive: true, force: true });
}
