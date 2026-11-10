import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { modelRecords, recordLine, withTrackRecords } from "./model-scorecard.ts";
import type { UsageRow } from "./usage-ledger.ts";

const row = (model: string, status: "ok" | "error" | "interrupted" | undefined, seconds: number, costUsd: number | null): UsageRow => ({
  at: "2026-11-10T10:00:00.000Z", botId: "b", botName: "B", threadId: "t", instanceId: "ds", driverKind: "deepseekAgent", model,
  input: 0, output: 0, costUsd, trigger: { kind: "user" },
  startedAt: "2026-11-10T10:00:00.000Z", endedAt: new Date(Date.parse("2026-11-10T10:00:00.000Z") + seconds * 1000).toISOString(),
  ...(status ? { outcome: { status } } : {}),
});

describe("modelRecords", () => {
  it("counts finished turns, failures, the median time and the average cost per model", () => {
    const records = modelRecords([
      row("flash", "ok", 10, 0.002), row("flash", "ok", 30, 0.004), row("flash", "error", 12, null),
      row("flash", "interrupted", 99, 1), row("flash", undefined, 99, 1), row("pro", "ok", 40, null),
    ]);
    expect(records.get("ds/flash")).toEqual({ turns: 3, failed: 1, seconds: 12, usdPerTurn: 0.003 });
    expect(records.get("ds/pro")).toEqual({ turns: 1, failed: 0, seconds: 40, usdPerTurn: null });
  });
});

describe("recordLine", () => {
  it("joins the list price and the record, and says nothing when it knows nothing", () => {
    expect(recordLine("unknown-model", { turns: 3, failed: 1, seconds: 12, usdPerTurn: 0.003 }))
      .toBe("3 turns here in 30 days, 1 failed, ~12s a turn, ~$0.003 a turn");
    expect(recordLine("gpt-5.4", undefined, new Date("2026-11-10"))).toBe("list $2.50 in / $15.00 out per 1M tokens");
    expect(recordLine("unknown-model", undefined)).toBeNull();
  });
});

describe("withTrackRecords", () => {
  it("adds lines only for models the menu lists, and leaves the menu alone when the ledger is empty", () => {
    const menu = { current: { instanceId: "oa", model: "gpt-5.4" }, engines: [{ instanceId: "oa", name: "OpenAI", models: ["gpt-5.4", { id: "mystery", label: "Mystery" }] }] };
    const empty = mkdtempSync(join(tmpdir(), "omb-scorecard-"));
    expect(withTrackRecords(menu, empty, new Date("2026-11-10"))).toEqual({ ...menu, track: { "oa/gpt-5.4": "list $2.50 in / $15.00 out per 1M tokens" } });
    expect(withTrackRecords({ ...menu, engines: [{ instanceId: "oa", name: "OpenAI", models: ["mystery"] }] }, empty)).not.toHaveProperty("track");
    expect(withTrackRecords(null, empty)).toBeNull();
  });
});
