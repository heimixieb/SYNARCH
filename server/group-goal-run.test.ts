import { describe, expect, it } from "vitest";
import {
  GROUP_GOAL_CONTROL_CLOSE,
  GROUP_GOAL_CONTROL_OPEN,
  GROUP_GOAL_MAX_TURNS,
  groupGoalAssignmentKey,
  groupGoalCompletionTurnId,
  groupGoalCoordinatorInstructions,
  parseGroupGoalDecision,
  resolveGroupGoalMember,
  runGoalRun,
  GOAL_MAX_REFUTES,
  selectGroupGoalCoordinator,
  type GoalRunEnd,
  type GoalStepResult,
} from "./group-goal-run.ts";
import type { GoalVerdict } from "./host/goal-verifier.ts";

const members = [
  { id: "scout-id", name: "Scout" },
  { id: "chief-id", name: "Miso", chiefOfStaff: true },
  { id: "old-id", name: "Old", hidden: true },
];

describe("group goal runs", () => {
  it("keeps the bound provider identity when a completion event omits its turn id", () => {
    expect(groupGoalCompletionTurnId(undefined, "bound-turn")).toBe("bound-turn");
    expect(groupGoalCompletionTurnId("event-turn", "bound-turn")).toBe("event-turn");
  });

  it("strips and validates a coordinator decision", () => {
    const parsed = parseGroupGoalDecision(
      `I am asking Scout to verify it.\n${GROUP_GOAL_CONTROL_OPEN}`
      + `{"status":"continue","next":"@Scout","instruction":"Verify the release","detail":"Draft ready"}`
      + GROUP_GOAL_CONTROL_CLOSE,
    );
    expect(parsed.visibleText).toBe("I am asking Scout to verify it.");
    expect(parsed.decision).toEqual({
      status: "continue",
      next: "@Scout",
      instruction: "Verify the release",
      detail: "Draft ready",
    });
  });

  it("fails closed on incomplete or malformed decisions", () => {
    expect(parseGroupGoalDecision("ordinary reply")).toEqual({ visibleText: "ordinary reply", decision: null });
    expect(parseGroupGoalDecision(
      `${GROUP_GOAL_CONTROL_OPEN}{"status":"continue","next":"Scout"}${GROUP_GOAL_CONTROL_CLOSE}`,
    ).decision).toBeNull();
    expect(parseGroupGoalDecision(
      `${GROUP_GOAL_CONTROL_OPEN}{not json}${GROUP_GOAL_CONTROL_CLOSE}`,
    ).decision).toBeNull();
    expect(parseGroupGoalDecision(
      `Safe update\n${GROUP_GOAL_CONTROL_OPEN}{"status":"continue"}`,
    )).toEqual({ visibleText: "Safe update", decision: null });
  });

  it("removes every private envelope while the last complete one controls", () => {
    const parsed = parseGroupGoalDecision(
      `First\n${GROUP_GOAL_CONTROL_OPEN}{"status":"blocked","detail":"old"}${GROUP_GOAL_CONTROL_CLOSE}`
      + `\nFinal\n${GROUP_GOAL_CONTROL_OPEN}{"status":"completed","detail":"done"}${GROUP_GOAL_CONTROL_CLOSE}`,
    );
    expect(parsed.visibleText).toBe("First\n\nFinal");
    expect(parsed.decision).toEqual({ status: "completed", detail: "done" });
  });

  it("honors an explicit active lead, then an in-room Chief", () => {
    expect(selectGroupGoalCoordinator(members, { kind: "member", botId: "scout-id" })?.id).toBe("scout-id");
    expect(selectGroupGoalCoordinator(members, { kind: "everyone" })?.id).toBe("chief-id");
    expect(selectGroupGoalCoordinator(members, { kind: "member", botId: "old-id" })?.id).toBe("chief-id");
  });

  it("resolves only an exact active room member", () => {
    expect(resolveGroupGoalMember("@SCOUT", members)?.id).toBe("scout-id");
    expect(resolveGroupGoalMember("chief-id", members)?.name).toBe("Miso");
    expect(resolveGroupGoalMember("Old", members)).toBeNull();
    expect(resolveGroupGoalMember("Sco", members)).toBeNull();
    expect(resolveGroupGoalMember("Scout", [
      ...members,
      { id: "other-scout", name: "Scout" },
    ])).toBeNull();
    expect(resolveGroupGoalMember("other-scout", [
      ...members,
      { id: "other-scout", name: "Scout" },
    ])?.id).toBe("other-scout");
  });

  it("normalizes repeated assignments for no-progress detection", () => {
    expect(groupGoalAssignmentKey("scout-id", "  Verify   THE release "))
      .toBe(groupGoalAssignmentKey("scout-id", "verify the release"));
  });

  it("reserves the final bounded turn for coordinator evaluation", () => {
    expect(GROUP_GOAL_MAX_TURNS % 2).toBe(1);
  });
});

