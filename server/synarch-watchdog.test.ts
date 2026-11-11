import { describe, expect, it } from "vitest";

import { GROUP_GOAL_CONTROL_CLOSE, GROUP_GOAL_CONTROL_OPEN, runGoalRun, type GoalStepResult } from "./group-goal-run.ts";
import type { Message } from "./store.ts";
import { createGoalTurns } from "./host/goal-turns.ts";
import {
  createSynarchWatchdog,
  nextWatchAction,
  parseWatchJudgment,
  WATCH_REMINDER,
  watchdogInstructions,
} from "./synarch-watchdog.ts";

const line = (payload: unknown) => `${GROUP_GOAL_CONTROL_OPEN}${JSON.stringify(payload)}${GROUP_GOAL_CONTROL_CLOSE}`;
const envelope = (decision: Record<string, string>) => `Update.\n${line(decision)}`;
const settled = (replyText: string): GoalStepResult => ({ ran: true, replyText, outcome: "settled" });

describe("parseWatchJudgment", () => {
  it("reads the last complete judgment and requires a nudge for stuck or drifted", () => {
    expect(parseWatchJudgment(`Fine.\n${line({ verdict: "ok", reason: "wrote the file" })}`))
      .toEqual({ verdict: "ok", reason: "wrote the file" });
    expect(parseWatchJudgment(line({ verdict: "stuck", reason: "same edit twice", nudge: "Try a different failing test first." })))
      .toEqual({ verdict: "stuck", reason: "same edit twice", nudge: "Try a different failing test first." });
    expect(parseWatchJudgment(line({ verdict: "stuck", reason: "looping" }))).toBeNull();
    expect(parseWatchJudgment(line({ verdict: "maybe", reason: "x" }))).toBeNull();
    expect(parseWatchJudgment("no line")).toBeNull();
  });
});

describe("nextWatchAction", () => {
  it("stays quiet on ok or skip, nudges once, then escalates, and escalates needs_person at once", () => {
    expect(nextWatchAction({ nudged: false, escalated: false }, { verdict: "ok", reason: "progress", by: "Pro" }))
      .toEqual({ action: { action: "quiet" }, state: { nudged: false, escalated: false } });
    expect(nextWatchAction({ nudged: false, escalated: false }, { verdict: "skip", reason: "no line", by: "Pro" }).action)
      .toEqual({ action: "quiet" });
    const nudge = nextWatchAction({ nudged: false, escalated: false }, { verdict: "stuck", reason: "loop", nudge: "Change approach", by: "Pro" });
    expect(nudge).toEqual({ action: { action: "nudge", note: "Change approach", by: "Pro" }, state: { nudged: true, escalated: false } });
    expect(nextWatchAction(nudge.state, { verdict: "drifted", reason: "wrong file", nudge: "Back to the goal", by: "Pro" }).action)
      .toEqual({ action: "escalate", reason: "wrong file (still off track after a watchdog nudge)", by: "Pro" });
    expect(nextWatchAction({ nudged: false, escalated: false }, { verdict: "needs_person", reason: "pick a color", by: "Pro" }).action)
      .toEqual({ action: "escalate", reason: "pick a color", by: "Pro" });
    expect(nextWatchAction({ nudged: true, escalated: true }, { verdict: "stuck", reason: "again", nudge: "x", by: "Pro" }).action)
      .toEqual({ action: "quiet" });
  });
});

