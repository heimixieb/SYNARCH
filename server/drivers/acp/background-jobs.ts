// DeepSeek (and any ACP support that opts in) can finish a session/prompt while shell jobs still run;
// dsh then wakes the same session with a follow-up turn. OpenMausBot must keep the OMB turn open until
// those jobs settle (or the Super-agent 30-minute cap), or the wakeup's session/update is dropped and
// report_back / goals treat the worker as done too early.

export const BACKGROUND_HOLD_MS = 30 * 60_000;
/** After a job wakeup goes quiet, wait this long before settling (streams may still finish). */
export const BACKGROUND_SETTLE_QUIET_MS = 1_500;
export const BACKGROUND_HOLD_TOOL = "synarch-bg-hold";

function settleQuietMs(override?: number): number {
  if (override !== undefined) return override;
  const raw = Number(process.env.OMB_ACP_BG_SETTLE_QUIET_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : BACKGROUND_SETTLE_QUIET_MS;
}

const STARTED = /started background job\s+(\S+)/gi;
const PROMOTED = /moved to background job\s+(\S+)/gi;
const NOTICE = /background job\s+(\S+)\s*\(/gi;
const STATUS = /\[status:\s*(completed|failed|killed|cancelled)(?:[^\]]*)\]/i;
const STATUS_WITH_ID = /background job\s+(\S+)[^\n]*\[status:\s*(completed|failed|killed|cancelled)/i;

export type BackgroundJobTracker = {
  noteText(text: string): void;
  pending(): boolean;
  /** Ids still running, for tests and notices. */
  running(): string[];
};

export function createBackgroundJobTracker(): BackgroundJobTracker {
  const open = new Set<string>();
  const noteText = (text: string) => {
    if (!text) return;
    for (const re of [STARTED, PROMOTED, NOTICE]) {
      re.lastIndex = 0;
      for (let m = re.exec(text); m; m = re.exec(text)) {
        const id = m[1]?.replace(/[\].,;:]+$/, "");
        if (id) open.add(id);
      }
    }
    const withId = STATUS_WITH_ID.exec(text);
    if (withId?.[1]) {
      open.delete(withId[1].replace(/[\].,;:]+$/, ""));
      return;
    }
    // job_output results name the status without repeating the id beside it when the call already keyed the job.
    if (STATUS.test(text) && open.size === 1) open.clear();
  };
  return {
    noteText,
    pending: () => open.size > 0,
    running: () => [...open],
  };
}

export type BackgroundHold = {
  active: boolean;
  begin(settle: () => void): void;
  noteActivity(): void;
  dispose(): void;
};

/** Keeps an ACP turn open after end_turn while background jobs may still wake the agent. */
export function createBackgroundHold(opts: {
  tracker: BackgroundJobTracker;
  runningTools: Set<string>;
  holdMs?: number;
  settleQuietMs?: number;
}): BackgroundHold {
  const holdMs = opts.holdMs ?? BACKGROUND_HOLD_MS;
  const settleQuiet = settleQuietMs(opts.settleQuietMs);
  let hardTimer: ReturnType<typeof setTimeout> | null = null;
  let quietTimer: ReturnType<typeof setTimeout> | null = null;
  let settleOnce: (() => void) | null = null;
  let sawWakeup = false;
  const clearQuiet = () => {
    if (quietTimer) clearTimeout(quietTimer);
    quietTimer = null;
  };
  const finish = () => {
    if (!settleOnce) return;
    const settle = settleOnce;
    settleOnce = null;
    clearQuiet();
    if (hardTimer) clearTimeout(hardTimer);
    hardTimer = null;
    opts.runningTools.delete(BACKGROUND_HOLD_TOOL);
    hold.active = false;
    settle();
  };
  const armQuiet = () => {
    clearQuiet();
    // The silent gap while an OS job runs must not settle; only a wakeup (or the hard cap) may.
    if (!sawWakeup) return;
    const realTools = [...opts.runningTools].filter((id) => id !== BACKGROUND_HOLD_TOOL);
    if (realTools.length) return;
    quietTimer = setTimeout(finish, settleQuiet);
    quietTimer.unref?.();
  };
  const hold: BackgroundHold = {
    active: false,
    begin(settle) {
      if (hold.active) return;
      hold.active = true;
      sawWakeup = false;
      settleOnce = settle;
      opts.runningTools.add(BACKGROUND_HOLD_TOOL);
      hardTimer = setTimeout(finish, holdMs);
      hardTimer.unref?.();
    },
    noteActivity() {
      if (!hold.active) return;
      sawWakeup = true;
      clearQuiet();
      armQuiet();
    },
    dispose() {
      clearQuiet();
      if (hardTimer) clearTimeout(hardTimer);
      hardTimer = null;
      settleOnce = null;
      opts.runningTools.delete(BACKGROUND_HOLD_TOOL);
      hold.active = false;
    },
  };
  return hold;
}

/** True when end_turn should wait for DeepSeek-style job wakeups instead of settling at once. */
export function shouldHoldForBackgroundJobs(tracker: BackgroundJobTracker | undefined): boolean {
  return Boolean(tracker?.pending());
}

export function attachBackgroundFollowup(runningTools: Set<string>): {
  backgroundJobs: BackgroundJobTracker;
  backgroundHold: BackgroundHold;
} {
  const backgroundJobs = createBackgroundJobTracker();
  return { backgroundJobs, backgroundHold: createBackgroundHold({ tracker: backgroundJobs, runningTools }) };
}

export function endTurnOrHoldBackground(
  support: { autonomousFollowups?: boolean },
  turn: { backgroundJobs?: BackgroundJobTracker; backgroundHold?: BackgroundHold },
  settle: () => void,
): void {
  if (support.autonomousFollowups && shouldHoldForBackgroundJobs(turn.backgroundJobs) && turn.backgroundHold) {
    turn.backgroundHold.begin(settle);
  } else {
    settle();
  }
}

export function observeAutonomousUpdate(
  turn: { backgroundJobs?: BackgroundJobTracker; backgroundHold?: BackgroundHold },
  update: Record<string, unknown> | undefined,
): void {
  noteBackgroundJobUpdate(turn.backgroundJobs, update);
  if (turn.backgroundHold?.active) turn.backgroundHold.noteActivity();
}

/** Scan ACP tool payloads (raw input/output or content text) for job ids and terminal status. */
export function noteBackgroundJobUpdate(tracker: BackgroundJobTracker | undefined, update: Record<string, unknown> | undefined): void {
  if (!tracker || !update) return;
  const parts: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === "string" && value) parts.push(value);
    else if (value && typeof value === "object") {
      try { parts.push(JSON.stringify(value)); } catch { /* ignore */ }
    }
  };
  push(update.title);
  push(update.content);
  if (update.content && typeof update.content === "object" && typeof (update.content as { text?: unknown }).text === "string") {
    parts.push((update.content as { text: string }).text);
  }
  push(update.rawOutput);
  push(update.rawInput);
  if (Array.isArray(update.content)) for (const block of update.content) push(block);
  for (const part of parts) tracker.noteText(part);
}
