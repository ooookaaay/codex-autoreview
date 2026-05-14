/**
 * Shared test helpers: temp dirs, git repo init, child-process runner, and a
 * fake `codex` CLI fixture so tests never touch the real Codex.
 *
 * @file
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

/**
 * @returns {string} Absolute path to a fresh temp directory.
 */
export function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codex-autoreview-test-"));
}

/**
 * Initialize a git repository at `dir` with an initial commit.
 *
 * @param {string} dir
 */
export function initGitRepo(dir) {
  run("git", ["init", "-q"], { cwd: dir });
  run("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  run("git", ["config", "user.name", "Test"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "README.md"), "hello\n");
  run("git", ["add", "."], { cwd: dir });
  run("git", ["commit", "-q", "-m", "init"], { cwd: dir });
}

/**
 * Run a command synchronously and return a plain result object.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, input?: string }} [options]
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    input: options.input,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024
  });
  return {
    status: result.status ?? (result.signal ? 1 : 0),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
}

/**
 * Install a fake `codex` executable into `binDir`. The fake mimics the real
 * `codex exec` contract observed in this environment:
 *   - the verdict goes to the `--output-last-message` file (NOT stdout);
 *   - a session transcript goes to stderr;
 *   - `--version` prints a version banner to stdout.
 *
 * With `mode: "fail"` the fake writes nothing to the output file and emits an
 * `ERROR: {...}` line on stderr, simulating a rejected request.
 *
 * @param {string} binDir
 * @param {{ verdict?: string, mode?: "ok" | "fail" }} [options]
 */
export function installFakeCodex(binDir, options = {}) {
  const verdict = options.verdict ?? "CLEAN: the fake codex found no issues.";
  const mode = options.mode ?? "ok";
  const codexPath = path.join(binDir, "codex");
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
if (argv[0] === "--version") {
  process.stdout.write("codex-cli 0.0.0-fake\\n");
  process.exit(0);
}
// codex exec ...
let outputFile = null;
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === "--output-last-message") {
    outputFile = argv[i + 1];
  }
}
let prompt = "";
try {
  prompt = fs.readFileSync(0, "utf8");
} catch {}
process.stderr.write("Reading prompt from stdin...\\nOpenAI Codex (fake)\\n");
if (${JSON.stringify(mode)} === "fail") {
  process.stderr.write('ERROR: {"type":"error","status":400,"error":{"message":"simulated rejection"}}\\n');
  process.exit(1);
}
const message = ${JSON.stringify(verdict)} + "\\n\\nPrompt bytes received: " + prompt.length;
if (outputFile) {
  fs.writeFileSync(outputFile, message + "\\n", "utf8");
}
process.exit(0);
`;
  fs.writeFileSync(codexPath, script, "utf8");
  fs.chmodSync(codexPath, 0o755);
}

/**
 * Install a fake `codex` that HANGS on `codex exec` — it answers `--version`
 * normally, then on `exec` spawns a long-lived grandchild and waits on it
 * forever, never writing the output file. Used to exercise the worker's hard
 * timeout and process-tree kill. The grandchild writes its pid to `pidFile` so
 * a test can assert the whole tree was reaped.
 *
 * @param {string} binDir
 * @param {{ pidFile?: string }} [options]
 */
export function installHangingCodex(binDir, options = {}) {
  const pidFile = options.pidFile ?? path.join(binDir, "grandchild.pid");
  const codexPath = path.join(binDir, "codex");
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const argv = process.argv.slice(2);
if (argv[0] === "--version") {
  process.stdout.write("codex-cli 0.0.0-fake-hang\\n");
  process.exit(0);
}
// codex exec: spawn a grandchild that sleeps "forever", record its pid, and
// block on it. Never write the --output-last-message file.
try { fs.readFileSync(0, "utf8"); } catch {}
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], {
  stdio: "ignore"
});
try { fs.writeFileSync(${JSON.stringify(pidFile)}, String(grandchild.pid), "utf8"); } catch {}
process.stderr.write("OpenAI Codex (fake, hanging)\\n");
// Block this process too, so the whole tree must be killed by the timeout.
setInterval(() => {}, 1e9);
`;
  fs.writeFileSync(codexPath, script, "utf8");
  fs.chmodSync(codexPath, 0o755);
  return { pidFile };
}

/**
 * Build an environment with `binDir` prepended to PATH (so the fake codex wins).
 *
 * @param {string} binDir
 * @param {Record<string, string>} [extra]
 * @returns {NodeJS.ProcessEnv}
 */
export function buildEnv(binDir, extra = {}) {
  return {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    ...extra
  };
}

/**
 * Build an environment with `codex` stripped from PATH (but `node` and `git`
 * still resolvable), used to test the "CLI absent" path. Works even when
 * `codex` and `node` share a directory by building a clean bin dir that
 * contains only symlinks to `node` and `git`.
 *
 * @param {Record<string, string>} [extra]
 * @returns {NodeJS.ProcessEnv}
 */
export function buildEnvWithoutCodex(extra = {}) {
  const cleanBin = makeTempDir();
  const nodeTarget = process.execPath;
  fs.symlinkSync(nodeTarget, path.join(cleanBin, "node"));
  // Locate git so it stays available; skip silently if not found.
  const gitProbe = spawnSync(process.platform === "win32" ? "where" : "which", ["git"], {
    encoding: "utf8"
  });
  const gitPath = (gitProbe.stdout ?? "").trim().split(/\r?\n/)[0];
  if (gitPath) {
    fs.symlinkSync(gitPath, path.join(cleanBin, "git"));
  }
  return {
    ...process.env,
    PATH: cleanBin,
    ...extra
  };
}

/**
 * Wait until `predicate()` is truthy or the timeout elapses.
 *
 * @param {() => boolean} predicate
 * @param {{ timeoutMs?: number, intervalMs?: number }} [options]
 * @returns {Promise<boolean>}
 */
export async function waitFor(predicate, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10000;
  const intervalMs = options.intervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return predicate();
}
