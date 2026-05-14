#!/usr/bin/env node
/**
 * codex-autoreview CLI — backs the plugin's slash commands.
 *
 * Subcommands:
 *   config  - view or change the per-project toggle, model, and effort
 *   last    - show the most recent stored review verdict (replay)
 *
 * @file
 */

import process from "node:process";

import {
  CODEX_DEFAULT_LABEL,
  VALID_REASONING_EFFORTS,
  getCodexAvailability,
  normalizeModel,
  normalizeReasoningEffort,
  resolveReviewEffort,
  resolveReviewModel
} from "./lib/codex.mjs";
import { getConfig, getLatestReview, setConfig } from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

/**
 * Minimal flag parser: `--key value` for value flags, `--key` for booleans.
 *
 * @param {string[]} argv
 * @param {{ valueFlags: string[], boolFlags: string[] }} spec
 * @returns {{ options: Record<string, string | boolean>, positionals: string[] }}
 */
function parseArgs(argv, spec) {
  /** @type {Record<string, string | boolean>} */
  const options = {};
  /** @type {string[]} */
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      if (spec.valueFlags.includes(key)) {
        options[key] = argv[index + 1] ?? "";
        index += 1;
      } else if (spec.boolFlags.includes(key)) {
        options[key] = true;
      } else {
        throw new Error(`Unknown flag: ${token}`);
      }
    } else {
      positionals.push(token);
    }
  }
  return { options, positionals };
}

/**
 * @param {Record<string, string | boolean>} options
 * @returns {string}
 */
function resolveCwd(options) {
  const raw = typeof options.cwd === "string" && options.cwd ? options.cwd : process.cwd();
  return resolveWorkspaceRoot(raw);
}

/**
 * @param {unknown} value
 * @param {boolean} asJson
 */
function output(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
  }
}

/**
 * Build the human-readable config report.
 *
 * @param {string} workspaceRoot
 * @param {string[]} actionsTaken
 * @returns {{ payload: object, rendered: string }}
 */
function buildConfigReport(workspaceRoot, actionsTaken) {
  const config = getConfig(workspaceRoot);
  const availability = getCodexAvailability(workspaceRoot);
  const model = resolveReviewModel(config);
  const effort = resolveReviewEffort(config);

  const payload = {
    workspaceRoot,
    enabled: Boolean(config.enabled),
    model,
    effort,
    codexAvailable: availability.available,
    codexDetail: availability.detail,
    actionsTaken
  };

  const lines = [];
  if (actionsTaken.length > 0) {
    for (const action of actionsTaken) {
      lines.push(`- ${action}`);
    }
    lines.push("");
  }
  lines.push(`codex-autoreview for ${workspaceRoot}`);
  lines.push(`  status:  ${payload.enabled ? "ON" : "OFF"}`);
  lines.push(`  model:   ${model ?? `${CODEX_DEFAULT_LABEL} (from ~/.codex/config.toml)`}`);
  lines.push(`  effort:  ${effort ?? `${CODEX_DEFAULT_LABEL} (from ~/.codex/config.toml)`}`);
  lines.push(
    `  codex:   ${availability.available ? `available — ${availability.detail}` : `NOT available — ${availability.detail}`}`
  );
  if (!availability.available) {
    lines.push("");
    lines.push("Install the Codex CLI separately: npm install -g @openai/codex");
  }
  if (payload.enabled) {
    lines.push("");
    lines.push(
      'Tip: add a statusLine entry running `node "${CLAUDE_PLUGIN_ROOT}/scripts/statusline.mjs"` to see the ON marker.'
    );
  }
  return { payload, rendered: `${lines.join("\n")}\n` };
}

/**
 * @param {string[]} argv
 */
function handleConfig(argv) {
  const { options } = parseArgs(argv, {
    valueFlags: ["cwd", "model", "effort"],
    boolFlags: ["json", "enable", "disable"]
  });

  if (options.enable && options.disable) {
    throw new Error("Choose either --enable or --disable, not both.");
  }

  const workspaceRoot = resolveCwd(options);
  const actionsTaken = [];

  if (options.enable) {
    setConfig(workspaceRoot, "enabled", true);
    actionsTaken.push(`Enabled automatic Codex review for ${workspaceRoot}.`);
  } else if (options.disable) {
    setConfig(workspaceRoot, "enabled", false);
    actionsTaken.push(`Disabled automatic Codex review for ${workspaceRoot}.`);
  }

  if (options.model != null) {
    const model = normalizeModel(options.model);
    setConfig(workspaceRoot, "model", model);
    actionsTaken.push(
      model
        ? `Set the Codex review model to ${model}.`
        : `Cleared the model override (codex will use its own config default).`
    );
  }

  if (options.effort != null) {
    const effort = normalizeReasoningEffort(options.effort);
    setConfig(workspaceRoot, "effort", effort);
    actionsTaken.push(
      effort
        ? `Set the Codex review reasoning effort to ${effort}.`
        : `Cleared the effort override (codex will use its own config default).`
    );
  }

  const report = buildConfigReport(workspaceRoot, actionsTaken);
  output(options.json ? report.payload : report.rendered, Boolean(options.json));
}

/**
 * @param {string[]} argv
 */
function handleLast(argv) {
  const { options, positionals } = parseArgs(argv, {
    valueFlags: ["cwd", "kind"],
    boolFlags: ["json"]
  });

  const workspaceRoot = resolveCwd(options);
  const kindArg = (typeof options.kind === "string" && options.kind) || positionals[0] || "";
  const kind = kindArg === "plan" || kindArg === "code" ? kindArg : undefined;

  const review = getLatestReview(workspaceRoot, kind ? { kind } : {});

  if (!review) {
    const message = kind
      ? `No ${kind} review has run yet for ${workspaceRoot}.\n`
      : `No Codex review has run yet for ${workspaceRoot}.\n`;
    output(options.json ? { review: null, workspaceRoot } : message, Boolean(options.json));
    return;
  }

  if (options.json) {
    output({ review, workspaceRoot }, true);
    return;
  }

  const lines = [];
  lines.push(`Last Codex ${review.kind} review (${review.id})`);
  lines.push(`  status:    ${review.status}`);
  lines.push(`  updated:   ${review.updatedAt}`);
  if (review.verdict) {
    lines.push(`  verdict:   ${review.verdict}`);
  }
  if (review.errorMessage) {
    lines.push(`  error:     ${review.errorMessage}`);
  }
  lines.push("");
  if (review.output) {
    lines.push("--- Codex output ---");
    lines.push(review.output);
  } else if (review.status === "queued" || review.status === "running") {
    lines.push("The review is still running in the background. Re-run /codex-autoreview:last shortly.");
  } else {
    lines.push("(no output captured)");
  }
  output(`${lines.join("\n")}\n`, false);
}

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/codex-autoreview.mjs config [--enable|--disable] [--model <model>] " +
        `[--effort <${VALID_REASONING_EFFORTS.join("|")}>] [--cwd <dir>] [--json]`,
      "  node scripts/codex-autoreview.mjs last [plan|code] [--kind <plan|code>] [--cwd <dir>] [--json]"
    ].join("\n")
  );
}

function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "config":
      handleConfig(argv);
      break;
    case "last":
      handleLast(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
