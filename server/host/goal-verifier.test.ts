import { describe, expect, it } from "vitest";

import { GROUP_GOAL_CONTROL_CLOSE, GROUP_GOAL_CONTROL_OPEN } from "../group-goal-run.ts";
import type { Message } from "../store.ts";
import { goalTranscript, parseVerdict, pickVerifierModel } from "./goal-verifier.ts";

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
