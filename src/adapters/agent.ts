export interface AgentEvent {
  type: string;
  message: string;
  detail?: unknown;
}
export interface AgentInput {
  cwd: string;
  prompt: string;
  role: "controller" | "executor" | "reviewer";
  schema: Record<string, unknown>;
  sessionId?: string | null;
  signal?: AbortSignal;
  onSession: (id: string) => void;
  onTurn?: (id: string) => void;
  onEvent?: (event: AgentEvent) => void;
}
export interface AgentResult {
  sessionId: string;
  turnId: string;
  output: string;
  usage: unknown;
}
export interface AgentAdapter {
  capabilities(): {
    id: string;
    resume: boolean;
    interrupt: boolean;
    structuredOutput: boolean;
  };
  start(input: AgentInput): Promise<AgentResult>;
  resume(input: AgentInput & { sessionId: string }): Promise<AgentResult>;
  observe(sessionId: string, cwd: string): Promise<unknown>;
  interrupt(sessionId: string): Promise<void>;
}
