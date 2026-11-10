import { describe, expect, it } from "vitest";

import { GROUP_GOAL_CONTROL_CLOSE, GROUP_GOAL_CONTROL_OPEN } from "../group-goal-run.ts";
import type { Message } from "../store.ts";
import { createGoalVerifier, goalTranscript, parseVerdict, pickVerifierModel, VERDICT_REMINDER } from "./goal-verifier.ts";
import { createGoalTurns } from "./goal-turns.ts";

const line = (payload: unknown) => `${GROUP_GOAL_CONTROL_OPEN}${JSON.stringify(payload)}${GROUP_GOAL_CONTROL_CLOSE}`;

describe("pickVerifierModel", () => {
  const driver = (id: string) => ({ ds: "deepseekAgent", claude: "claudeAgent" })[id];
  const current = { instanceId: "ds", model: "flash" };

  it("prefers another vendor, then another model on the same engine, then the current one", () => {
    expect(pickVerifierModel({ current, engines: [{ instanceId: "ds", name: "DeepSeek", models: ["flash", "pro"] }, { instanceId: "claude", name: "Claude", models: [{ id: "sonnet", label: "Sonnet" }] }] }, driver))
      .toEqual({ instanceId: "claude", model: "sonnet" });
    expect(pickVerifierModel({ current, engines: [{ instanceId: "ds", name: "DeepSeek", models: ["flash", "pro"] }] }, driver)).toEqual({ instanceId: "ds", model: "pro" });
    expect(pickVerifierModel({ current, engines: [{ instanceId: "claude", name: "Claude", unusable: "signed out" }] }, driver)).toEqual(current);
  });
});

describe("parseVerdict", () => {
  it("reads the last complete verdict line and ignores anything malformed", () => {
    expect(parseVerdict(`Looks fine.\n${line({ verdict: "refute", reason: "old" })}\n${line({ verdict: "pass", reason: "opened report.md" })}`))
      .toEqual({ verdict: "pass", reason: "opened report.md" });
    expect(parseVerdict(line({ verdict: "maybe", reason: "x" }))).toBeNull();
    expect(parseVerdict(line({ verdict: "pass" }))).toBeNull();
    expect(parseVerdict("no line at all")).toBeNull();
  });
});

describe("goalTranscript", () => {
  it("keeps the newest text lines within the cap", () => {
    const messages = [
      { role: "user", kind: "text", text: "a".repeat(12_000) },
      { role: "bot", kind: "activity", tool: { name: "Read", ok: true } },
      { role: "bot", kind: "text", text: "Done: report.md" },
    ] as Message[];
    expect(goalTranscript(messages)).toBe("Bot: Done: report.md");
    expect(goalTranscript(messages.slice(1))).toBe("Bot: Done: report.md");
  });
});

describe("createGoalVerifier", () => {
  /** A check whose model answers each turn with the next reply; returns the verdict and the prompts it was sent. */
  async function check(replies: string[]) {
    const turns = createGoalTurns({ retireProviderTurn: () => {} });
    const prompts: string[] = [];
    const verify = createGoalVerifier({
      store: {
        appendMessage: () => ({}) as Message,
        createTask: () => ({ threadId: "check" }) as never,
        messagesFor: () => [],
        taskByThread: () => undefined,
      },
      turns,
      async startTurn(_botId, text, opts) {
        prompts.push(text);
        turns.forEvent({ threadId: "check" } as never)!.assistantItems.push(replies[prompts.length - 1] ?? "");
        opts.onSettled({ ok: true, text: "" } as never);
      },
      isUnattended: () => true,
      verifierModel: () => ({ instanceId: "ds", model: "pro" }),
      modelName: () => "Pro",
    });
    return { verdict: await verify({ bot: { id: "b", name: "B" } as never, threadId: "goal", goal: "write a.txt", report: "done" }), prompts };
  }

  it("asks once more when the check forgets its verdict line", async () => {
    const { verdict, prompts } = await check(["结论：通过。", line({ verdict: "pass", reason: "opened a.txt" })]);
    expect(verdict).toEqual({ verdict: "pass", reason: "opened a.txt", by: "Pro" });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toBe(VERDICT_REMINDER);
  });

  it("asks nothing more when the first reply has a verdict, and hands the goal to the person after two silent replies", async () => {
    expect((await check([line({ verdict: "refute", reason: "a.txt is empty" })])).prompts).toHaveLength(1);
    const silent = await check(["looks fine", "still fine"]);
    expect(silent.verdict).toEqual({ verdict: "unverifiable", reason: "the check gave no verdict", by: "Pro" });
    expect(silent.prompts).toHaveLength(2);
  });
});
