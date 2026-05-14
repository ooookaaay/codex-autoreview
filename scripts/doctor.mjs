#!/usr/bin/env node
/**
 * `/codex-autoreview:doctor` — self-diagnostics.
 *
 * A read-only health check for the plugin and its environment. It NEVER
 * mutates anything (no state writes, no file deletion — the "warn-only, never
 * delete user data" rule): every problem is reported with a concrete next
 * action for the user to take.
 *
 * Checks:
 *   - codex CLI installed & runnable (time-boxed `codex --version` probe);
 *   - codex logged in (best-effort `~/.codex/auth.json` / `CODEX_HOME` check);
 *   - the per-project config is valid (backend known, externalCommand config
 *     well-formed, pricing overrides parseable, model/effort/timeout sane);
 *   - any stuck reviews (still `queued`/`running` past their staleness bound —
 *     their worker died without flushing a terminal state);
 *   - orphaned workers (a recorded review `pid` that is no longer alive);
 *   - `~/.codex` log / session bloat (warn-only — the plugin runs `--ephemeral`
 *     so it should not contribute, but a user's interactive use can);
 *   - pricing-table staleness (the hardcoded USD/MTok table has a verified-as-of
 *     date; a stale table makes cost estimates drift).
 *
 * @file
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { getCodexAvailability } from "./lib/codex.mjs";
import {
  PRICING_AS_OF,
  PRICING_STALE_AFTER_DAYS,
  normalizeRateOverride,
  pricingStaleDays
} from "./lib/pricing.mjs";
import { isKnownBackend, BACKEND_IDS } from "./lib/reviewers/index.mjs";
import { validateExternalConfig } from "./lib/reviewers/external.mjs";
import {
  getConfig,
  isReviewLikelyStuck,
  listReviews,
  resolveReviewsDir,
  resolveStateDir
} from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

/** A single diagnostic check result. */
/**
 * @typedef {object} Check
 * @property {string} name - Short check label.
 * @property {"ok" | "warn" | "error"} status
 * @property {string} detail - Human-readable finding.
 * @property {string | null} [action] - Concrete next step when not `ok`.
 */

/**
 * Minimal `--key value` / `--key` flag parser (same shape as the CLI's).
 *
 * @param {string[]} argv
 * @returns {{ cwd: string | null, json: boolean }}
 */
function parseArgs(argv) {
  let cwd = null;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--cwd") {
      cwd = argv[index + 1] ?? "";
      index += 1;
    } else if (token === "--json") {
      json = true;
    }
  }
  return { cwd, json };
}

/**
 * Check whether a process id is still alive (signal 0 probes without killing).
 *
 * @param {number} pid
 * @returns {boolean}
 */
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is owned by another user — alive.
    return /** @type {NodeJS.ErrnoException} */ (error).code === "EPERM";
  }
}

/**
 * Resolve the Codex home directory the same way `codex` does: `CODEX_HOME`
 * env override, else `~/.codex`.
 *
 * @returns {string}
 */
function resolveCodexHome() {
  const override = process.env.CODEX_HOME;
  if (typeof override === "string" && override.trim()) {
    return override.trim();
  }
  return path.join(os.homedir(), ".codex");
}

/**
 * Sum the byte size of every regular file under `dir`, recursively, bounded by
 * `maxEntries` so a pathological tree cannot wedge the doctor. Returns
 * `{ bytes, files, truncated }`.
 *
 * @param {string} dir
 * @param {number} [maxEntries]
 * @returns {{ bytes: number, files: number, truncated: boolean }}
 */
function dirSize(dir, maxEntries = 20000) {
  let bytes = 0;
  let files = 0;
  let truncated = false;
  /** @type {string[]} */
  const stack = [dir];
  while (stack.length > 0) {
    if (files >= maxEntries) {
      truncated = true;
      break;
    }
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        try {
          bytes += fs.statSync(full).size;
          files += 1;
        } catch {
          // Unreadable file — skip.
        }
      }
    }
  }
  return { bytes, files, truncated };
}

/**
 * Format a byte count as a compact human-readable size.
 *
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

/** Warn threshold for `~/.codex` total size (bloat is warn-only). */
const CODEX_HOME_BLOAT_BYTES = 500 * 1024 * 1024;

/**
 * Run every diagnostic check for `workspaceRoot` and return the result list.
 *
 * @param {string} workspaceRoot
 * @returns {Check[]}
 */
