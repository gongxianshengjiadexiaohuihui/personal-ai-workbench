import { createInterface } from "node:readline";
import { readFile } from "node:fs/promises";
import path from "node:path";

// stdio MCP 仅转发控制平面白名单，不持有用户 Web 令牌，也不暴露合并、启用规则或通道配置。
const dataDir = path.resolve(process.argv[2] || ".data"), port = Number(process.argv[3] || 48761);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid local port");
const token = (await readFile(path.join(dataDir, "native/mcp-token"), "utf8")).trim();
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const str = { type: "string", minLength: 1 };
const tools = [
  { name: "create_request", description: "仅在用户明确要求执行时创建需求；咨询不建任务。微信或钉钉需求填写 sourceMessageId，operationId 稳定复用。使用 Codex App list_projects，按工作台项目名称和仓库根目录找到唯一 App 项目，使用 App 返回的 projectId 创建会话，再调用 bind_task 派发；source.id 不是 App projectId。", inputSchema: object({ projectId: str, title: str, goal: str, sourceMessageId: str, operationId: str }, ["projectId", "title", "goal", "operationId"]) },
  { name: "list_tasks", description: "查询包括历史任务在内的根任务，可按项目筛选。", inputSchema: object({ projectId: str }) },
  { name: "query_tasks", description: "只读查询所有工作台根任务及数量、最新阶段和待处理事项，可按分类、项目或任务编号筛选。自然语言任务查询优先使用此工具；运行记录不代表当前仍在执行，排队不代表已消费。不会创建、恢复或审批任务。", inputSchema: object({ projectId: str, taskId: str, category: { type: "string", enum: ["running", "user", "review", "queued", "completed", "other"] } }) },
  { name: "discover_projects", description: "只读发现本机 Codex 项目及仓库配置，不注册、初始化或修改仓库。", inputSchema: object({}) },
  { name: "task_action", description: "停止或恢复原生任务，先核对任务状态，operationId 必须稳定复用；不提供批准合并。", inputSchema: object({ taskId: str, action: { type: "string", enum: ["stop", "resume"] }, operationId: str }, ["taskId", "action", "operationId"]) },
  { name: "get_context", description: "查询原生主控待处理事件、项目知识、任务、证据及交付状态。省略 taskId 读取总览。", inputSchema: object({ taskId: str }) },
  { name: "bind_task", description: "绑定 App 中已创建的目标项目会话，并排队投递任务供该会话直接执行。返回成功仅表示已排队，不表示执行完成。", inputSchema: object({ taskId: str, threadId: str }, ["taskId", "threadId"]) },
  { name: "send_task_message", description: "把当前渠道用户消息作为补充或确认投递到已绑定的原项目会话。先识别任务；有歧义时向用户澄清。", inputSchema: object({ taskId: str, sourceMessageId: str }, ["taskId", "sourceMessageId"]) },
  { name: "send_task_image", description: "仅当微信用户明确要求发送图片时，将该任务已完成的项目会话最终答复中引用的本机 PNG/JPEG 发给该微信用户。sourceMessageId 必须是关联此任务的授权用户消息；operationId 对同一次图片发送稳定复用。返回排队状态，不代表手机已收到。", inputSchema: object({ taskId: str, sourceMessageId: str, imagePath: str, operationId: str }, ["taskId", "sourceMessageId", "imagePath", "operationId"]) },
  { name: "get_image_delivery", description: "查询 send_task_image 返回的消息编号的微信发送状态；sent 仅代表微信接口接受，不代表用户已读。", inputSchema: object({ outboxId: str }, ["outboxId"]) },
  { name: "send_task_file", description: "仅当微信用户明确要求发送文件时，将该任务已完成项目会话最终答复中以 Markdown 链接引用的本机文件作为附件发送给该微信用户，保留文件名及内容，不按格式限制。sourceMessageId 必须关联此任务且来自当前绑定用户；operationId 对同一次发送稳定复用。返回排队状态，不代表手机已收到。", inputSchema: object({ taskId: str, sourceMessageId: str, filePath: str, operationId: str }, ["taskId", "sourceMessageId", "filePath", "operationId"]) },
  { name: "get_file_delivery", description: "查询 send_task_file 返回的消息编号、关联任务、文件名及微信发送状态；sent 仅代表微信接口接受，不代表用户收到或已读。", inputSchema: object({ outboxId: str }, ["outboxId"]) },
  { name: "decide", description: "提交数据库事件决策。plan: action=plan/clarify, summary, question, groups；已有组补充后 action=dispatch,summary。review: decision=pass/rework/human,summary,feedback,artifacts。inspection: summary；notice: {}。版本必须一致。不会批准合并。", inputSchema: object({ eventId: str, revision: { type: "integer", minimum: 1 }, decision: { type: "object" } }, ["eventId", "revision", "decision"]) },
  { name: "supplement", description: "记录用户在 App 中明确提出的补充，废止旧决策和旧交付确认。operationId 保持幂等。", inputSchema: object({ taskId: str, text: str, operationId: str }, ["taskId", "text", "operationId"]) },
  { name: "get_diff", description: "读取执行组的提交差异，仅支持原生任务。", inputSchema: object({ groupId: str }, ["groupId"]) },
  { name: "get_evidence", description: "读取验证证据及已保存日志，不执行任意命令。", inputSchema: object({ evidenceId: str }, ["evidenceId"]) },
  { name: "skill_draft", description: "保存已交付任务的 Skill 草稿。不会启用长期规则。", inputSchema: object({ taskId: str, name: str, content: str, operationId: str }, ["taskId", "name", "content", "operationId"]) },
];
const respond = (message: unknown) => process.stdout.write(JSON.stringify(message) + "\n");
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  let message: any;
  try {
    if (line.length > 1_000_000) throw new Error("Message too large");
    message = JSON.parse(line);
    if (message.id === undefined) continue;
    let result: any;
    if (message.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "personal_workstation", version: "0.1.0" } };
    else if (message.method === "ping") result = {};
    else if (message.method === "tools/list") result = { tools };
    else if (message.method === "tools/call") {
      if (!tools.some(t => t.name === message.params?.name)) throw new Error("Unknown tool");
      const response = await fetch(`http://127.0.0.1:${port}/api/controller/rpc`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(message.params), signal: AbortSignal.timeout(120000),
      });
      const body = await response.json();
      result = { content: [{ type: "text", text: JSON.stringify(body) }], isError: !response.ok };
    } else { respond({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } }); continue; }
    respond({ jsonrpc: "2.0", id: message.id, result });
  } catch (e) { if (message?.id !== undefined) respond({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: e instanceof Error ? e.message : "Invalid request" } }); }
}
