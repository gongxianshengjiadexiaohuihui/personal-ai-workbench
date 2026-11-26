import { spawnSync } from "node:child_process";

// Keep release checks sequential: each script owns its temporary Git/SQLite fixtures.
// This list deliberately excludes live-model, desktop restart and queue probes.
const scripts = [
  "verify.ts", "verify-projects.ts", "verify-multirepo.ts",
  "verify-dingtalk-settings.ts", "verify-lifecycle.ts", "verify-native-probe.ts",
  "verify-native-controller.ts", "verify-conversations.ts", "verify-task-query.ts",
  "verify-task-actions.ts", "verify-inbound-media.ts", "verify-ui-presentation.ts",
  "verify-desktop-wake.ts", "verify-desktop-wake-api.ts", "verify-native-monitor.ts",
  "verify-repair-evidence.ts", "verify-weixin-file.ts", "verify-weixin-image.ts",
];
if (process.platform !== "darwin" || Number(process.versions.node.split(".")[0]) < 24) {
  throw new Error("Release verification requires macOS and Node.js 24+");
}
const results = [];
for (const script of scripts) {
  console.log(`\n[release] ${script}`);
  // Force scripted agents even if the caller previously enabled live verification.
  const env = { ...process.env, VERIFY_AGENT: "scripted" };
  delete env.WORKBENCH_IMAGE_SERVER;
  delete env.WORKBENCH_IMAGE_RESULT;
  const result = spawnSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", `scripts/${script}`], {
    stdio: "inherit", env,
  });
  const passed = result.status === 0 && !result.error;
  results.push({ script, passed });
  if (result.error) console.error(result.error.message);
}
console.log(JSON.stringify({ mode: "isolated-scripted-no-real-channel", results }, null, 2));
process.exitCode = results.every(result => result.passed) ? 0 : 1;
