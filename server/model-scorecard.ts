// Each model's recent record on this team, for a Chief choosing who does a job: read from the usage ledger, so nothing new
// is booked. Jobs the chief gave a kind (start_thread kind, synarch-chief.ts) are also counted per kind.
import { listPriceFor } from "./model-prices.ts";
import { readJobKinds } from "./synarch-chief.ts";
import type { ModelMenu } from "./routes/internal-models.ts";
import { readUsage, type UsageRow } from "./usage-ledger.ts";

const WINDOW_DAYS = 30;
const CACHE_MS = 60_000;
const DAY_MS = 24 * 60 * 60_000;

export interface ModelRecord {
  /** Turns that ended ok or with an error; a turn the person stopped says nothing about the model. */
  turns: number;
  failed: number;
  /** Median seconds a turn took, when turns were timed. */
  seconds: number | null;
  /** Average cost of a priced turn. */
  usdPerTurn: number | null;
  /** Turns and failures per kind of work, for the jobs that had one. */
  kinds?: Record<string, { turns: number; failed: number }>;
}

export const recordKey = (instanceId: string, model: string): string => `${instanceId}/${model}`;

export function modelRecords(rows: readonly UsageRow[], jobKinds: ReadonlyMap<string, string> = new Map()): Map<string, ModelRecord> {
  const tallies = new Map<string, { turns: number; failed: number; seconds: number[]; usd: number[]; kinds: Record<string, { turns: number; failed: number }> }>();
  for (const row of rows) {
    const status = row.outcome?.status;
    if (status !== "ok" && status !== "error") continue;
    const key = recordKey(row.instanceId, row.model);
    const tally = tallies.get(key) ?? { turns: 0, failed: 0, seconds: [], usd: [], kinds: {} };
    tally.turns += 1;
    if (status === "error") tally.failed += 1;
    const kind = jobKinds.get(row.threadId);
    if (kind) {
      const perKind = tally.kinds[kind] ??= { turns: 0, failed: 0 };
      perKind.turns += 1;
      if (status === "error") perKind.failed += 1;
    }
    const took = row.startedAt && row.endedAt ? (Date.parse(row.endedAt) - Date.parse(row.startedAt)) / 1000 : NaN;
    if (Number.isFinite(took) && took >= 0) tally.seconds.push(took);
    if (typeof row.costUsd === "number" && Number.isFinite(row.costUsd)) tally.usd.push(row.costUsd);
    tallies.set(key, tally);
  }
  const records = new Map<string, ModelRecord>();
  for (const [key, tally] of tallies) {
    const sorted = tally.seconds.sort((a, b) => a - b);
    records.set(key, {
      turns: tally.turns,
      failed: tally.failed,
      seconds: sorted.length ? Math.round(sorted[Math.floor(sorted.length / 2)]!) : null,
      usdPerTurn: tally.usd.length ? tally.usd.reduce((sum, usd) => sum + usd, 0) / tally.usd.length : null,
      ...(Object.keys(tally.kinds).length ? { kinds: tally.kinds } : {}),
    });
  }
  return records;
}

const KINDS_SHOWN = 5;

const usd = (value: number): string => `$${value < 0.01 ? value.toPrecision(1) : value.toFixed(2)}`;

/** One short line: list price, then what the last 30 days showed. */
export function recordLine(model: string, record: ModelRecord | undefined, at = new Date()): string | null {
  const price = listPriceFor(model, at);
  const parts = [
    ...(price ? [`list ${usd(price.inputPerMillion)} in / ${usd(price.outputPerMillion)} out per 1M tokens`] : []),
    ...(record ? [
      `${record.turns} turns here in ${WINDOW_DAYS} days, ${record.failed} failed`,
      ...(record.seconds !== null ? [`~${record.seconds}s a turn`] : []),
      ...(record.usdPerTurn !== null ? [`~${usd(record.usdPerTurn)} a turn`] : []),
    ] : []),
  ];
  const kinds = Object.entries(record?.kinds ?? {}).sort((a, b) => b[1].turns - a[1].turns).slice(0, KINDS_SHOWN);
  if (kinds.length) parts.push(`by kind: ${kinds.map(([kind, tally]) => `${kind} ${tally.turns} turns ${tally.failed} failed`).join("; ")}`);
  return parts.length ? parts.join(", ") : null;
}

const cache = new Map<string, { at: number; records: Map<string, ModelRecord> }>();

function recentRecords(dataDir: string, now: Date): Map<string, ModelRecord> {
  const cached = cache.get(dataDir);
  if (cached && now.getTime() - cached.at < CACHE_MS) return cached.records;
  let records = new Map<string, ModelRecord>();
  try {
    records = modelRecords(readUsage(dataDir, { from: new Date(now.getTime() - WINDOW_DAYS * DAY_MS), to: now }), readJobKinds(dataDir));
  } catch {
    // The record is advice; a ledger that cannot be read leaves the menu as it was.
  }
  cache.set(dataDir, { at: now.getTime(), records });
  return records;
}

/** The menu with a `track` line for each model it lists, where there is anything to say. */
export function withTrackRecords(menu: ModelMenu | null, dataDir: string, now = new Date()): (ModelMenu & { track?: Record<string, string> }) | null {
  if (!menu) return menu;
  const records = recentRecords(dataDir, now);
  const track: Record<string, string> = {};
  for (const engine of menu.engines) {
    for (const entry of engine.models ?? []) {
      const model = typeof entry === "string" ? entry : entry.id;
      const key = recordKey(engine.instanceId, model);
      const line = recordLine(model, records.get(key), now);
      if (line) track[key] = line;
    }
  }
  return Object.keys(track).length ? { ...menu, track } : menu;
}