export function runDoctorChecks(workspaceRoot) {
  /** @type {Check[]} */
  const checks = [];

  // 1. codex CLI installed & runnable.
  const availability = getCodexAvailability(workspaceRoot);
  if (availability.available) {
    checks.push({
      name: "codex CLI",
      status: "ok",
      detail: `available — ${availability.detail}`
    });
  } else {
    checks.push({
      name: "codex CLI",
      status: "error",
      detail: `not available — ${availability.detail}`,
      action: "Install the Codex CLI: npm install -g @openai/codex"
    });
  }

  // 2. codex logged in — best-effort: the CLI stores auth under CODEX_HOME.
  const codexHome = resolveCodexHome();
  const authFile = path.join(codexHome, "auth.json");
  if (!fs.existsSync(codexHome)) {
    checks.push({
      name: "codex auth",
      status: "warn",
      detail: `no Codex home at ${codexHome} — the CLI has likely never run`,
      action: "Run `codex login` once so background reviews can authenticate."
    });
  } else if (fs.existsSync(authFile)) {
    checks.push({
      name: "codex auth",
      status: "ok",
      detail: `auth file present at ${authFile}`
    });
  } else {
    checks.push({
      name: "codex auth",
      status: "warn",
      detail: `no auth file at ${authFile} — codex may not be logged in`,
      action: "Run `codex login` (or check `codex login status`)."
    });
  }

  // 3. per-project config validity.
  let config;
  try {
    config = getConfig(workspaceRoot);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    checks.push({
      name: "config",
      status: "error",
      detail: `could not read plugin state: ${message}`,
      action: "Inspect the state file under the plugin data dir; it may be corrupt."
    });
    config = null;
  }
  if (config) {
    /** @type {string[]} */
    const configProblems = [];
    if (config.backend && !isKnownBackend(config.backend)) {
      configProblems.push(
        `unknown backend "${config.backend}" (known: ${BACKEND_IDS.join(", ")})`
      );
    }
    if (config.backend === "external") {
      const extProblems = validateExternalConfig(config.backendConfig);
      for (const problem of extProblems) {
        configProblems.push(`externalCommand: ${problem}`);
      }
    }
    if (config.pricing && typeof config.pricing === "object") {
      for (const [model, rate] of Object.entries(config.pricing)) {
        if (!normalizeRateOverride(rate)) {
          configProblems.push(`pricing override for "${model}" is malformed`);
        }
      }
    }
    if (
      config.timeoutMs != null &&
      (!Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0)
    ) {
      configProblems.push(`timeoutMs "${config.timeoutMs}" is not a positive number`);
    }
    if (configProblems.length === 0) {
      checks.push({
        name: "config",
        status: "ok",
        detail: `valid — backend=${config.backend || "exec-generic"}, review=${
          config.enabled ? "ON" : "OFF"
        }${config.onboardedAt ? ", onboarded" : ", NOT onboarded"}`
      });
    } else {
      checks.push({
        name: "config",
        status: "error",
        detail: configProblems.join("; "),
        action:
          "Fix the listed config keys via `/codex-autoreview:config` or `/codex-autoreview:onboard`."
      });
    }
    if (!config.onboardedAt) {
      checks.push({
        name: "onboarding",
        status: "warn",
        detail: "this project has not completed onboarding — review hooks no-op until it does",
        action: "Run `/codex-autoreview:onboard` to finish setup."
      });
    }
  }

  // 4. stuck reviews + 5. orphaned workers.
  let reviews = [];
  try {
    reviews = listReviews(workspaceRoot);
  } catch {
    reviews = [];
  }
  const stuck = reviews.filter((review) => isReviewLikelyStuck(review));
  if (stuck.length === 0) {
    checks.push({
      name: "stuck reviews",
      status: "ok",
      detail: `no stuck reviews (${reviews.length} review${
        reviews.length === 1 ? "" : "s"
      } on record)`
    });
  } else {
    const ids = stuck.map((r) => r.id).join(", ");
    checks.push({
      name: "stuck reviews",
      status: "warn",
      detail: `${stuck.length} review(s) stuck past their staleness bound: ${ids}`,
      action:
        "These will self-heal on the next dispatch or SessionEnd; re-run the action to dispatch a fresh review."
    });
  }

  const orphans = reviews.filter(
    (review) =>
      (review.status === "queued" || review.status === "running") &&
      typeof review.pid === "number" &&
      review.pid > 0 &&
      !isPidAlive(review.pid)
  );
  if (orphans.length === 0) {
    const inFlight = reviews.filter(
      (r) => r.status === "queued" || r.status === "running"
    ).length;
    checks.push({
      name: "review workers",
      status: "ok",
      detail:
        inFlight === 0
          ? "no in-flight reviews; no orphaned workers"
          : `${inFlight} in-flight review(s), all with a live worker`
    });
  } else {
    const ids = orphans.map((r) => r.id).join(", ");
    checks.push({
      name: "review workers",
      status: "warn",
      detail: `${orphans.length} in-flight review(s) whose worker process is gone: ${ids}`,
      action:
        "The worker died without recording a result; the review will self-heal to `failed` on the next dispatch or SessionEnd."
    });
  }

  // 6. ~/.codex log / session bloat — warn-only, NEVER deletes anything.
  if (fs.existsSync(codexHome)) {
    const { bytes, files, truncated } = dirSize(codexHome);
    if (bytes > CODEX_HOME_BLOAT_BYTES) {
      checks.push({
        name: "codex home size",
        status: "warn",
        detail: `${codexHome} holds ${formatBytes(bytes)} across ${files}${
          truncated ? "+" : ""
        } files — large session/log history`,
        action:
          "Optional: prune old files under ~/.codex/sessions and ~/.codex/log yourself. The plugin runs `--ephemeral` and does not add to this; never run automatically."
      });
    } else {
      checks.push({
        name: "codex home size",
        status: "ok",
        detail: `${codexHome} is ${formatBytes(bytes)} (${files}${
          truncated ? "+" : ""
        } files)`
      });
    }
  }

  // 7. pricing-table staleness — soft note only.
  const staleDays = pricingStaleDays();
  if (staleDays > PRICING_STALE_AFTER_DAYS) {
    checks.push({
      name: "pricing table",
      status: "warn",
      detail: `the hardcoded pricing table was last verified ${PRICING_AS_OF} (${staleDays} days ago) — cost estimates may have drifted`,
      action:
        "Cost estimates are advisory. Set a per-model `pricing` override in config if accuracy matters, or update the plugin."
    });
  } else {
    checks.push({
      name: "pricing table",
      status: "ok",
      detail: `verified ${PRICING_AS_OF} (${staleDays} day(s) ago)`
    });
  }

  return checks;
}

