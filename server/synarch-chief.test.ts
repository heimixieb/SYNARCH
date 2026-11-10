import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PASS } from "./routes/table.ts";
import { CHIEF_HANDS_OFF, CHIEF_JOB_NOTE, chiefJobMessage, chiefWorkerModel, createChiefFence, createSynarchChiefRoutes, createSynarchSettingsRoutes, isChiefRouterThread, isTeamToolRequest, ownJobFolders, readJobKinds, readModelTags, readSynarchSettings, setJobKind, setModelTags, withModelTags } from "./synarch-chief.ts";

const dirs: string[] = [];
const dataDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "synarch-chief-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("model tags", () => {
  it("saves, replaces and removes a model's tags, and survives a broken file", () => {
    const dir = dataDir();
    expect(readModelTags(dir)).toEqual({});
    setModelTags(dir, "claude", "opus", "  code,\n long documents ");
    setModelTags(dir, "deepseek", "flash", "cheap Chinese drafts");
    expect(readModelTags(dir)).toEqual({ "claude/opus": "code, long documents", "deepseek/flash": "cheap Chinese drafts" });
    setModelTags(dir, "claude", "opus", "code only");
    setModelTags(dir, "deepseek", "flash", "  ");
    expect(readModelTags(dir)).toEqual({ "claude/opus": "code only" });
    writeFileSync(join(dir, "model-tags.json"), "{ broken");
    expect(readModelTags(dir)).toEqual({});
  });

  it("adds every tag to the model menu, and leaves a menu with no tags as it was", () => {
    const dir = dataDir();
    const menu = { current: { instanceId: "claude", model: "opus" }, engines: [] };
    expect(withModelTags(menu, dir)).toBe(menu);
    expect(withModelTags(null, dir)).toBeNull();
    setModelTags(dir, "grok", "fast", "web search");
    expect(withModelTags(menu, dir)).toEqual({ ...menu, tags: { "grok/fast": "web search" } });
  });
});

function harness(overrides: Partial<Parameters<typeof createSynarchChiefRoutes>[0]> = {}) {
  const dir = dataDir();
  const started: string[] = [];
  const route = createSynarchChiefRoutes({
    dataDir: dir, requireActive: () => {}, isChief: () => true, goalRefusal: () => null,
    startGoal: (goal) => { started.push(goal); }, modelRefusal: () => null, ownsThread: (id) => id.startsWith("own"), ...overrides,
  });
  const call = async (path: string, body: unknown, method = "POST") => {
    let reply: { status: number; value: Record<string, unknown> } | undefined;
    const outcome = await route({
      req: {} as never, res: {} as never, url: new URL(`http://x${path}`), path, method, auth: {} as never,
      json: ((_res: unknown, status: number, value: Record<string, unknown>) => { reply = { status, value }; }) as never,
      readBody: (async () => body) as never,
    });
    return outcome === PASS ? PASS : reply!;
  };
  return { dir, started, call };
}

describe("chief routes", () => {
  it("leaves other paths and methods to the next route", async () => {
    const { call } = harness();
    expect(await call("/api/internal/models", {})).toBe(PASS);
    expect(await call("/api/internal/goals", {}, "GET")).toBe(PASS);
  });

  it("lets only a chief tag a model or start a goal", async () => {
    const { call, started } = harness({ isChief: () => false });
    expect(await call("/api/internal/goals", { goal: "write a poem" })).toMatchObject({ status: 403 });
    expect(await call("/api/internal/model-tags", { instanceId: "a", model: "b", tags: "x" })).toMatchObject({ status: 403 });
    expect(started).toEqual([]);
  });

  it("tags only a model the chief could run, and removes tags from any model", async () => {
    const { call, dir } = harness({ modelRefusal: (instanceId) => (instanceId === "gone" ? "That engine is not set up." : null) });
    expect(await call("/api/internal/model-tags", { instanceId: "claude", model: "opus", tags: "code" })).toMatchObject({ status: 200 });
    expect(await call("/api/internal/model-tags", { instanceId: "gone", model: "m", tags: "x" })).toMatchObject({ status: 400 });
    expect(await call("/api/internal/model-tags", { instanceId: "", model: "m", tags: "x" })).toMatchObject({ status: 400 });
    setModelTags(dir, "gone", "m", "old");
    expect(await call("/api/internal/model-tags", { instanceId: "gone", model: "m", tags: "" })).toMatchObject({ status: 200 });
    expect(readModelTags(dir)).toEqual({ "claude/opus": "code" });
  });

  it("starts a goal only when the turn may, and reports a goal that could not start", async () => {
    const ok = harness();
    expect(await ok.call("/api/internal/goals", { goal: "  write a poem  " })).toMatchObject({ status: 200 });
    expect(ok.started).toEqual(["write a poem"]);
    expect(await ok.call("/api/internal/goals", { goal: " " })).toMatchObject({ status: 400 });

    const outside = harness({ goalRefusal: () => "Only the person's own request in this conversation can start a goal." });
    expect(await outside.call("/api/internal/goals", { goal: "delete everything" })).toMatchObject({ status: 409 });
    expect(outside.started).toEqual([]);

    const running = harness({ startGoal: () => { throw new Error("A goal is already running here."); } });
    expect(await running.call("/api/internal/goals", { goal: "again" })).toMatchObject({ status: 409, value: { error: "No goal started: A goal is already running here." } });
  });
});

