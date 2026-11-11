import { describe, expect, it } from "vitest";
import { DEEPSEEK_WORKER_JOBS_PROMPT, WORKER_JOBS_PATCH } from "./synarch-deepseek-jobs.ts";

describe("DeepSeek worker background-job patch", () => {
  it("promotes shell work after 5 seconds and wakes on completion", () => {
    expect(WORKER_JOBS_PATCH).toContain("timeoutMs: 5000");
    expect(WORKER_JOBS_PATCH).toContain("maxTimeoutMs: 5000");
    expect(WORKER_JOBS_PATCH).toContain("waitTimeoutMs: 5000");
    expect(WORKER_JOBS_PATCH).toContain("completionDelivery: wakeup");
    expect(WORKER_JOBS_PATCH).toContain("enableRunInBackground: true");
    expect(WORKER_JOBS_PATCH).toContain("promoteOnTimeout: true");
    expect(WORKER_JOBS_PATCH).toContain("- id: bash-sandbox");
    expect(WORKER_JOBS_PATCH).toContain("- id: pwsh-sandbox");
    expect(WORKER_JOBS_PATCH).toContain("- id: tool-jobs");
  });

  it("overrides the foreground-only long-command advice for workers", () => {
    expect(DEEPSEEK_WORKER_JOBS_PROMPT).toContain("run_in_background");
    expect(DEEPSEEK_WORKER_JOBS_PROMPT).toContain("overrides any instruction to keep long shell work only in the foreground");
  });
});
