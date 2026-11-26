import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
const action = process.argv[2] || "print",
  root = process.cwd(),
  label = "local.personal-ai-workbench";
if (process.platform !== "darwin")
  throw new Error("LaunchAgent 仅适用于 macOS");
const file = path.join(
    os.homedir(),
    "Library",
    "LaunchAgents",
    `${label}.plist`,
  ),
  logs = path.join(root, ".data", "logs");
const esc = (s) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${esc(process.execPath)}</string><string>--env-file-if-exists=${esc(path.join(root, ".env"))}</string><string>${esc(path.join(root, "dist/index.js"))}</string></array><key>WorkingDirectory</key><string>${esc(root)}</string><key>EnvironmentVariables</key><dict><key>PATH</key><string>${esc(process.env.PATH || "/usr/local/bin:/usr/bin:/bin")}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StandardOutPath</key><string>${esc(path.join(logs, "service.log"))}</string><key>StandardErrorPath</key><string>${esc(path.join(logs, "error.log"))}</string></dict></plist>\n`;
const run = (args) => {
  const r = spawnSync("launchctl", args, { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`launchctl ${args[0]} 失败`);
};
if (action === "print") console.log(plist);
else if (action === "install") {
  if (!existsSync(path.join(root, "dist/index.js")))
    throw new Error("请先 npm run build");
  if (existsSync(file))
    throw new Error("已有 LaunchAgent 配置，请先卸载旧配置后安装");
  await mkdir(path.dirname(file), { recursive: true });
  await mkdir(logs, { recursive: true });
  await writeFile(file, plist, { mode: 0o600 });
  run(["bootstrap", `gui/${process.getuid()}`, file]);
  console.log(`已安装 ${file}`);
} else if (action === "uninstall") {
  const current = await readFile(file, "utf8");
  if (!current.includes(esc(root)))
    throw new Error("该 LaunchAgent 不属于当前项目目录");
  run(["bootout", `gui/${process.getuid()}`, file]);
  const { unlink } = await import("node:fs/promises");
  await unlink(file);
  console.log("已停止并移除本项目的 LaunchAgent");
} else throw new Error("用法：npm run launchagent -- print|install|uninstall");