describe("stages and settings", () => {
  it("records a job's kind only for the chief's own jobs, newest kind wins", async () => {
    const { call, dir } = harness();
    expect(await call("/api/internal/job-kind", { threadId: "own-1", kind: "  Writing " })).toMatchObject({ status: 200, value: { kind: "writing" } });
    expect(await call("/api/internal/job-kind", { threadId: "someone-else", kind: "code" })).toMatchObject({ status: 404 });
    expect(await call("/api/internal/job-kind", { threadId: "own-2", kind: " " })).toMatchObject({ status: 400 });
    setJobKind(dir, "own-1", "review");
    expect([...readJobKinds(dir)]).toEqual([["own-1", "review"]]);
  });

  it("lets a chief attach from the folders of jobs it opened, nothing else", () => {
    const tasks = [{ threadId: "w1", openedBy: { botId: "chief" } }, { threadId: "w2", cwd: "/project", openedBy: { botId: "chief" } }, { threadId: "mine" }, { threadId: "x", openedBy: { botId: "other" } }];
    expect(ownJobFolders({ id: "chief", chiefOfStaff: true }, tasks, "/data/task-workspaces")).toEqual([join("/data/task-workspaces", "chief", "w1")]);
    expect(ownJobFolders({ id: "chief", chiefOfStaff: false }, tasks, "/data/task-workspaces")).toEqual([]);
    expect(ownJobFolders({ id: "chief", chiefOfStaff: true, cwd: "/project" }, tasks, "/data/task-workspaces"), "its jobs share its own folder").toEqual([]);
  });

  it("turns independent checks off and on, and edits tags from the settings page", async () => {
    const dir = dataDir();
    const route = createSynarchSettingsRoutes({ dataDir: dir });
    const call = async (path: string, method: string, body: unknown = {}) => {
      let reply: { status: number; value: Record<string, unknown> } | undefined;
      const outcome = await route({ req: {} as never, res: {} as never, url: new URL(`http://x${path}`), path, method, auth: {} as never,
        json: ((_res: unknown, status: number, value: Record<string, unknown>) => { reply = { status, value }; }) as never, readBody: (async () => body) as never });
      return outcome === PASS ? PASS : reply!;
    };
    expect(readSynarchSettings(dir)).toEqual({ checkGoals: true });
    expect(await call("/api/synarch/settings", "POST", { checkGoals: "no" })).toMatchObject({ status: 400 });
    expect(await call("/api/synarch/settings", "POST", { checkGoals: false })).toMatchObject({ status: 200, value: { checkGoals: false } });
    expect(await call("/api/synarch/model-tags", "POST", { instanceId: "deepseek", model: "flash", tags: "cheap drafts" })).toMatchObject({ status: 200 });
    expect(await call("/api/synarch/settings", "GET")).toMatchObject({ status: 200, value: { checkGoals: false, tags: { "deepseek/flash": "cheap drafts" } } });
    expect(await call("/api/synarch/other", "GET")).toBe(PASS);
    expect(await call("/api/synarch/settings", "POST", { workerModel: { instanceId: "deepseek", model: "flash" } })).toMatchObject({ status: 200, value: { checkGoals: false, workerModel: { instanceId: "deepseek", model: "flash" } } });
    expect(await call("/api/synarch/settings", "POST", { checkGoals: true })).toMatchObject({ value: { checkGoals: true, workerModel: { model: "flash" } } });
    expect(await call("/api/synarch/settings", "POST", { workerModel: { model: "flash" } })).toMatchObject({ status: 400 });
    expect(await call("/api/synarch/settings", "POST", {})).toMatchObject({ status: 400 });
    expect(await call("/api/synarch/settings", "POST", { workerModel: null })).toMatchObject({ status: 200, value: { checkGoals: true } });
    expect(readSynarchSettings(dir)).toEqual({ checkGoals: true });
  });

  it("runs a chief's own job on the person's default worker model only when the chief named none", async () => {
    const dir = dataDir();
    const route = createSynarchSettingsRoutes({ dataDir: dir });
    await route({ req: {} as never, res: {} as never, url: new URL("http://x/api/synarch/settings"), path: "/api/synarch/settings", method: "POST", auth: {} as never,
      json: (() => {}) as never, readBody: (async () => ({ workerModel: { instanceId: "ds", model: "flash" } })) as never });
    const chief = { chiefOfStaff: true };
    expect(chiefWorkerModel(dir, chief, undefined, true)).toEqual({ instanceId: "ds", model: "flash" });
    expect(chiefWorkerModel(dir, chief, { instanceId: "ds", model: "pro" }, true)).toEqual({ instanceId: "ds", model: "pro" });
    expect(chiefWorkerModel(dir, chief, undefined, false), "a teammate's thread runs its own model").toBeUndefined();
    expect(chiefWorkerModel(dir, { chiefOfStaff: false }, undefined, true)).toBeUndefined();
    expect(chiefWorkerModel(dataDir(), chief, undefined, true), "no default set").toBeUndefined();
  });

  it("hands a job the person's own words and how to report, once", () => {
    const job = chiefJobMessage("Write the poem's second stanza.", "写一首冬天的诗，两段");
    expect(job).toContain("Write the poem's second stanza.");
    expect(job).toContain("写一首冬天的诗，两段");
    expect(job.endsWith(CHIEF_JOB_NOTE)).toBe(true);
    expect(chiefJobMessage("Do this: 写一首诗", "写一首诗").match(/写一首诗/g)).toHaveLength(1);
    expect(chiefJobMessage("Brief", undefined)).toBe(`Brief\n\n${CHIEF_JOB_NOTE}`);
  });
});

