import { z } from "zod";
export type Status =
  | "clarifying"
  | "queued"
  | "running"
  | "verifying"
  | "awaiting_approval"
  | "delivered"
  | "blocked"
  | "cancelled";
export interface Base {
  id: string;
  createdAt: string;
  updatedAt: string;
}
export interface Repository extends Base {
  repoPath: string;
  commonDir: string;
}
export interface ProjectRepository {
  repositoryId: string;
  name: string;
  repoPath: string;
  commonDir: string;
  baseBranch: string;
  deliveryMode: "local" | "github";
  githubRepo: string;
  verifyCommands: string[];
  runtimeKey: string;
  issues: string[];
}
export interface Project extends Base {
  source?: { kind: "codex"; id: string };
  repositories?: ProjectRepository[];
  name: string;
  repoPath: string;
  deliveryMode: "local" | "github";
  githubRepo: string;
  baseBranch: string;
  verifyCommands: string[];
  runtimeKey: string;
  instructions: string;
}
export interface Task extends Base {
  controllerMode?: "legacy" | "native";
  sourceMessageId?: string;
  revision?: number;
  projectId: string;
  parentId: string | null;
  groupId: string | null;
  title: string;
  goal: string;
  criteria: string[];
  status: Status;
  question: string;
  summary: string;
  controllerSession: string | null;
  source: "web" | "dingtalk" | "weixin";
  messageOrigin?: MessageOrigin;
  interventions: number;
}
export interface Group extends Base {
  repositoryId?: string;
  repository?: ProjectRepository;
  projectId: string;
  requestId: string;
  title: string;
  goal: string;
  criteria: string[];
  taskIds: string[];
  dependsOn: string[];
  runtimeKey: string;
  status: Status;
  branch: string;
  worktree: string;
  baseSha: string;
  headSha: string;
  sessionId: string | null;
  reworks: number;
  feedback: string;
  lastSummaryAt: string;
  lastSummary: string;
  progress: string;
}
export interface Run extends Base {
  groupId: string | null;
  taskId: string;
  role: "controller" | "executor" | "reviewer";
  sessionId: string | null;
  turnId: string | null;
  status: "running" | "completed" | "failed" | "interrupted";
  summary: string;
  error: string;
  usage: unknown;
  skillVersions: Record<string, string>;
}
export interface Evidence extends Base {
  groupId: string;
  headSha: string;
  command: string;
  exitCode: number | null;
  logPath: string;
  summary: string;
  artifacts: string[];
}
export interface Delivery extends Base {
  repositoryId?: string;
  repositoryName?: string;
  groupId: string;
  requestId: string;
  mode: "local" | "github";
  repo: string;
  base: string;
  baseSha: string;
  branch: string;
  headSha: string;
  url: string;
  number: number;
  token: string;
  status: "pending" | "approved" | "merging" | "merged" | "stale" | "cancelled";
  approvedAt: string | null;
  mergeSha: string | null;
}
export interface WorkEvent extends Base {
  taskId: string | null;
  groupId: string | null;
  type: string;
  message: string;
  detail: unknown;
}
export interface Outbox extends Base {
  message: string;
  taskIds?: string[];
  weixinMessageId?: string;
  imagePath?: string;
  filePath?: string;
  fileName?: string;
  status: "pending" | "sending" | "uncertain" | "sent";
  recipientId?: string;
  origin?: MessageOrigin;
  batchId?: string;
  part?: number;
  attempts: number;
  nextAt: string;
  error: string;
}
export interface Skill extends Base {
  projectId: string;
  name: string;
  content: string;
  status: "draft" | "active";
  version: string;
}
export interface MessageOrigin {
  channel: "dingtalk" | "weixin";
  accountId?: string;
  senderId: string;
  conversationId: string;
}
export interface Inbox extends Base {
  origin?: MessageOrigin;
  routing?: "legacy" | "native";
  content: string;
  mediaItems?: Array<{ kind: "image" | "file"; name?: string; media?: any; aeskey?: string; downloadCode?: string; length?: string; md5?: string }>;
  attachments?: Array<{ kind: "image" | "file"; name: string; path: string; size: number; sha256: string }>;
  quotedMessageId?: string;
  hasQuote?: boolean;
  status: "pending" | "processed" | "failed";
  error: string;
}
export interface Tables {
  repositories: Repository;
  projects: Project;
  tasks: Task;
  groups: Group;
  runs: Run;
  evidence: Evidence;
  deliveries: Delivery;
  events: WorkEvent;
  outbox: Outbox;
  skills: Skill;
  inbox: Inbox;
}
export const repositoryInput = z
  .object({
    name: z.string().trim().max(100).default(""),
    repoPath: z.string().min(1),
    baseBranch: z
      .string()
      .regex(/^[\w./-]+$/)
      .default("main"),
    deliveryMode: z.enum(["local", "github"]).default("local"),
    githubRepo: z.string().default(""),
    verifyCommands: z.array(z.string().trim().min(1)).default([]),
    runtimeKey: z.string().default(""),
  })
  .refine(
    (p) =>
      p.deliveryMode === "local" || /^[\w.-]+\/[\w.-]+$/.test(p.githubRepo),
    {
      message: "GitHub 模式需要 owner/repo",
    },
  );
