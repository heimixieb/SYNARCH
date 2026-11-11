// SYNARCH Watchdog: while a goal runs, another model judges whether the work is still progressing toward the goal
// (DeepSeek Super-agent: a Watchdog that is not the worker and not the chief). Official TurnWatchdog / room deadlines
// stop silent turns; this only judges substance. It never writes files or runs the person's task commands.
import type { ModelSelection } from "../shared/wire.ts";
import { GROUP_GOAL_CONTROL_CLOSE, GROUP_GOAL_CONTROL_OPEN } from "./group-goal-run.ts";
import { goalTranscript, pickVerifierModel } from "./host/goal-verifier.ts";
import type { HostTurnResult } from "./coordinator.ts";
import { OUTSIDE } from "./peer-provenance.ts";
import type { BotRecord, Store } from "./store.ts";
import type { GoalTurns } from "./host/goal-turns.ts";
import type { ModelMenu } from "./routes/internal-models.ts";

export type WatchVerdictKind = "ok" | "stuck" | "drifted" | "needs_person";

export type WatchJudgment =
  | { verdict: "ok"; reason: string; by: string }
  | { verdict: "stuck" | "drifted"; reason: string; nudge: string; by: string }
  | { verdict: "needs_person"; reason: string; by: string }
  | { verdict: "skip"; reason: string; by: string };

export type WatchAction =
  | { action: "quiet" }
  | { action: "nudge"; note: string; by: string }
  | { action: "escalate"; reason: string; by: string };

export interface WatchJob {
  threadId: string;
  bot: BotRecord;
  goal: string;
  latest: string;
  turn: number;
}

const TRANSCRIPT_MAX = 8_000;
const REASON_MAX = 400;
const NUDGE_MAX = 280;

export function parseWatchJudgment(text: string): { verdict: WatchVerdictKind; reason: string; nudge?: string } | null {
  const closeAt = text.lastIndexOf(GROUP_GOAL_CONTROL_CLOSE);
  const openAt = closeAt < 0 ? -1 : text.lastIndexOf(GROUP_GOAL_CONTROL_OPEN, closeAt);
  if (openAt < 0) return null;
  try {
    const raw = JSON.parse(text.slice(openAt + GROUP_GOAL_CONTROL_OPEN.length, closeAt)) as Record<string, unknown>;
    const reason = typeof raw.reason === "string" ? raw.reason.trim().slice(0, REASON_MAX) : "";
    if (!reason) return null;
    if (raw.verdict === "ok" || raw.verdict === "needs_person") return { verdict: raw.verdict, reason };
    if (raw.verdict === "stuck" || raw.verdict === "drifted") {
      const nudge = typeof raw.nudge === "string" ? raw.nudge.trim().slice(0, NUDGE_MAX) : "";
      return nudge ? { verdict: raw.verdict, reason, nudge } : null;
    }
  } catch {
  }
  return null;
}

const JUDGMENT_LINE = `${GROUP_GOAL_CONTROL_OPEN}{"verdict":"ok","reason":"What progressed"}${GROUP_GOAL_CONTROL_CLOSE}`;

export function watchdogInstructions(job: Pick<WatchJob, "goal" | "latest">, transcript: string): string {
  return [
    "You are an independent watchdog. Another model is working on the goal below. You do not do the work, do not plan it, and do not replace the chief.",
    "Judge only whether the recent work shows substantive progress toward the goal, is repeating ineffective attempts, or has drifted away from what was asked.",
    "Stay quiet when there is real progress or the work is waiting on a person. Do not invent problems.",
    `Goal: ${job.goal}`,
    `Latest reply from the worker or coordinator: ${job.latest || "(none)"}`,
    "The conversation, oldest first (it may be cut at the start):",
    "<conversation>",
    transcript || "(empty)",
    "</conversation>",
    "Do not open files, run commands, fix the work, or ask the person anything. Judge from this text only.",
    "Write one short sentence for the person in the language of the goal, then end with exactly one private line:",
    JUDGMENT_LINE,
    'Use "ok" when there is substantive progress or a clear wait on the person. Use "stuck" when the same ineffective attempt is repeating. Use "drifted" when the work is real but no longer serves the goal. Use "needs_person" when only the person can decide and the work cannot usefully continue. For stuck or drifted, also set "nudge" to one short actionable correction for the worker or chief (not a progress report).',
    "Never mention the private line in your text.",
  ].join("\n");
}

export const WATCH_REMINDER = [
  "Your watch ended without the private judgment line. Do not re-read the work; reply with only that line for the judgment you reached:",
  JUDGMENT_LINE,
  'Use "ok", "stuck", "drifted" or "needs_person", with reason; stuck/drifted also need nudge.',
].join("\n");

export type WatchState = { nudged: boolean; escalated: boolean };