describe("createSynarchWatchdog", () => {
  async function inspect(replies: string[], opts: { off?: boolean; turn?: number } = {}) {
    const turns = createGoalTurns({ retireProviderTurn: () => {} });
    const prompts: string[] = [];
    const watchdog = createSynarchWatchdog({
      store: {
        appendMessage: () => ({}) as Message,
        createTask: () => ({ threadId: "watch" }) as never,
        messagesFor: () => [],
        taskByThread: () => undefined,
      },
      turns,
      async startTurn(_botId, text, turnOpts) {
        prompts.push(text);
        turns.forEvent({ threadId: "watch" } as never)!.assistantItems.push(replies[prompts.length - 1] ?? "");
        turnOpts.onSettled({ ok: true, text: "" } as never);
      },
      isUnattended: () => true,
      judgeModel: () => ({ instanceId: "ds", model: "pro" }),
      modelName: () => "Pro",
      off: () => opts.off === true,
    });
    const action = await watchdog.inspect({
      bot: { id: "b", name: "B" } as never,
      threadId: "goal",
      goal: "write a.txt",
      latest: "still editing",
      turn: opts.turn ?? 3,
    });
    return { action, prompts, watchdog };
  }

  it("asks once more when the watch forgets its judgment line", async () => {
    const { action, prompts } = await inspect(["看着还行。", line({ verdict: "ok", reason: "file grew" })]);
    expect(action).toEqual({ action: "quiet" });
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("You are an independent watchdog.");
    expect(prompts[1]).toBe(WATCH_REMINDER);
  });

  it("nudges once then escalates on the next stuck judgment, and stays off when switched off", async () => {
    const stuck = line({ verdict: "stuck", reason: "same patch", nudge: "Open the failing test first." });
    const first = await inspect([stuck, stuck]);
    expect(first.action).toEqual({ action: "nudge", note: "Open the failing test first.", by: "Pro" });
    expect(await first.watchdog.inspect({
      bot: { id: "b", name: "B" } as never, threadId: "goal", goal: "write a.txt", latest: "same again", turn: 4,
    })).toEqual({ action: "escalate", reason: "same patch (still off track after a watchdog nudge)", by: "Pro" });
    expect((await inspect([stuck], { off: true })).prompts).toEqual([]);
    expect((await inspect([line({ verdict: "ok", reason: "early" })], { turn: 1 })).prompts).toEqual([]);
  });

  it("forget clears a spent nudge so a later goal in the same conversation can nudge again", async () => {
    const stuck = line({ verdict: "stuck", reason: "loop", nudge: "Try another approach." });
    const first = await inspect([stuck, stuck]);
    expect(first.action).toEqual({ action: "nudge", note: "Try another approach.", by: "Pro" });
    first.watchdog.forget("goal");
    expect(await first.watchdog.inspect({
      bot: { id: "b", name: "B" } as never, threadId: "goal", goal: "write a.txt", latest: "new run", turn: 3,
    })).toEqual({ action: "nudge", note: "Try another approach.", by: "Pro" });
  });

  it("names the goal and latest work in the instructions", () => {
    expect(watchdogInstructions({ goal: "写诗", latest: "写了两行" }, "Bot: 写了两行")).toContain("写诗");
    expect(watchdogInstructions({ goal: "写诗", latest: "写了两行" }, "Bot: 写了两行")).toContain("写了两行");
  });
});

