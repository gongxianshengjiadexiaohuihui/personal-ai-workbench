import { readFileSync } from "node:fs";
import { mkdir, writeFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

export const ownerMobileSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/[\s-]/g, "").replace(/^\+86/, ""))
  .pipe(
    z
      .string()
      .regex(/^1[3-9]\d{9}$/, "请填写中国大陆 11 位手机号，可带 +86 前缀"),
  );

const field = z.string().trim().min(1).max(256);
export const dingtalkConfigSchema = z
  .object({
    clientId: field,
    clientSecret: field,
    robotCode: field,
    ownerId: field,
    ownerMobile: ownerMobileSchema.optional(),
  })
  .strict();
export const dingtalkConfigInput = dingtalkConfigSchema
  .omit({ ownerId: true })
  .extend({
    ownerMobile: ownerMobileSchema,
    clientSecret: z.string().trim().max(256).optional(),
  });
export type DingTalkConfig = z.infer<typeof dingtalkConfigSchema>;

export function loadDingTalkConfig(
  dataDir: string,
  fallback: DingTalkConfig,
): DingTalkConfig {
  try {
    return dingtalkConfigSchema.parse(
      JSON.parse(readFileSync(path.join(dataDir, "dingtalk.json"), "utf8")),
    );
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    // 不将配置文件内容或解析器的原始输入带到日志里。
    throw new Error("本地钉钉配置无法读取，请检查数据目录中的 dingtalk.json");
  }
}

export async function saveDingTalkConfig(
  dataDir: string,
  config: DingTalkConfig,
) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const temp = path.join(dataDir, `.dingtalk-${randomUUID()}.tmp`);
  try {
    // 新文件仅当前用户可读写，原子替换防止中断时写入半份配置。
    await writeFile(temp, JSON.stringify(config, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temp, path.join(dataDir, "dingtalk.json"));
  } finally {
    await rm(temp, { force: true });
  }
}