describe("the chief's hands are off in the person's conversations", () => {
  it("lets only team tools through, in every engine's words, and nothing with a vague label", () => {
    expect(isTeamToolRequest("mcp__agents__start_thread", "start_thread")).toBe(true);
    expect(isTeamToolRequest("tool", "mcp__agents__coordinate_bots")).toBe(true);
    expect(isTeamToolRequest("start_thread", "Allow the agents MCP server to run tool \"start_thread\"?")).toBe(true);
    for (const [tool, summary] of [["Bash", "rm -rf x"], ["Write", "winter.txt"], ["edit", "write winter.txt"], ["shell", "ls"], ["tool", "tool"], ["other", "escalate to workspace-write"], ["WebFetch", "https://x"], ["permissions", "more access"]]) {
      expect(isTeamToolRequest(tool!, summary!), `${tool}: ${summary}`).toBe(false);
    }
  });

  it("fences the chief's main conversation and the ones the person opened, never one a bot or a routine opened", () => {
    const chief = { chiefOfStaff: true, threadId: "main" };
    expect(isChiefRouterThread(chief, "main", undefined, false)).toBe(true);
    expect(isChiefRouterThread(chief, "mine", { }, false)).toBe(true);
    expect(isChiefRouterThread(chief, "worker", { openedBy: { botId: "chief" } }, false), "a thread it handed a job to").toBe(false);
    expect(isChiefRouterThread(chief, "brief", { routineRunId: "r1" }, false)).toBe(false);
    expect(isChiefRouterThread(chief, "main", undefined, true), "a routine running in its main thread").toBe(false);
    expect(isChiefRouterThread(chief, "room-thread", undefined, false), "a room, which is no task of its own").toBe(false);
    expect(isChiefRouterThread({ chiefOfStaff: false, threadId: "main" }, "main", undefined, false)).toBe(false);
    expect(isChiefRouterThread(undefined, "main", undefined, false)).toBe(false);
  });

  function fence(router = true) {
    const answers: Array<{ threadId: string; requestId: string; decision: unknown }> = [], said: string[] = [], released: string[] = [];
    const adapter = {
      respondToRequest: async (threadId: string, requestId: string, decision: unknown) => { answers.push({ threadId, requestId, decision }); return "rejected" as const; },
      interruptTurn: async () => {},
    };
    const chiefFence = createChiefFence({ router: () => router, adapter: () => adapter, stale: () => false, release: (threadId) => { released.push(threadId); } });
    const ask = (tool: string, requestType: "permission" | "question" = "permission") => chiefFence.answers(
      { type: "request.opened", threadId: "main", turnId: "t1", requestId: "q1", requestType, tool, summary: `${tool} something` } as never,
      { id: "chief", modelSelection: { instanceId: "deepseek" } },
      (message) => { said.push(message.tool.name); },
    );
    return { ask, answers, said, released };
  }

  it("refuses a hands-on request with a note to hand the job out, and lets everything else go on to the person's own level", async () => {
    const f = fence();
    expect(f.ask("write")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.answers).toEqual([{ threadId: "main", requestId: "q1", decision: { behavior: "deny", message: CHIEF_HANDS_OFF } }]);
    expect(f.said[0]).toContain("Handed out, not done here");
    expect(f.released).toEqual(["main"]);
    expect(f.ask("tool"), "a sandbox escalation with a bare label").toBe(true);
    expect(f.ask("mcp__agents__start_thread")).toBe(false);
    expect(f.ask("shell", "question"), "a question is the person's to answer").toBe(false);
    expect(fence(false).ask("Bash"), "outside the person's conversations nothing is refused").toBe(false);
  });
});