describe("groupGoalCoordinatorInstructions harness note", () => {
  const base = {
    goal: "Ship the release notes",
    members: [{ id: "lead", name: "Lead" }, { id: "scout", name: "Scout" }],
    turn: 3,
    maxTurns: 13,
    remainingTurns: 10,
  };

  it("renders a harness note on its own line, before the ledger guidance", () => {
    const lines = groupGoalCoordinatorInstructions({ ...base, note: "Scout stayed busy for 30 minutes" }).split("\n");
    const noteAt = lines.indexOf("Harness note: Scout stayed busy for 30 minutes");
    const ledgerAt = lines.findIndex((line) => line.startsWith("Use the conversation as the progress ledger"));
    expect(noteAt).toBeGreaterThan(-1);
    expect(ledgerAt).toBeGreaterThan(noteAt);
  });

  it("omits the note line entirely when there is nothing to report", () => {
    expect(groupGoalCoordinatorInstructions(base)).not.toContain("Harness note:");
  });
});

const envelope = (decision: Record<string, string>) =>
  `Update.\n${GROUP_GOAL_CONTROL_OPEN}${JSON.stringify(decision)}${GROUP_GOAL_CONTROL_CLOSE}`;
const settled = (replyText: string): GoalStepResult => ({ ran: true, replyText, outcome: "settled" });

/** Drives the real loop with scripted steps; a step that runs counts one turn, as a claimed member turn does. */
function goalRun(options: { solo?: boolean; members?: Array<{ id: string; name: string }>; steps: Array<GoalStepResult | ((call: number) => GoalStepResult)>; cancelAfter?: number; verify?: (report: string) => Promise<GoalVerdict> }) {
  const members = options.members ?? [{ id: "solo-id", name: "Solo" }];
  const run = { goal: "Get every test passing", turnCount: 0, maxTurns: GROUP_GOAL_MAX_TURNS, finished: false };
  const calls: Array<{ bot: string; coordinator: boolean; instructions: string }> = [];
  const finished: Array<{ status: GoalRunEnd; detail: string }> = [];
  const progress: string[] = [];
  let cancelled = false;
  const done = runGoalRun({
    run,
    coordinator: members[0]!,
    members,
    solo: options.solo,
    cancelled: () => cancelled,
    current: (id) => members.find((member) => member.id === id),
    step: async (bot, coordinator, instructions) => {
      calls.push({ bot: bot.id, coordinator, instructions });
      const scripted = options.steps[Math.min(calls.length - 1, options.steps.length - 1)]!;
      const result = typeof scripted === "function" ? scripted(calls.length) : scripted;
      if (result.ran) run.turnCount += 1;
      if (options.cancelAfter === calls.length || calls.length > 4 * GROUP_GOAL_MAX_TURNS) cancelled = true;
      return result;
    },
    finish: (status, detail) => {
      run.finished = true;
      finished.push({ status, detail });
    },
    progress: (detail) => progress.push(detail),
    note: () => {},
    ...(options.verify ? { verify: options.verify } : {}),
  });
  return { done, run, calls, finished, progress };
}

