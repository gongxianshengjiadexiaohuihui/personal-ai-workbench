import { mkdir, open, unlink, readFile } from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import { NativeController } from "./native/controller.js";
import { Store } from "./store.js";
import { configuration } from "./config.js";
import { CodexAdapter } from "./adapters/codex.js";
import { GitService } from "./git.js";
import { Verifier } from "./verification.js";
import { Engine } from "./engine.js";
import { WeixinChannel } from "./channels/weixin.js";
import { DingTalkChannel } from "./channels/dingtalk.js";
import { buildServer } from "./server.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const config = configuration();
await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
// 一个数据目录只由一个调度进程拥有，避免重复消费消息或恢复同一执行。
const lockPath = path.join(config.dataDir, "service.lock");
async function acquire() {
  try {
    const f = await open(lockPath, "wx", 0o600);
    await f.writeFile(String(process.pid));
    await f.close();
  } catch (e: any) {
    if (e.code !== "EEXIST") throw e;
    const pid = Number(await readFile(lockPath, "utf8"));
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (error: any) {
      if (error.code === "ESRCH") alive = false;
    }
    if (alive) throw new Error("此数据目录已有运行中的服务");
    await unlink(lockPath);
    const f = await open(lockPath, "wx", 0o600);
    await f.writeFile(String(process.pid));
    await f.close();
  }
}
await acquire();
const store = new Store(path.join(config.dataDir, "workbench.sqlite"));
const agent = new CodexAdapter(config.codexBin, config.model);
const engine = new Engine(
  store,
  agent,
  new GitService(config.dataDir),
  new Verifier(config.codexBin, config.dataDir),
  config.dataDir,
  store.setting("maxConcurrent", config.maxConcurrent),
);
const native = new NativeController(engine, config.codexBin, config.port);
await native.start();
const channel = new DingTalkChannel(config.dingtalk, store, (text, id, metadata) =>
  engine.handleMessage(text, id, metadata), undefined, () => native.enabled(),
);
const weixin = new WeixinChannel(config.dataDir, store, (text, id, metadata) => engine.handleMessage(text, id, metadata), () => native.enabled());
native.defaultOrigin = () => channel.config.ownerId ? { channel: "dingtalk", senderId: channel.config.ownerId, conversationId: channel.config.ownerId } : null;
native.alertOrigins = () => {
  const c = weixin.credentials;
  const weixinOrigin = c?.ownerId && c.accountId && store.setting(`weixin:context:${c.accountId}:${c.ownerId}`, "")
    ? { channel: "weixin" as const, accountId: c.accountId, senderId: c.ownerId, conversationId: c.ownerId } : null;
  const ding = native.defaultOrigin();
  return [weixinOrigin, ding].filter((o): o is NonNullable<typeof o> => !!o);
};
const app = await buildServer(engine, channel, config, undefined, native, weixin);
let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  await Promise.all([channel.stop(), weixin.stop()]);
  await engine.shutdown();
  await native.close();
  await app.close();
  store.close();
  await unlink(lockPath).catch(() => {});
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
try {
  await app.listen({ host: "127.0.0.1", port: config.port });
  await engine.start();
  native.run();
  void channel.start();
  weixin.start();
  console.log(`个人 AI 工作台：http://127.0.0.1:${config.port}`);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  await shutdown();
  process.exitCode = 1;
}