export function nextWatchAction(state: WatchState, judgment: WatchJudgment): { action: WatchAction; state: WatchState } {
  if (state.escalated || judgment.verdict === "skip" || judgment.verdict === "ok") {
    return { action: { action: "quiet" }, state };
  }
  if (judgment.verdict === "needs_person") {
    return { action: { action: "escalate", reason: judgment.reason, by: judgment.by }, state: { ...state, escalated: true } };
  }
  if (!state.nudged) {
    return { action: { action: "nudge", note: judgment.nudge, by: judgment.by }, state: { ...state, nudged: true } };
  }
  return {
    action: { action: "escalate", reason: `${judgment.reason} (still off track after a watchdog nudge)`, by: judgment.by },
    state: { ...state, escalated: true },
  };
}

export interface SynarchWatchdogDeps {
  store: Pick<Store, "appendMessage" | "createTask" | "messagesFor" | "taskByThread">;
  turns: GoalTurns;
  startTurn(botId: string, text: string, opts: {
    threadId: string;
    cardContinuation: true;
    origin: typeof OUTSIDE;
    unattended: boolean;
    onSettled: (outcome: HostTurnResult) => void;
  }): Promise<unknown>;
  isUnattended(botId: string, threadId: string): boolean;
  judgeModel(bot: BotRecord, threadId: string): ModelSelection;
  modelName(selection: ModelSelection): string;
  off(): boolean;
}

export function createSynarchWatchdog(deps: SynarchWatchdogDeps) {
  const states = new Map<string, WatchState>();
  const { store } = deps;

  function stateOf(threadId: string): WatchState {
    return states.get(threadId) ?? { nudged: false, escalated: false };
  }

  async function judge(job: WatchJob): Promise<WatchJudgment> {
    const selection = deps.judgeModel(job.bot, job.threadId);
    const by = deps.modelName(selection);
    const skip = (reason: string): WatchJudgment => ({ verdict: "skip", reason, by });
    const goalTask = store.taskByThread(job.bot.id, job.threadId);
    const opener = { botId: job.bot.id, name: job.bot.name, threadId: job.threadId, at: Date.now() };
    const task = store.createTask(job.bot.id, `Watch: ${job.goal}`.slice(0, 80), false, goalTask?.projectId, opener, undefined, selection,
      goalTask?.cwd ?? undefined);
    if (!task) return skip("the watchdog could not open a thread");
    store.appendMessage(task.threadId, { role: "bot", kind: "activity", tool: { name: `Watchdog by ${by}: ${job.goal}`.slice(0, 300), ok: true } });
    const turn = async (text: string): Promise<WatchJudgment | { verdict: null }> => {
      let settle!: (outcome: HostTurnResult) => void;
      const settled = new Promise<HostTurnResult>((resolve) => { settle = resolve; });
      const lead = deps.turns.begin(task.threadId);
      let outcome: "settled" | "provider_failed" | "dispatch_failed" | "stalled" = "dispatch_failed";
      try {
        try {
          await deps.startTurn(job.bot.id, text, {
            threadId: task.threadId,
            cardContinuation: true,
            origin: OUTSIDE,
            unattended: deps.isUnattended(job.bot.id, task.threadId),
            onSettled: settle,
          });
        } catch (error) {
          return skip(`the watchdog could not start: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300));
        }
        const result = await settled;
        outcome = result.stalled ? "stalled" : result.ok ? "settled" : "provider_failed";
        if (!result.ok) return skip(`the watchdog did not finish: ${result.text}`.slice(0, 300));
        const parsed = parseWatchJudgment(lead.assistantItems.join("\n"));
        if (!parsed) return { verdict: null };
        if (parsed.verdict === "ok") return { verdict: "ok", reason: parsed.reason, by };
        if (parsed.verdict === "needs_person") return { verdict: "needs_person", reason: parsed.reason, by };
        return { verdict: parsed.verdict, reason: parsed.reason, nudge: parsed.nudge!, by };
      } finally {
        deps.turns.end(task.threadId, lead, outcome);
      }
    };
    const transcript = goalTranscript(store.messagesFor(job.threadId)).slice(-TRANSCRIPT_MAX);
    const first = await turn(watchdogInstructions(job, transcript));
    if (first.verdict) return first;
    const again = await turn(WATCH_REMINDER);
    return again.verdict ? again : skip("the watchdog gave no judgment");
  }

  return {
    forget(threadId: string): void {
      states.delete(threadId);
    },
    async inspect(job: WatchJob): Promise<WatchAction> {
      if (deps.off()) return { action: "quiet" };
      if (job.turn < 2) return { action: "quiet" };
      const prior = stateOf(job.threadId);
      if (prior.escalated) return { action: "quiet" };
      const judgment = await judge(job);
      const next = nextWatchAction(prior, judgment);
      states.set(job.threadId, next.state);
      return next.action;
    },
  };
}

export type SynarchWatchdog = ReturnType<typeof createSynarchWatchdog>;

export function pickWatchdogModel(menu: Pick<ModelMenu, "current" | "engines">, driverOf: (instanceId: string) => string | undefined): ModelSelection {
  return pickVerifierModel(menu, driverOf);
}
