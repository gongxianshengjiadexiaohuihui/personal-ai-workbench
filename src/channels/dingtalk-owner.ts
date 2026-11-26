import type { DingTalkConfig } from "../dingtalk-config.js";

/** Resolve with the proposed credentials, without changing the running channel. */
export async function resolveDingTalkOwner(
  input: Pick<DingTalkConfig, "clientId" | "clientSecret"> & {
    ownerMobile: string;
  },
  request: typeof fetch = fetch,
): Promise<string> {
  try {
    const tokenResponse = await request(
      "https://api.dingtalk.com/v1.0/oauth2/accessToken",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          appKey: input.clientId,
          appSecret: input.clientSecret,
        }),
        signal: AbortSignal.timeout(15000),
      },
    );
    const token = await tokenResponse.json();
    if (
      !tokenResponse.ok ||
      typeof token.accessToken !== "string" ||
      !token.accessToken
    )
      throw new LookupError(
        "钉钉应用认证失败，请检查 AppKey 和 AppSecret；原配置未修改。",
      );
    const response = await request(
      `https://oapi.dingtalk.com/topapi/v2/user/getbymobile?access_token=${encodeURIComponent(token.accessToken)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mobile: input.ownerMobile }),
        signal: AbortSignal.timeout(15000),
      },
    );
    const body = await response.json();
    if (
      !response.ok ||
      body.errcode !== 0 ||
      typeof body.result?.userid !== "string" ||
      !body.result.userid.trim()
    ) {
      // Do not surface upstream messages or URLs: they may contain tokens or phone numbers.
      const code = Number.isSafeInteger(body.errcode)
        ? `（错误码 ${body.errcode}）`
        : "";
      throw new LookupError(
        `无法按手机号查询企业成员${code}。请确认手机号属于当前企业、应用已开通“根据手机号查询用户”权限及相应通讯录可见范围；原配置未修改。`,
      );
    }
    return body.result.userid.trim();
  } catch (error) {
    if (error instanceof LookupError) throw error;
    throw new Error("钉钉手机号查询未完成，请检查网络后重试；原配置未修改。");
  }
}
class LookupError extends Error {}
