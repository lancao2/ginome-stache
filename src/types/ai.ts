export interface AiWindow {
  id: "session" | "weekly";
  usedPercent: number;
  resetsAt: string | null;
}

export interface AiUsage {
  id: "claude" | "codex" | "gemini";
  name: string;
  status: "ok" | "no_login" | "error" | "unsupported";
  plan: string | null;
  note: string | null;
  windows: AiWindow[];
}
