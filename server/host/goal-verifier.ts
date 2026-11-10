// Independent verification of a goal's completion, after Grok Build's goal verifier (xai-org/grok-build,
// crates/xai-grok-shell/src/session/templates/goal_verifier_prompt.md, Apache-2.0): before a goal may complete, a fresh
// thread on another model checks the claim and refutes it by default.
import type { ModelSelection } from "../../shared/wire.ts";
import type { ModelMenu } from "../routes/internal-models.ts";
import { GROUP_GOAL_CONTROL_CLOSE, GROUP_GOAL_CONTROL_OPEN } from "../group-goal-run.ts";
import type { HostTurnResult } from "../coordinator.ts";
import { OUTSIDE } from "../peer-provenance.ts";
import type { BotRecord, Message, Store } from "../store.ts";
import type { GoalTurns } from "./goal-turns.ts";

export type GoalVerdict =
  | { verdict: "pass"; reason: string; by: string }
  | { verdict: "refute"; reason: string; by: string }
  /** The verifier could not check the claim, gave no verdict, or did not run: the person decides. */
  | { verdict: "unverifiable"; reason: string; by: string };

export interface GoalCheck {
  bot: BotRecord;
  /** The conversation the goal runs in. */
  threadId: string;
  goal: string;
  /** The worker's final report, envelope removed. */
  report: string;
}

const TRANSCRIPT_MAX_CHARS = 12_000;

export interface GoalVerifierDeps {
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
  /** The model to check with: another vendor's when one can run, else another model, else the bot's own in a fresh thread. */
  verifierModel(bot: BotRecord, threadId: string): ModelSelection;
  modelName(selection: ModelSelection): string;
}

/** Another vendor's model when one can run, else another model on the same engine, else the current one in a fresh thread. */
export function pickVerifierModel(menu: Pick<ModelMenu, "current" | "engines">, driverOf: (instanceId: string) => string | undefined): ModelSelection {
  const usable = menu.engines.flatMap((engine) => (engine.models ?? []).map((model) => ({ instanceId: engine.instanceId, model: typeof model === "string" ? model : model.id })));
  const vendor = driverOf(menu.current.instanceId);
  return usable.find((selection) => driverOf(selection.instanceId) !== vendor)
    ?? usable.find((selection) => selection.instanceId === menu.current.instanceId && selection.model !== menu.current.model)
    ?? menu.current;
}

/** The goal conversation's own words, newest kept, so the verifier reads the work without the implementer's context. */
export function goalTranscript(messages: readonly Message[]): string {
  const lines = messages
    .filter((message) => message.kind === "text" && typeof message.text === "string" && message.text.trim())
    .map((message) => `${message.role === "user" ? "Person" : "Bot"}: ${message.text!.trim()}`);
  let text = "";
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const next = `${lines[index]}\n\n${text}`;
    if (next.length > TRANSCRIPT_MAX_CHARS) break;
    text = next;
  }
  return text.trim();
}

export function verifierInstructions(check: Pick<GoalCheck, "goal" | "report">, transcript: string): string {
  return [
    "You are an independent verifier. A different model worked on the goal below and claims it is complete.",
    "Your job is to check that claim, not to help finish the work. Assume it is NOT complete until you find evidence that it is.",
    `Goal: ${check.goal}`,
    `The worker's final report: ${check.report || "(none)"}`,
    "The goal conversation, oldest first (it may be cut at the start):",
    "<conversation>",
    transcript || "(empty)",
    "</conversation>",
    "Check every part the goal asks for. Where the work left files, pages or other outputs you can reach with your tools, open them and check them yourself; do not trust the report's description.",
    "Do not fix, redo or extend the work. Do not ask the person anything.",
    "Write a short verdict for the person in the language of the goal, then end with exactly one private line:",
    `${GROUP_GOAL_CONTROL_OPEN}{"verdict":"pass","reason":"The evidence you checked"}${GROUP_GOAL_CONTROL_CLOSE}`,
    'Use "refute" when something the goal requires is missing or wrong, and say exactly what to fix. Use "unverifiable" when you cannot check the claim with what you can reach, or the report contradicts what you see. Use "pass" only with evidence.',
    "Never mention the private line in your text.",
  ].join("\n");
}

/** The last complete envelope wins; anything else is no verdict. */
export function parseVerdict(text: string): { verdict: GoalVerdict["verdict"]; reason: string } | null {
  const closeAt = text.lastIndexOf(GROUP_GOAL_CONTROL_CLOSE);
  const openAt = closeAt < 0 ? -1 : text.lastIndexOf(GROUP_GOAL_CONTROL_OPEN, closeAt);
  if (openAt < 0) return null;
  try {
    const raw = JSON.parse(text.slice(openAt + GROUP_GOAL_CONTROL_OPEN.length, closeAt)) as Record<string, unknown>;
    const reason = typeof raw.reason === "string" ? raw.reason.trim().slice(0, 600) : "";
    if ((raw.verdict === "pass" || raw.verdict === "refute" || raw.verdict === "unverifiable") && reason) return { verdict: raw.verdict, reason };
  } catch {
  }
  return null;
}

export function createGoalVerifier(deps: GoalVerifierDeps) {
  const { store } = deps;
  return async function verify(check: GoalCheck): Promise<GoalVerdict> {
    const selection = deps.verifierModel(check.bot, check.threadId);
    const by = deps.modelName(selection);
    const unverifiable = (reason: string): GoalVerdict => ({ verdict: "unverifiable", reason, by });
    const goalTask = store.taskByThread(check.bot.id, check.threadId);
    const opener = { botId: check.bot.id, name: check.bot.name, threadId: check.threadId, at: Date.now() };
    const task = store.createTask(check.bot.id, `Check: ${check.goal}`.slice(0, 80), false, goalTask?.projectId, opener, undefined, selection,
      goalTask?.cwd ?? undefined);
    if (!task) return unverifiable("the check could not open a thread");
    store.appendMessage(task.threadId, { role: "bot", kind: "activity", tool: { name: `Independent check by ${by}: ${check.goal}`.slice(0, 300), ok: true } });
    let settle!: (outcome: HostTurnResult) => void;
    const settled = new Promise<HostTurnResult>((resolve) => { settle = resolve; });
    const lead = deps.turns.begin(task.threadId);
    let outcome: "settled" | "provider_failed" | "dispatch_failed" | "stalled" = "dispatch_failed";
    try {
      try {
        await deps.startTurn(check.bot.id, verifierInstructions(check, goalTranscript(store.messagesFor(check.threadId))), {
          threadId: task.threadId,
          cardContinuation: true,
          // The check acts for nobody: it reads the work and reports.
          origin: OUTSIDE,
          unattended: deps.isUnattended(check.bot.id, task.threadId),
          onSettled: settle,
        });
      } catch (error) {
        return unverifiable(`the check could not start: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300));
      }
      const result = await settled;
      outcome = result.stalled ? "stalled" : result.ok ? "settled" : "provider_failed";
      if (!result.ok) return unverifiable(`the check did not finish: ${result.text}`.slice(0, 300));
      const parsed = parseVerdict(lead.assistantItems.join("\n"));
      return parsed ? { ...parsed, by } : unverifiable("the check gave no verdict");
    } finally {
      deps.turns.end(task.threadId, lead, outcome);
    }
  };
}

export type GoalVerifier = ReturnType<typeof createGoalVerifier>;
