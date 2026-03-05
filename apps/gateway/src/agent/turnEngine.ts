export type CanonicalTurnEvent =
  | { type: "model_text_delta"; text: string }
  | { type: "model_tool_call"; callId: string; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; callId: string; name: string; ok: boolean; output: unknown; error?: string }
  | { type: "model_done"; finishReason?: string }
  | { type: "model_error"; error: string };

export type RunOutcome = {
  status: "completed" | "failed" | "aborted";
  reason: string;
  reasonCodes: string[];
  detail?: Record<string, unknown> | null;
};

type TurnEngineSnapshot = {
  turn: number;
  totalToolCalls: number;
  totalToolResults: number;
  totalModelErrors: number;
  totalModelTextDeltas: number;
  canonicalEventCount: number;
};

const DEFAULT_OUTCOME: RunOutcome = {
  status: "completed",
  reason: "completed",
  reasonCodes: ["completed"],
};

const MAX_CANONICAL_EVENTS = 200;

export class TurnEngine {
  private outcome: RunOutcome = { ...DEFAULT_OUTCOME };
  private turn = 0;
  private totalToolCalls = 0;
  private totalToolResults = 0;
  private totalModelErrors = 0;
  private totalModelTextDeltas = 0;
  private readonly canonicalEvents: CanonicalTurnEvent[] = [];

  reset(): void {
    this.outcome = { ...DEFAULT_OUTCOME };
    this.turn = 0;
    this.totalToolCalls = 0;
    this.totalToolResults = 0;
    this.totalModelErrors = 0;
    this.totalModelTextDeltas = 0;
    this.canonicalEvents.splice(0, this.canonicalEvents.length);
  }

  setTurn(turn: number): void {
    this.turn = Math.max(0, Math.floor(Number(turn) || 0));
  }

  setOutcome(next: RunOutcome): void {
    this.outcome = {
      status: next.status,
      reason: String(next.reason ?? "").trim() || (next.status === "completed" ? "completed" : next.status),
      reasonCodes: Array.isArray(next.reasonCodes)
        ? next.reasonCodes.map((x) => String(x ?? "").trim()).filter(Boolean).slice(0, 32)
        : [next.status],
      detail: next.detail ?? null,
    };
  }

  getOutcome(): RunOutcome {
    return this.outcome;
  }

  record(event: CanonicalTurnEvent): void {
    this.canonicalEvents.push(event);
    if (this.canonicalEvents.length > MAX_CANONICAL_EVENTS) {
      this.canonicalEvents.splice(0, this.canonicalEvents.length - MAX_CANONICAL_EVENTS);
    }

    if (event.type === "model_tool_call") this.totalToolCalls += 1;
    if (event.type === "tool_result") this.totalToolResults += 1;
    if (event.type === "model_error") this.totalModelErrors += 1;
    if (event.type === "model_text_delta") this.totalModelTextDeltas += 1;
  }

  getSnapshot(): TurnEngineSnapshot {
    return {
      turn: this.turn,
      totalToolCalls: this.totalToolCalls,
      totalToolResults: this.totalToolResults,
      totalModelErrors: this.totalModelErrors,
      totalModelTextDeltas: this.totalModelTextDeltas,
      canonicalEventCount: this.canonicalEvents.length,
    };
  }
}