describe("one goal-run loop for a room and a one-on-one chat", () => {
  it("in a room of one the bot works in its own turns and finishes on the done marker", async () => {
    const goal = goalRun({
      solo: true,
      steps: [
        settled(envelope({ status: "continue", next: "solo-id", instruction: "Fix the failing parser test", detail: "Half done" })),
        settled(envelope({ status: "completed", detail: "Every test passes." })),
      ],
    });
    await goal.done;
    expect(goal.calls.map((call) => [call.bot, call.coordinator])).toEqual([["solo-id", true], ["solo-id", true]]);
    expect(goal.calls[0]!.instructions).toContain("You are working alone toward a bounded goal.");
    expect(goal.calls[0]!.instructions).toContain(`"next":"solo-id"`);
    expect(goal.calls[0]!.instructions).not.toContain("Available room members");
    expect(goal.calls[1]!.instructions).toContain("Harness note: Your next step: Fix the failing parser test");
    expect(goal.finished).toEqual([{ status: "completed", detail: "Every test passes." }]);
    expect(goal.run.turnCount).toBe(2);
  });

  it("stops a room of one at the same turn cap as a room", async () => {
    const goal = goalRun({
      solo: true,
      steps: [(call) => settled(envelope({ status: "continue", next: "Solo", instruction: `Try approach ${call}`, detail: "Still going" }))],
    });
    await goal.done;
    expect(goal.calls).toHaveLength(GROUP_GOAL_MAX_TURNS);
    expect(goal.finished).toEqual([{ status: "limit-reached", detail: expect.stringContaining(`${GROUP_GOAL_MAX_TURNS}-turn safety limit`) }]);
  });

  it("blocks on the spend cap without retrying the refused turn", async () => {
    const goal = goalRun({
      solo: true,
      steps: [
        settled(envelope({ status: "continue", next: "solo-id", instruction: "Keep going", detail: "Working" })),
        { ran: false, replyText: "", outcome: "spend_capped", stopReason: "this workspace has reached its monthly spend limit of $0.01" },
      ],
    });
    await goal.done;
    expect(goal.calls).toHaveLength(2);
    expect(goal.finished).toEqual([{ status: "blocked", detail: "this workspace has reached its monthly spend limit of $0.01" }]);
  });

  it("retries a turn that did not settle once, then fails the run", async () => {
    const goal = goalRun({ solo: true, steps: [{ ran: true, replyText: "", outcome: "provider_failed", stopReason: "exit 1" }] });
    await goal.done;
    expect(goal.calls).toHaveLength(2);
    expect(goal.progress).toContain("Solo's turn did not settle (provider failed) — retrying once.");
    expect(goal.finished).toEqual([{ status: "failed", detail: "Solo could not complete the coordination step — exit 1." }]);
  });

  it("never takes a reply without a valid marker as done, and asks once more for it before stopping", async () => {
    const goal = goalRun({ solo: true, steps: [settled("All done, trust me.")] });
    await goal.done;
    expect(goal.calls).toHaveLength(2);
    expect(JSON.stringify(goal.calls[1])).toContain("had no <openmaus-goal> decision line");
    expect(goal.finished).toEqual([{ status: "blocked", detail: "Solo did not provide a valid next-step decision." }]);
  });

  it("goes on when the reminded reply carries the decision", async () => {
    const goal = goalRun({ solo: true, steps: [settled("Handed it out; the result comes back here."), settled(envelope({ status: "completed", detail: "Saved" }))] });
    await goal.done;
    expect(goal.calls).toHaveLength(2);
    expect(goal.finished[0]?.status).toBe("completed");
  });

  it("blocks a room of one that repeats the same next step", async () => {
    const goal = goalRun({ solo: true, steps: [settled(envelope({ status: "continue", next: "solo-id", instruction: "Same thing", detail: "Again" }))] });
    await goal.done;
    expect(goal.calls).toHaveLength(3);
    expect(goal.finished[0]?.status).toBe("blocked");
  });

  it("a stopped run ends without finishing again or starting another turn", async () => {
    const goal = goalRun({
      solo: true,
      cancelAfter: 1,
      steps: [settled(envelope({ status: "continue", next: "solo-id", instruction: "Keep going", detail: "Working" }))],
    });
    await goal.done;
    expect(goal.calls).toHaveLength(1);
    expect(goal.finished).toEqual([]);
  });

  it("a room still hands each assignment to a worker turn", async () => {
    const goal = goalRun({
      members: [{ id: "lead-id", name: "Lead" }, { id: "scout-id", name: "Scout" }],
      steps: [
        settled(envelope({ status: "continue", next: "Scout", instruction: "Verify the draft", detail: "Drafted" })),
        settled("Verified."),
        settled(envelope({ status: "completed", detail: "Draft verified." })),
      ],
    });
    await goal.done;
    expect(goal.calls.map((call) => [call.bot, call.coordinator])).toEqual([["lead-id", true], ["scout-id", false], ["lead-id", true]]);
    expect(goal.calls[0]!.instructions).toContain("Available room members: Lead (lead-id), Scout (scout-id).");
    expect(goal.finished).toEqual([{ status: "completed", detail: "Draft verified." }]);
  });
});

describe("independent check before a goal completes", () => {
  const done = settled(envelope({ status: "completed", detail: "Every test passes." }));
  const verdicts = (...list: Array<GoalVerdict["verdict"]>) => {
    const reports: string[] = [];
    let call = 0;
    return { reports, verify: async (report: string): Promise<GoalVerdict> => {
      reports.push(report);
      return { verdict: list[Math.min(call++, list.length - 1)]!, reason: "parser test still fails", by: "Checker" };
    } };
  };

  it("completes only after the check passes, and sends a refuted claim back with the reason", async () => {
    const check = verdicts("refute", "pass");
    const goal = goalRun({ solo: true, steps: [done], verify: check.verify });
    await goal.done;
    expect(check.reports[0]).toContain("Every test passes.");
    expect(goal.calls[1]!.instructions).toContain("An independent check by Checker did not accept completion: parser test still fails");
    expect(goal.finished).toEqual([{ status: "completed", detail: "Every test passes." }]);
  });

  it("hands the decision to the person after the refute cap, or when the check cannot confirm", async () => {
    const stubborn = goalRun({ solo: true, steps: [done], verify: verdicts("refute").verify });
    await stubborn.done;
    expect(stubborn.calls).toHaveLength(GOAL_MAX_REFUTES + 1);
    expect(stubborn.finished[0]!.status).toBe("needs-input");

    const unsure = goalRun({ solo: true, steps: [done], verify: verdicts("unverifiable").verify });
    await unsure.done;
    expect(unsure.calls).toHaveLength(1);
    expect(unsure.finished[0]).toMatchObject({ status: "needs-input" });
    expect(unsure.finished[0]!.detail).toContain("could not confirm");
  });
});
