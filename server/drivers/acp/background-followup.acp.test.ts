import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type { ProviderInstance } from "../../contracts.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { recordEvents } from "../../testing/events.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");

const scratches: string[] = [];
const instances: ProviderInstance[] = [];

afterEach(async () => {
  for (const instance of instances.splice(0)) await instance.dispose();
  for (const scratch of scratches.splice(0)) removeTempDir(scratch);
});

describe("ACP autonomous background-job follow-ups", () => {
  it("holds end_turn until a post-prompt wakeup arrives, then completes the same turn", async () => {
    process.env.OMB_ACP_BG_SETTLE_QUIET_MS = "120";
    const scratch = mkdtempSync(join(tmpdir(), "omb-acp-bg-"));
    scratches.push(scratch);
    const support: AcpSupport = {
      driverKind: "bgFollowupTest",
      displayName: "BG Followup Test",
      models: { default: "m-one", options: [{ id: "m-one", label: "One" }] },
      defaultCli: FAKE_CLI,
      nativeSource: "bg-followup.acp",
      loginNote: "never reached",
      spawnArgs: () => [],
      pickAuthMethod: () => null,
      authFailure: "continue",
      isAuthenticated: () => true,
      autonomousFollowups: true,
    };
    const driver = createAcpDriver(support);
    const instance = await driver.create({
      instanceId: "bg-followup",
      displayName: "BG Followup",
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true, workspace: scratch },
      environment: {
        FAKE_ACP_BG_JOB_FOLLOWUP: "1",
        FAKE_ACP_BG_JOB_FOLLOWUP_MS: "80",
      },
    });
    instances.push(instance);
    const recorder = recordEvents(instance.adapter);
    const started = Date.now();
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-bg", text: "build", approvalMode: "full", cwd: scratch });
    const done = await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    expect(done).toMatchObject({ ok: true, turnId });
    expect(Date.now() - started).toBeGreaterThanOrEqual(80);
    const texts = recorder.events
      .filter((event) => event.turnId === turnId && event.type === "item.completed" && event.itemType === "assistant_text")
      .map((event) => ("text" in event ? String(event.text) : ""));
    expect(texts.join("")).toContain("build started in the background");
    expect(texts.join("")).toContain("build done");
    delete process.env.OMB_ACP_BG_SETTLE_QUIET_MS;
  }, 15_000);
});
