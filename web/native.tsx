import React from "react";
export function NativeControllerPanel({
  status,
  pending,
  save,
  check,
  resolve,
  openTask,
  setDesktopWake,
}: {
  status: any;
  pending: boolean;
  save: (value: unknown) => void;
  check: () => void;
  resolve: (id: string, turnId: string, reason: string) => void;
  openTask: (id: string) => void;
  setDesktopWake: (enabled: boolean) => void;
}) {
  if (!status) return null;
  return (
    <section className="panel padded settings-card native-settings">
      <div className="section-title">
        <h2>Codex App 主控</h2>
        <span className="pill">
          {status.enabled ? "新消息由 App 主控理解" : "尚未启用"}
        </span>
      </div>
      <p>{status.connection}</p>
      {status.pausedReason && (
        <p className="error-text">{status.pausedReason}</p>
      )}
      {!!status.blockers?.length && (
        <div className="error-text">
          <p>
            消息投递受阻：{status.blockers.length} 条回合待核对；同会话有{" "}
            {status.blockers.reduce((n: number, b: any) => n + b.waiting, 0)}{" "}
            条消息等待。App 在线不代表消息已投递。
          </p>
          <a
            href="#native-messages"
            onClick={(e) => {
              const panel = e.currentTarget
                .closest("section")
                ?.querySelector<HTMLDetailsElement>(".settings-diagnostics");
              if (panel) panel.open = true;
            }}
          >
            查看并核对消息
          </a>
        </div>
      )}
      <form
        className="form-grid"
        key={`${status.mainThreadId}:${status.enabled}`}
        onSubmit={(e) => {
          e.preventDefault();
          const d = new FormData(e.currentTarget);
          save({
            enabled: d.get("enabled") === "on",
            authentication: d.get("authentication"),
            mainThreadId: d.get("mainThreadId"),
            projectId: d.get("projectId"),
            directory: d.get("directory"),
            inspections: d.get("inspections") === "on",
          });
        }}
      >
        <label>
          主控认证方式
          <select
            name="authentication"
            defaultValue={status.authentication || "subscription"}
          >
            <option value="subscription">ChatGPT 订阅与官方模型</option>
            <option value="existing">沿用现有提供方（可能使用 API）</option>
          </select>
        </label>
        <label>
          App 项目 ID
          <input name="projectId" defaultValue={status.projectId} />
        </label>
        <label>
          总控会话 ID
          <input name="mainThreadId" defaultValue={status.mainThreadId} />
        </label>
        <label>
          主控项目目录
          <input
            name="directory"
            defaultValue={status.directory}
            placeholder="/path/to/personal-workstation-control"
          />
        </label>
        <label>
          <input
            type="checkbox"
            name="enabled"
            defaultChecked={status.enabled}
          />{" "}
          对新消息启用 App 主控
        </label>
        <label>
          <input
            type="checkbox"
            name="inspections"
            defaultChecked={status.inspections}
          />{" "}
          工作日 09:00（上海）只读增量巡检
        </label>
        <button disabled={pending}>保存并核对绑定</button>
      </form>
      <p>
        主控及项目会话自动唤醒（实验性）：
        {status.desktopWake?.enabled ? "已启用" : "未启用"}。可能切换 Codex App
        页面；仅尝试启用后的新消息，不重投原消息。
      </p>
      {status.desktopWake?.enabled && status.desktopWake?.blockedReason && (
        <p className="error-text">
          自动唤醒暂不可用：{status.desktopWake.blockedReason}。
        </p>
      )}
      <button
        type="button"
        disabled={pending || (!status.enabled && !status.desktopWake?.enabled)}
        onClick={() => setDesktopWake(!status.desktopWake?.enabled)}
      >
        {status.desktopWake?.enabled ? "关闭自动唤醒" : "启用自动唤醒"}
      </button>
      {!!status.desktopWake?.recent?.length && (
        <p className="muted">
          最近唤醒请求：
          {(
            {
              claimed: "已记录，等待核对",
              requested: "已请求打开，仍需核对原回合",
              uncertain: "结果不明，未重试",
              canceled: "已取消",
              observed: "已观察到原消息回合",
              reviewed: "已人工核对",
            } as any
          )[status.desktopWake.recent[0].state] || "等待核对"}
          。
        </p>
      )}
      <p className="muted">
        历史任务保持原模式。App 离线时暂停新执行组，已有执行可完成并保存证据。每
        5 分钟检查遗漏事项，无变化不调用模型。合并仍需你在 Web 或钉钉确认。
      </p>
      <button disabled={pending} onClick={check}>
        检查主控认证与记忆
      </button>
      {status.mainThreadId && (
        <p>
          <a
            href={`codex://threads/${encodeURIComponent(status.mainThreadId)}`}
          >
            打开总控会话
          </a>
        </p>
      )}
      <details className="settings-diagnostics">
        <summary>诊断信息与活动记录</summary>
        <dl>
          <dt>主控账号类型</dt>
          <dd>{status.diagnostics?.account?.type || "尚未检查"}</dd>
          <dt>套餐</dt>
          <dd>{status.diagnostics?.account?.planType || "未知"}</dd>
          <dt>提供方 / 模型</dt>
          <dd>
            {status.diagnostics?.thread?.provider ||
              status.diagnostics?.configuration?.provider ||
              "未知"}{" "}
            /{" "}
            {status.diagnostics?.thread?.model ||
              status.diagnostics?.configuration?.model ||
              "未知"}
          </dd>
          <dt>原生记忆</dt>
          <dd>
            {status.diagnostics?.memory?.status === "available"
              ? `诊断可用，ready=${status.diagnostics.memory.ready}；不代表专项会话已经使用记忆`
              : "尚未确认；项目知识仍可独立使用"}
          </dd>
        </dl>
        <details>
          <summary>MCP 启动配置（不含密钥）</summary>
          <pre>
            {JSON.stringify(
              { mcpServers: { personal_workstation: status.mcp } },
              null,
              2,
            )}
          </pre>
          <p>
            将此 stdio
            服务接入主控项目。凭据保存在本机数据目录，工具不提供批准合并或启用长期规则能力。
          </p>
        </details>
        <h3>等待主控处理（{status.pending.length}）</h3>
        {status.pending.map((e: any) => (
          <p key={e.id}>
            <code>{e.taskId || "巡检"}</code> · {e.kind} · {e.delivery}{" "}
            {e.threadId && (
              <a href={`codex://threads/${encodeURIComponent(e.threadId)}`}>
                查看会话
              </a>
            )}
          </p>
        ))}
        <h3 id="native-messages">渠道对话与自动回复</h3>
        <p className="muted">
          按来源消息关联原生回合，只回传该回合最终答复。“待核对”表示发送回执未知，系统不会盲目重发。
        </p>
        {!(status.messages || []).length && <p>尚无新入口消息。</p>}
        {(status.messages || []).map((m: any) => (
          <details key={m.id}>
            <summary>
              {m.kind === "user"
                ? "用户消息"
                : m.kind === "control"
                  ? "直达控制"
                  : m.kind === "executor"
                    ? "项目会话"
                    : "任务汇报"}{" "}
              ·{" "}
              {
                (
                  {
                    pending: "排队",
                    queued: "已投递",
                    running: "处理中",
                    completed: "已完成",
                    failed: "失败",
                    uncertain: "待核对",
                    interrupted_reviewed: "已核对中断",
                  } as any
                )[m.status]
              }{" "}
              · {new Date(m.createdAt).toLocaleString("zh-CN")}
            </summary>
            <p>
              <code>{m.id}</code> · {m.origin?.channel || "工作台事件"}
            </p>
            <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {m.content}
            </pre>
            {m.taskIds.length > 0 && (
              <p>
                关联任务：
                {m.taskIds.map((id: string) => (
                  <button key={id} onClick={() => openTask(id)}>
                    {id}
                  </button>
                ))}
              </p>
            )}
            <p>
              <a href={`codex://threads/${encodeURIComponent(m.threadId)}`}>
                打开负责会话
              </a>{" "}
              · 回合：<code>{m.turnId || "等待分配"}</code>
            </p>
            {m.coveredBy && (
              <p>
                统一汇报来源：<code>{m.coveredBy}</code>
              </p>
            )}
            {m.error && <p className="error-text">{m.error}</p>}
            {m.resolution && (
              <p>
                核对结案：{m.resolution.actor} ·{" "}
                {new Date(m.resolution.at).toLocaleString("zh-CN")} ·{" "}
                {m.resolution.reason}
              </p>
            )}
            {m.status === "uncertain" && m.turnId && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const reason = String(
                    new FormData(e.currentTarget).get("reason") || "",
                  );
                  if (
                    window.confirm(
                      "请确认已核对该会话回合和业务操作，确认回合已中断。结案后后续消息将继续投递；原消息不会重发。继续吗？",
                    )
                  )
                    resolve(m.id, m.turnId, reason);
                }}
              >
                <p>
                  请先打开负责会话并核对回合及关联任务的实际操作。仅在确认回合已中断且操作结果已核对后结案。
                </p>
                <label>
                  核对依据
                  <textarea
                    name="reason"
                    required
                    minLength={10}
                    maxLength={2000}
                    placeholder="记录回合状态及业务操作核对结果（至少 10 字）"
                  />
                </label>
                <button disabled={pending}>确认中断并解除阻塞</button>
              </form>
            )}
            {m.finalText && (
              <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                {m.finalText}
              </pre>
            )}
            {m.replies.map((r: any) => (
              <p key={r.id}>
                回复第 {(r.part ?? 0) + 1} 段：
                {
                  (
                    {
                      pending: "待发送",
                      sending: "发送中",
                      sent: "已发送",
                      uncertain: "待核对（未自动重发）",
                    } as any
                  )[r.status]
                }{" "}
                {r.error && <span className="error-text">{r.error}</span>}
              </p>
            ))}
          </details>
        ))}
        {status.inspections?.map((e: any) => (
          <details key={e.id}>
            <summary>
              巡检 {new Date(e.createdAt).toLocaleString("zh-CN")} · {e.status}
            </summary>
            <pre>{e.result?.summary || "等待主控只读分析"}</pre>
          </details>
        ))}
      </details>
    </section>
  );
}
