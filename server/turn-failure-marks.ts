import { failedTurnCause } from "../shared/failed-turn.ts";
import type { Message, Store } from "./store.ts";

/** A failed turn's row, not a turn whose reply came back with one failed step. */
export function endsOnFailure(message: Message): boolean {
  return message.kind === "activity" && !message.tool?.partial && failedTurnCause(message.tool?.name ?? "") !== null;
}

/** Marks a bot's conversation failed when a turn ends on a failure row, and clears the mark with its next text message,
 * so the Active Threads list and a Chief's list_threads can tell failed work from finished work. */
export function markFailedTurns(store: Pick<Store, "onChange" | "bots" | "patchTask">): () => void {
  return store.onChange((change) => {
    if (change.type !== "message") return;
    const failed = endsOnFailure(change.message);
    if (!failed && change.message.kind !== "text") return;
    for (const bot of store.bots) {
      const task = bot.tasks?.find((candidate) => candidate.threadId === change.threadId);
      if (task && (task.failedAt !== undefined) !== failed) store.patchTask(bot.id, change.threadId, { failedAt: failed ? change.message.at : undefined });
    }
  });
}
