// Isolated dev server on the real DeepSeek Harness (`npm i -g @deepseek-ai/dsh`): temporary home and data dir, only dsh
// added to PATH. Security: the key is read from %USERPROFILE%\.synarch\deepseek.env and copied into the data dir's
// config.json, so delete the printed dataDir after stopping. Drive it with `scripts/control-omb.ts ... --url URL`.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { verificationServerArgs, verificationServerEnvironment } from "../control-omb.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const key = /^DEEPSEEK_API_KEY=(.+)$/m.exec(readFileSync(join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".synarch", "deepseek.env"), "utf8"))?.[1]?.trim();
if (!key) throw new Error("No DEEPSEEK_API_KEY in ~/.synarch/deepseek.env");
const npmBin = process.platform === "win32" ? join(process.env.APPDATA ?? "", "npm") : dirname(process.execPath);
const dataDir = mkdtempSync(join(tmpdir(), "omb-deepseek-"));
mkdirSync(join(dataDir, "tmp"), { recursive: true });
writeFileSync(join(dataDir, "config.json"), JSON.stringify({
  features: { smartSetupChoices: false },
  deepseek: { key },
  instances: { deepseek: { driver: "deepseekAgent", displayName: "DeepSeek", config: { cli: join(npmBin, process.platform === "win32" ? "dsh.cmd" : "dsh") } } },
}, null, 2), { mode: 0o600 });
const port = 21400 + Math.floor(Math.random() * 400) * 2;
const env = verificationServerEnvironment(process.env, dataDir, port);
env.OMB_EXTRA_PATH = process.platform === "win32" ? [npmBin, join(env.SYSTEMROOT || "C:\\Windows", "System32")].join(";") : npmBin;
const log = openSync(join(dataDir, "server.log"), "a");
const child = spawn(process.execPath, verificationServerArgs(env), { cwd: ROOT, env, stdio: ["ignore", log, log] });
console.log(JSON.stringify({ url: `http://127.0.0.1:${port}`, pid: child.pid, dataDir }));
child.on("exit", (code) => {
  console.log(JSON.stringify({ exited: code }));
  process.exit(0);
});
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => child.kill());
