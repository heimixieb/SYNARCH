// DeepSeek Super-agent worker shell: promote long commands to background jobs quickly, wake on
// completion, and override OpenMausBot's "stay in the foreground" shell advice for workers only.
// The chief's hands-off patch still disables bash/jobs entirely.

/** dsh overlay for a worker turn: 5s foreground → background job (prototype worker preset). */
export const WORKER_JOBS_PATCH = [
  "- id: bash-sandbox", "  config:", "    timeoutMs: 5000", "    maxTimeoutMs: 5000",
  "- id: pwsh-sandbox", "  config:", "    timeoutMs: 5000", "    maxTimeoutMs: 5000",
  "- id: tool-bash", "  config:", "    enableRunInBackground: true", "    promoteOnTimeout: true",
  "- id: tool-pwsh", "  config:", "    enableRunInBackground: true", "    promoteOnTimeout: true",
  "- id: tool-jobs", "  config:", "    waitTimeoutMs: 5000", "    maxWaitTimeoutMs: 5000", "    completionDelivery: wakeup",
  "",
].join("\n");

/** Appended to a DeepSeek worker prompt so OMB's long-command advice does not fight dsh jobs. */
export const DEEPSEEK_WORKER_JOBS_PROMPT =
  " DeepSeek background jobs: for anything that may take more than a few seconds (builds, tests, installs, long scripts),"
  + " prefer bash/pwsh with run_in_background true, or let a short foreground timeout move it to a background job."
  + " Track each job id; you are notified when it finishes — do not sleep-poll. Use job_output (wait true only when you are"
  + " blocked on it), job_list and job_kill. Do not claim the overall job done until every still-relevant background command"
  + " has finished or you have killed it. This overrides any instruction to keep long shell work only in the foreground.";
