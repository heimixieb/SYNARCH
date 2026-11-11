import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BACKGROUND_HOLD_TOOL,
  createBackgroundHold,
  createBackgroundJobTracker,
  noteBackgroundJobUpdate,
  shouldHoldForBackgroundJobs,
} from "./background-jobs.ts";

describe("background job tracker", () => {
  it("opens a job from a start or promote line, and closes it on a terminal status", () => {
    const jobs = createBackgroundJobTracker();
    jobs.noteText("started background job bash-aabbccddeeff0011");
    expect(jobs.pending()).toBe(true);
    expect(jobs.running()).toEqual(["bash-aabbccddeeff0011"]);
    jobs.noteText("[still running after 5000ms; moved to background job bash-1122334455667788]");
    expect(jobs.running().sort()).toEqual(["bash-1122334455667788", "bash-aabbccddeeff0011"].sort());
    jobs.noteText("background job bash-aabbccddeeff0011 (npm test) finished [status: completed]. Output: ok");
    expect(jobs.running()).toEqual(["bash-1122334455667788"]);
    jobs.noteText("(no new output)\n[status: failed]");
    expect(jobs.pending()).toBe(false);
  });

  it("reads tool update payloads the ACP stream carries", () => {
    const jobs = createBackgroundJobTracker();
    noteBackgroundJobUpdate(jobs, { rawOutput: "started background job pwsh-deadbeefdeadbeef" });
    expect(shouldHoldForBackgroundJobs(jobs)).toBe(true);
    noteBackgroundJobUpdate(jobs, { content: { text: "background job pwsh-deadbeefdeadbeef (x) finished [status: killed]." } });
    expect(shouldHoldForBackgroundJobs(jobs)).toBe(false);
  });
});

describe("background hold", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps the turn open through the silent job gap, then settles after a wakeup goes quiet", () => {
    vi.useFakeTimers();
    const tracker = createBackgroundJobTracker();
    tracker.noteText("started background job bash-1");
    const runningTools = new Set<string>();
    const settled: boolean[] = [];
    const hold = createBackgroundHold({ tracker, runningTools, settleQuietMs: 1_000, holdMs: 60_000 });
    hold.begin(() => settled.push(true));
    expect(hold.active).toBe(true);
    expect(runningTools.has(BACKGROUND_HOLD_TOOL)).toBe(true);
    vi.advanceTimersByTime(20_000);
    expect(settled).toEqual([]);
    hold.noteActivity();
    vi.advanceTimersByTime(999);
    expect(settled).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(settled).toEqual([true]);
    expect(hold.active).toBe(false);
    expect(runningTools.has(BACKGROUND_HOLD_TOOL)).toBe(false);
  });

  it("settles at the Super-agent 30-minute cap even if a job never reports", () => {
    vi.useFakeTimers();
    const tracker = createBackgroundJobTracker();
    tracker.noteText("started background job bash-stuck");
    const runningTools = new Set<string>();
    const settled: boolean[] = [];
    const hold = createBackgroundHold({ tracker, runningTools, settleQuietMs: 1_000, holdMs: 30_000 });
    hold.begin(() => settled.push(true));
    vi.advanceTimersByTime(29_999);
    expect(settled).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(settled).toEqual([true]);
  });

  it("does not hold when no background job was seen", () => {
    expect(shouldHoldForBackgroundJobs(createBackgroundJobTracker())).toBe(false);
    expect(shouldHoldForBackgroundJobs(undefined)).toBe(false);
  });
});