describe("watchdog inside a goal run", () => {
  it("nudges the next step once, then stops for the person on a second stuck judgment", async () => {
    const run = { goal: "Get every test passing", turnCount: 0, maxTurns: 13, finished: false };
    const finished: Array<{ status: string; detail: string }> = [];
    const notes: string[] = [];
    const calls: string[] = [];
    let watches = 0;
    await runGoalRun({
      run,
      coordinator: { id: "solo", name: "Solo" },
      members: [{ id: "solo", name: "Solo" }],
      solo: true,
      cancelled: () => false,
      current: () => ({ id: "solo", name: "Solo" }),
      step: async (_bot, _coordinator, instructions) => {
        calls.push(instructions);
        run.turnCount += 1;
        return settled(envelope({ status: "continue", next: "solo", instruction: "Same failing edit", detail: "Still red" }));
      },
      finish: (status, detail) => { run.finished = true; finished.push({ status, detail }); },
      progress: () => {},
      note: (text) => { notes.push(text); },
      watch: async () => {
        watches += 1;
        return watches === 1
          ? { action: "nudge", note: "Read the failure output first.", by: "Pro" }
          : { action: "escalate", reason: "Still repeating the same edit", by: "Pro" };
      },
    });
    expect(notes[0]).toContain("Watchdog (Pro): Read the failure output first.");
    expect(calls.some((text) => text.includes("Watchdog correction: Read the failure output first."))).toBe(true);
    expect(finished).toEqual([{ status: "needs-input", detail: "Watchdog (Pro): Still repeating the same edit" }]);
    expect(watches).toBe(2);
  });

  it("hands a coordinator nudge to a room worker before the next judgment", async () => {
    const run = { goal: "Get every test passing", turnCount: 0, maxTurns: 13, finished: false };
    const finished: Array<{ status: string }> = [];
    const calls: Array<{ bot: string; instructions: string }> = [];
    let watches = 0;
    let leadTurns = 0;
    await runGoalRun({
      run,
      coordinator: { id: "lead", name: "Lead" },
      members: [{ id: "lead", name: "Lead" }, { id: "scout", name: "Scout" }],
      cancelled: () => false,
      current: (id) => id === "lead" ? { id: "lead", name: "Lead" } : { id: "scout", name: "Scout" },
      step: async (bot, coordinator, instructions) => {
        calls.push({ bot: bot.id, instructions });
        run.turnCount += 1;
        if (coordinator) {
          leadTurns += 1;
          return settled(leadTurns === 1
            ? envelope({ status: "continue", next: "scout", instruction: "Fix the parser", detail: "Handed out" })
            : envelope({ status: "completed", detail: "Fixed." }));
        }
        return settled("Opened the failing test and fixed it.");
      },
      finish: (status) => { run.finished = true; finished.push({ status }); },
      progress: () => {},
      note: () => {},
      watch: async () => {
        watches += 1;
        if (watches === 1) return { action: "nudge", note: "Open the failing test first.", by: "Pro" };
        return { action: "quiet" };
      },
    });
    const scout = calls.find((call) => call.bot === "scout");
    expect(scout?.instructions).toContain("Fix the parser");
    expect(scout?.instructions).toContain("Watchdog correction: Open the failing test first.");
    expect(finished).toEqual([{ status: "completed" }]);
  });

  it("keeps a coordinator nudge for the next lead turn when the worker stays busy", async () => {
    const run = { goal: "Get every test passing", turnCount: 0, maxTurns: 13, finished: false };
    const finished: Array<{ status: string }> = [];
    const calls: string[] = [];
    let leadTurns = 0;
    await runGoalRun({
      run,
      coordinator: { id: "lead", name: "Lead" },
      members: [{ id: "lead", name: "Lead" }, { id: "scout", name: "Scout" }],
      cancelled: () => false,
      current: (id) => id === "lead" ? { id: "lead", name: "Lead" } : { id: "scout", name: "Scout" },
      step: async (_bot, coordinator, instructions) => {
        calls.push(instructions);
        if (coordinator) {
          leadTurns += 1;
          run.turnCount += 1;
          return settled(leadTurns === 1
            ? envelope({ status: "continue", next: "scout", instruction: "Fix the parser", detail: "Handed out" })
            : envelope({ status: "completed", detail: "Reassigned and done." }));
        }
        return { ran: false, replyText: "", outcome: "busy", stopReason: "Scout stayed busy" };
      },
      finish: (status) => { run.finished = true; finished.push({ status }); },
      progress: () => {},
      note: () => {},
      watch: async () => ({ action: "nudge", note: "Give it to someone free.", by: "Pro" }),
    });
    expect(calls.some((text) => text.includes("Watchdog correction: Give it to someone free."))).toBe(true);
    expect(finished).toEqual([{ status: "completed" }]);
  });

  it("stays quiet when the watch reports ok", async () => {
    const run = { goal: "Ship it", turnCount: 0, maxTurns: 13, finished: false };
    const finished: Array<{ status: string }> = [];
    const notes: string[] = [];
    let step = 0;
    await runGoalRun({
      run,
      coordinator: { id: "solo", name: "Solo" },
      members: [{ id: "solo", name: "Solo" }],
      solo: true,
      cancelled: () => false,
      current: () => ({ id: "solo", name: "Solo" }),
      step: async () => {
        step += 1;
        run.turnCount += 1;
        return settled(step === 1
          ? envelope({ status: "continue", next: "solo", instruction: "Write the file", detail: "Working" })
          : envelope({ status: "completed", detail: "Done" }));
      },
      finish: (status) => { run.finished = true; finished.push({ status }); },
      progress: () => {},
      note: (text) => { notes.push(text); },
      watch: async () => ({ action: "quiet" }),
    });
    expect(notes).toEqual([]);
    expect(finished).toEqual([{ status: "completed" }]);
  });
});
