import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PASS } from "./routes/table.ts";
import { createSynarchChiefRoutes, readModelTags, setModelTags, withModelTags } from "./synarch-chief.ts";

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
    startGoal: (goal) => { started.push(goal); }, modelRefusal: () => null, ...overrides,
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