/**
 * @param {Check[]} checks
 * @returns {"ok" | "warn" | "error"}
 */
function overallStatus(checks) {
  if (checks.some((c) => c.status === "error")) {
    return "error";
  }
  if (checks.some((c) => c.status === "warn")) {
    return "warn";
  }
  return "ok";
}

/**
 * Render the human-readable doctor report.
 *
 * @param {string} workspaceRoot
 * @param {Check[]} checks
 * @returns {string}
 */
function renderReport(workspaceRoot, checks) {
  const icon = { ok: "OK  ", warn: "WARN", error: "FAIL" };
  const lines = [];
  lines.push(`codex-autoreview doctor — ${workspaceRoot}`);
  lines.push("");
  for (const check of checks) {
    lines.push(`[${icon[check.status]}] ${check.name}: ${check.detail}`);
    if (check.action) {
      lines.push(`         → ${check.action}`);
    }
  }
  lines.push("");
  const overall = overallStatus(checks);
  if (overall === "ok") {
    lines.push("All checks passed — the plugin is healthy.");
  } else if (overall === "warn") {
    lines.push("Some checks raised warnings — see the suggested actions above. Nothing is broken.");
  } else {
    lines.push("Some checks FAILED — the plugin will not work correctly until the actions above are taken.");
  }
  return `${lines.join("\n")}\n`;
}

function main() {
  const { cwd, json } = parseArgs(process.argv.slice(2));
  const workspaceRoot = resolveWorkspaceRoot(
    typeof cwd === "string" && cwd ? cwd : process.cwd()
  );
  const checks = runDoctorChecks(workspaceRoot);
  const overall = overallStatus(checks);

  if (json) {
    console.log(
      JSON.stringify(
        {
          workspaceRoot,
          stateDir: resolveStateDir(workspaceRoot),
          reviewsDir: resolveReviewsDir(workspaceRoot),
          overall,
          checks
        },
        null,
        2
      )
    );
  } else {
    process.stdout.write(renderReport(workspaceRoot, checks));
  }
  // Exit non-zero on a hard error so a caller can gate on it; warnings are 0.
  if (overall === "error") {
    process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
