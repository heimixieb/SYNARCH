// SYNARCH: what each model is good at (tags the person or the chief writes), and the chief starting a goal itself so the
// person never has to type /goal. Both are chief-only tools; index.ts wires the routes inside the internal capability gate.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { RuntimeEvent } from "../shared/runtime-events.ts";
import type { ProviderAdapter } from "./contracts.ts";
import { PASS, type RouteHandler } from "./routes/table.ts";

export const MODEL_TAGS_MAX_CHARS = 200;
export const GOAL_MAX_CHARS = 4_000;

const tagsFile = (dataDir: string) => join(dataDir, "model-tags.json");
/** The same key the scorecard uses, so a model's tags and its record line up. */
export const modelKey = (instanceId: string, model: string) => `${instanceId}/${model}`;

export function readModelTags(dataDir: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(tagsFile(dataDir), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim() !== ""));
  } catch {
    // Tags are advice: a missing or broken file leaves the menu without them.
    return {};
  }
}

/** Empty text removes the model's tags. Written through a temporary file so a crash never leaves half a file. */
export function setModelTags(dataDir: string, instanceId: string, model: string, text: string): Record<string, string> {
  const tags = readModelTags(dataDir);
  const key = modelKey(instanceId, model);
  const clean = text.replace(/\s+/g, " ").trim().slice(0, MODEL_TAGS_MAX_CHARS);
  if (clean) tags[key] = clean;
  else delete tags[key];
  const file = tagsFile(dataDir);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(tags, null, 2));
  renameSync(`${file}.tmp`, file);
  return tags;
}

/** The model menu with each tagged model's tags, listed or not, so the chief sees every strength it was told about. */
export function withModelTags<T extends object>(menu: T | null, dataDir: string): (T & { tags?: Record<string, string> }) | null {
  if (!menu) return menu;
  const tags = readModelTags(dataDir);
  return Object.keys(tags).length ? { ...menu, tags } : menu;
}

const text = (value: unknown) => (typeof value === "string" ? value : "");

export function createSynarchChiefRoutes(deps: {
  dataDir: string;
  requireActive(): void;
  /** The calling bot is a chief of staff. */
  isChief(): boolean;
  /** Why the calling turn may not start a goal: not the person's own request, a room, a routine run, a goal already running. */
  goalRefusal(): string | null;
  startGoal(goal: string): void;
  /** The model the calling bot may run, or why not, exactly as start_thread would judge it. */
  modelRefusal(instanceId: string, model: string): string | null;
}): RouteHandler {
  return async ({ req, res, path, method, json, readBody }) => {
    if (method !== "POST" || (path !== "/api/internal/model-tags" && path !== "/api/internal/goals")) return PASS;
    deps.requireActive();
    if (!deps.isChief()) return json(res, 403, { error: "Only a chief of staff can do this." });
    const body = await readBody(req, 64_000);
    if (path === "/api/internal/model-tags") {
      const instanceId = text(body.instanceId).trim(), model = text(body.model).trim(), tags = text(body.tags);
      if (!instanceId || !model) return json(res, 400, { error: "instanceId and model are required, exactly as list_models gives them." });
      // Removing tags needs no live model: a model that left the menu may still have stale ones.
      const refused = tags.trim() ? deps.modelRefusal(instanceId, model) : null;
      if (refused) return json(res, 400, { error: `Not tagged: ${refused}` });
      setModelTags(deps.dataDir, instanceId, model, tags);
      return json(res, 200, { text: tags.trim() ? `Saved. list_models now shows ${modelKey(instanceId, model)} as good at: ${tags.trim().slice(0, MODEL_TAGS_MAX_CHARS)}` : `Removed the tags of ${modelKey(instanceId, model)}.` });
    }
    const goal = text(body.goal).trim();
    if (!goal) return json(res, 400, { error: "goal is required: the whole job, in the person's own words." });
    if (goal.length > GOAL_MAX_CHARS) return json(res, 400, { error: `goal must be at most ${GOAL_MAX_CHARS} characters.` });
    const refused = deps.goalRefusal();
    if (refused) return json(res, 409, { error: refused });
    try {
      deps.startGoal(goal);
    } catch (error) {
      return json(res, 409, { error: `No goal started: ${error instanceof Error ? error.message : String(error)}` });
    }
    return json(res, 200, { text: "Goal started. Say in one short line that you are on it, then end this turn: the goal run resumes you here, and the work is checked by another model before it counts as done." });
  };
}

