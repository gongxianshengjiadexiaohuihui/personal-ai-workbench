import path from "node:path";
import { z } from "zod";
import { loadDingTalkConfig } from "./dingtalk-config.js";
export function configuration() {
  const env = z
    .object({
      PORT: z.coerce.number().int().min(1024).max(65535).default(48761),
      MAX_CONCURRENT: z.coerce.number().int().min(1).max(8).default(2),
    })
    .parse(process.env);
  const dataDir = path.resolve(process.env.DATA_DIR || ".data");
  return {
    port: env.PORT,
    maxConcurrent: env.MAX_CONCURRENT,
    dataDir,
    codexBin: process.env.CODEX_BIN || "codex",
    model: process.env.CODEX_MODEL || undefined,
    dingtalk: loadDingTalkConfig(dataDir, {
      clientId: process.env.DINGTALK_CLIENT_ID || "",
      clientSecret: process.env.DINGTALK_CLIENT_SECRET || "",
      robotCode: process.env.DINGTALK_ROBOT_CODE || "",
      ownerId: process.env.DINGTALK_OWNER_ID || "",
    }),
  };
}
export type Config = ReturnType<typeof configuration>;
