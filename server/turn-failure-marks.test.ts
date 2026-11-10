import { describe, expect, it } from "vitest";

import { failedTurnTool } from "../shared/failed-turn.ts";
import type { Message, StoreChange, TaskRecord } from "./store.ts";
import { markFailedTurns } from "./turn-failure-marks.ts";

function fixture() {
  const task = { threadId: "t1", title: "Export", createdAt: 1 } as TaskRecord;
  let listener: (change: StoreChange) => void = () => {};
  const patches: Array<Partial<TaskRecord>> = [];
  markFailedTurns({
    onChange: (next) => { listener = next; return () => {}; },
    bots: [{ id: "b1", tasks: [task] }] as never,
    patchTask: (_botId, _threadId, patch) => { patches.push(patch); Object.assign(task, patch); if (patch.failedAt === undefined) delete task.failedAt; return task; },
  });
  const send = (message: Partial<Message>, threadId = "t1") =>
    listener({ type: "message", threadId, message: { id: "m", at: 50, role: "bot", ...message } as Message });
  return { task, patches, send };
}

describe("markFailedTurns", () => {
  it("marks a conversation whose turn ends on a failure row and clears it with the next text", () => {
    const { task, patches, send } = fixture();
    send({ kind: "activity", tool: failedTurnTool("engine crashed") });
    expect(task.failedAt).toBe(50);
    send({ kind: "activity", tool: { name: "Read", ok: true } });
    send({ kind: "text", role: "user", text: "try again" });
    expect(task.failedAt).toBeUndefined();
    expect(patches).toEqual([{ failedAt: 50 }, { failedAt: undefined }]);
  });

  it("ignores a reply that came back with one failed step, and other conversations", () => {
    const { task, patches, send } = fixture();
    send({ kind: "activity", tool: failedTurnTool("a step failed", { partial: true }) });
    send({ kind: "activity", tool: failedTurnTool("engine crashed") }, "elsewhere");
    send({ kind: "text", text: "done" });
    expect(task.failedAt).toBeUndefined();
    expect(patches).toEqual([]);
  });
});