export const projectInput = z.union([
  z.object({
    name: z.string().trim().min(1).max(100),
    instructions: z.string().default(""),
    repositories: z.array(repositoryInput).min(1).max(32),
  }),
  repositoryInput
    .and(
      z.object({
        name: z.string().trim().min(1).max(100),
        instructions: z.string().default(""),
      }),
    )
    .transform((p) => ({
      name: p.name,
      instructions: p.instructions,
      repositories: [p],
    })),
]);
export function repositoriesOf(p: Project): ProjectRepository[] {
  return (
    p.repositories ?? [
      {
        repositoryId: `legacy:${p.repoPath}`,
        name: p.name,
        repoPath: p.repoPath,
        commonDir: p.repoPath,
        baseBranch: p.baseBranch,
        deliveryMode: p.deliveryMode,
        githubRepo: p.githubRepo,
        verifyCommands: p.verifyCommands,
        runtimeKey: p.runtimeKey,
        issues: p.verifyCommands.length ? [] : ["请配置验证命令"],
      },
    ]
  );
}
export function projectForGroup(p: Project, g: Group): Project {
  const r =
    g.repository ??
    repositoriesOf(p).find((r) => r.repositoryId === g.repositoryId) ??
    (repositoriesOf(p).length === 1 ? repositoriesOf(p)[0] : undefined);
  if (!r) throw new Error("执行组未绑定有效仓库");
  return { ...p, ...r, name: `${p.name} / ${r.name}` };
}
export function projectIssues(p: Project): string[] {
  return repositoriesOf(p).flatMap((r) =>
    r.issues.map((issue) => `${r.name}: ${issue}`),
  );
}
export const requestInput = z.object({
  projectId: z.string(),
  title: z.string().trim().min(1).max(160),
  goal: z.string().trim().min(1).max(30000),
});
export const planSchema = z.object({
  action: z.enum(["plan", "clarify"]),
  summary: z.string(),
  question: z.string(),
  groups: z
    .array(
      z.object({
        key: z.string(),
        repositoryId: z.string().optional(),
        title: z.string(),
        goal: z.string(),
        criteria: z.array(z.string()).min(1),
        dependsOn: z.array(z.string()),
        tasks: z
          .array(
            z.object({
              title: z.string(),
              goal: z.string(),
              criteria: z.array(z.string()).min(1),
            }),
          )
          .min(1),
      }),
    )
    .max(8),
});
export const reviewSchema = z.object({
  decision: z.enum(["pass", "rework", "human"]),
  summary: z.string(),
  feedback: z.string(),
  artifacts: z.array(z.string()),
});
export const executionSchema = z.object({
  summary: z.string(),
  blocked: z.boolean(),
  question: z.string(),
  artifacts: z.array(z.string()),
});
export const now = () => new Date().toISOString();
export const labels: Record<Status, string> = {
  clarifying: "待明确",
  queued: "待执行",
  running: "执行中",
  verifying: "验证中",
  awaiting_approval: "待交付确认",
  delivered: "已交付",
  blocked: "阻塞",
  cancelled: "取消",
};