// The chief's hands are off in the conversations the person has with it (DeepSeek's Super-agent: the Router carries no
// shell). Its turns there run at Ask, and this fence refuses every permission request that is not one of its team tools
// (an MCP call), with a note to hand the job out; team tools go on to the person's own approval level. Allow-only on
// purpose: an engine may label a sandbox escalation with a bare "tool", so no list of hands-on names is safe.
// Conversations the chief or a check opened (openedBy) and routine runs keep their tools, for the workers it hands to.

/** An MCP call, as Claude (mcp__server__tool), ACP titles (mcp__ / mcp. / mcp:) and Codex ("…MCP server to run tool…") name it. */
export const isTeamToolRequest = (tool: string, summary: string) =>
  /^mcp(?:__|[.:])/i.test(tool.trim()) || /^mcp(?:__|[.:])/i.test(summary.trim()) || /\bMCP server to run tool\b/.test(summary);

export const CHIEF_HANDS_OFF = "Refused: you are the chief, so you plan, hand out and check work, and never run commands or change files yourself here. "
  + "Hand this job to the model whose tags and record fit it with start_thread (model_selection, report_back true), or to a teammate with coordinate_bots, then end your turn.";

/** Said with each turn here, since a refusal reaches some engines (DeepSeek's ACP) without its reason. */
export const CHIEF_ROUTER_NOTE = "\n\n[In this conversation your own file and command tools are off: any write, edit or command is refused, and "
  + "asking the person to approve it will not help. To get a file made or a command run, hand it out: start_thread with "
  + "model_selection (pick by list_models tags and record) and report_back true, or coordinate_bots to a teammate. "
  + "Never give the worker your folder's path: it cannot write there. Have it save in its own folder and attach the file "
  + "with attach_file, then tell the person where it is.]";

type ChiefBot = { chiefOfStaff?: boolean; threadId: string };
type ChiefTask = { openedBy?: unknown; routineRunId?: string } | null | undefined;

/** One of the person's own conversations with the chief: its main one or one they opened, never a routine run. */
export function isChiefRouterThread(bot: ChiefBot | null | undefined, threadId: string, task: ChiefTask, routineRun: boolean): boolean {
  if (!bot?.chiefOfStaff || routineRun) return false;
  if (task) return !task.openedBy && !task.routineRunId;
  return bot.threadId === threadId;
}

type RequestOpened = Extract<RuntimeEvent, { type: "request.opened" }>;
type Say = (message: { role: "bot"; kind: "activity"; tool: { name: string; ok: boolean } }) => unknown;

export function createChiefFence(deps: {
  router(botId: string, threadId: string): boolean;
  adapter(instanceId: string): Pick<ProviderAdapter, "respondToRequest" | "interruptTurn"> | undefined;
  stale(event: RequestOpened): boolean;
  release(threadId: string): void;
}) {
  /** True when the request asked the chief to act with its own hands here, and was refused before any grant or card. */
  function answers(event: RequestOpened, asker: { id: string; modelSelection: { instanceId: string } }, say: Say): boolean {
    if (event.requestType !== "permission" || isTeamToolRequest(event.tool, event.summary) || !deps.router(asker.id, event.threadId)) return false;
    const adapter = deps.adapter(event.providerInstanceId ?? asker.modelSelection.instanceId);
    say({ role: "bot", kind: "activity", tool: { name: `Handed out, not done here: ${event.summary.slice(0, 120)}`, ok: false } });
    void (async () => {
      try {
        if (event.requestId === undefined || !adapter) throw new Error("no request to answer");
        if (await adapter.respondToRequest(event.threadId, event.requestId, { behavior: "deny", message: CHIEF_HANDS_OFF }) === "unavailable") throw new Error("nobody took the answer");
      } catch {
        // A request nobody can refuse must not hang the turn: stop it instead.
        if (event.turnId && !deps.stale(event)) await adapter?.interruptTurn(event.threadId, event.turnId).catch(() => {});
      }
      if (!deps.stale(event)) deps.release(event.threadId);
    })().catch(() => console.error("[chief-fence] Could not refuse a request."));
    return true;
  }
  return { confines: deps.router, answers };
}
