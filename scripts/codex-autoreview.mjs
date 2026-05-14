#!/usr/bin/env node
/**
 * codex-autoreview CLI — backs the plugin's slash commands.
 *
 * Subcommands:
 *   config   - view or change the per-project settings (toggle, model, effort,
 *              timeout, reviewer backend, externalCommand config, pricing
 *              overrides, profile)
 *   last     - show the most recent stored review verdict (replay)
 *   run      - dispatch a manual on-demand review, wait for it, print the
 *              verdict. Designed to be invoked from a native Claude Agent-tool
 *              subagent (see commands/run.md) so the review shows in Claude's
 *              status with the harness's own timer/tokens.
 *   onboard  - re-run / inspect the guided onboarding flow; `--complete` marks
 *              the project onboarded once setup is done.
 *   doctor   - delegates to scripts/doctor.mjs (self-diagnostics).
 *
 * @file
 */

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  CODEX_DEFAULT_LABEL,
  DEFAULT_REVIEW_EFFORT,
  DEFAULT_REVIEW_TIMEOUT_MS,
  VALID_REASONING_EFFORTS,
  getCodexAvailability,
  hasEffortOverride,
  normalizeModel,
  normalizeReasoningEffort,
  normalizeTimeoutMs,
  resolveReviewEffort,
  resolveReviewModel,
  resolveReviewTimeoutMs
} from "./lib/codex.mjs";
import { dispatchBackgroundReview } from "./lib/auto-review.mjs";
import { getWorkingTreeState } from "./lib/git.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import { PRICING_AS_OF, normalizeRateOverride } from "./lib/pricing.mjs";
import { BACKEND_IDS, isKnownBackend, DEFAULT_BACKEND_ID } from "./lib/reviewers/index.mjs";
import { validateExternalConfig } from "./lib/reviewers/external.mjs";
import { REVIEW_PROFILES } from "./lib/review-schema.mjs";
import {
  STALE_RUNNING_MS,
  getConfig,
  getLatestReview,
  getOnboardedAt,
  isOnboarded,
  isReviewLikelyStuck,
  isTerminalStatus,
  listReviews,
  markOnboarded,
  setConfig
} from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");

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
 * Sleep `ms` milliseconds.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse a JSON object from a string flag, returning `null` on bad/empty input.
 *
 * @param {unknown} raw
 * @returns {object | null}
 */
function parseJsonFlag(raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    return null;
  }
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("expected a JSON object");
  }
  return parsed;
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
  const effortIsOverride = hasEffortOverride(config);
  const timeoutMs = resolveReviewTimeoutMs(config);
  const timeoutIsOverride =
    typeof config.timeoutMs === "number" && Number.isFinite(config.timeoutMs) && config.timeoutMs > 0;
  const backend = isKnownBackend(config.backend) ? config.backend : DEFAULT_BACKEND_ID;
  const profile =
    typeof config.profile === "string" && REVIEW_PROFILES.includes(config.profile)
      ? config.profile
      : null;
  const pricingModels =
    config.pricing && typeof config.pricing === "object" ? Object.keys(config.pricing) : [];

  const payload = {
    workspaceRoot,
    enabled: Boolean(config.enabled),
    onboarded: Boolean(config.onboardedAt),
    model,
    effort,
    effortIsDefault: !effortIsOverride,
    timeoutMs,
    timeoutIsDefault: !timeoutIsOverride,
    backend,
    backendConfigured: Boolean(config.backendConfig),
    profile,
    pricingOverrides: pricingModels,
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
  lines.push(`  status:    ${payload.enabled ? "ON" : "OFF"}`);
  lines.push(`  onboarded: ${payload.onboarded ? "yes" : "NO — run /codex-autoreview:onboard"}`);
  lines.push(`  model:     ${model ?? `${CODEX_DEFAULT_LABEL} (from ~/.codex/config.toml)`}`);
  lines.push(
    `  effort:    ${effort}${
      effortIsOverride ? "" : " (plugin default — independent of ~/.codex/config.toml)"
    }`
  );
  lines.push(
    `  timeout:   ${Math.round(timeoutMs / 1000)}s${timeoutIsOverride ? "" : " (default)"}`
  );
  lines.push(
    `  backend:   ${backend}${backend === DEFAULT_BACKEND_ID ? " (default)" : ""}${
      backend === "external" ? (payload.backendConfigured ? " — externalCommand set" : " — externalCommand NOT set") : ""
    }`
  );
  lines.push(`  profile:   ${profile ?? "(per-kind default)"}`);
  lines.push(
    `  pricing:   ${
      pricingModels.length > 0 ? `overrides for ${pricingModels.join(", ")}` : "hardcoded table"
    }`
  );
  lines.push(
    `  codex:     ${availability.available ? `available — ${availability.detail}` : `NOT available — ${availability.detail}`}`
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
    valueFlags: [
      "cwd",
      "model",
      "effort",
      "timeout",
      "backend",
      "backend-config",
      "profile",
      "pricing"
    ],
    boolFlags: ["json", "enable", "disable", "clear-backend-config", "clear-pricing"]
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
        : `Cleared the effort override (back to the plugin default, ${DEFAULT_REVIEW_EFFORT}).`
    );
  }

  if (options.timeout != null) {
    const timeoutMs = normalizeTimeoutMs(options.timeout);
    setConfig(workspaceRoot, "timeoutMs", timeoutMs);
    actionsTaken.push(
      timeoutMs
        ? `Set the per-review codex timeout to ${Math.round(timeoutMs / 1000)}s (${timeoutMs} ms).`
        : `Cleared the timeout override (back to the plugin default, ${Math.round(
            DEFAULT_REVIEW_TIMEOUT_MS / 1000
          )}s).`
    );
  }

  if (options.backend != null) {
    const requested = String(options.backend).trim();
    if (!requested) {
      setConfig(workspaceRoot, "backend", DEFAULT_BACKEND_ID);
      actionsTaken.push(`Cleared the reviewer backend (back to the default, ${DEFAULT_BACKEND_ID}).`);
    } else if (!isKnownBackend(requested)) {
      throw new Error(
        `Unknown reviewer backend "${requested}". Known backends: ${BACKEND_IDS.join(", ")}.`
      );
    } else {
      setConfig(workspaceRoot, "backend", requested);
      actionsTaken.push(`Set the reviewer backend to ${requested}.`);
    }
  }

  if (options["clear-backend-config"]) {
    setConfig(workspaceRoot, "backendConfig", null);
    actionsTaken.push("Cleared the externalCommand backend config.");
  } else if (options["backend-config"] != null) {
    const parsed = parseJsonFlag(options["backend-config"]);
    if (parsed === null) {
      setConfig(workspaceRoot, "backendConfig", null);
      actionsTaken.push("Cleared the externalCommand backend config.");
    } else {
      const problems = validateExternalConfig(parsed);
      if (problems.length > 0) {
        throw new Error(`Invalid externalCommand config: ${problems.join("; ")}`);
      }
      setConfig(workspaceRoot, "backendConfig", parsed);
      actionsTaken.push(`Set the externalCommand backend config (command: ${parsed.command}).`);
    }
  }

  if (options.profile != null) {
    const requested = String(options.profile).trim();
    if (!requested) {
      setConfig(workspaceRoot, "profile", null);
      actionsTaken.push("Cleared the review profile (back to the per-kind default).");
    } else if (!REVIEW_PROFILES.includes(requested)) {
      throw new Error(
        `Unknown review profile "${requested}". Known profiles: ${REVIEW_PROFILES.join(", ")}.`
      );
    } else {
      setConfig(workspaceRoot, "profile", requested);
      actionsTaken.push(`Set the review profile to ${requested}.`);
    }
  }

  if (options["clear-pricing"]) {
    setConfig(workspaceRoot, "pricing", {});
    actionsTaken.push("Cleared all per-model pricing overrides.");
  } else if (options.pricing != null) {
    const parsed = parseJsonFlag(options.pricing);
    if (parsed === null) {
      setConfig(workspaceRoot, "pricing", {});
      actionsTaken.push("Cleared all per-model pricing overrides.");
    } else {
      /** @type {Record<string, object>} */
      const normalized = {};
      for (const [model, rate] of Object.entries(parsed)) {
        const normalizedRate = normalizeRateOverride(rate);
        if (!normalizedRate) {
          throw new Error(
            `Invalid pricing override for "${model}": expected {in, out[, cachedIn]} positive numbers.`
          );
        }
        normalized[model] = normalizedRate;
      }
      setConfig(workspaceRoot, "pricing", normalized);
      actionsTaken.push(
        `Set pricing overrides for: ${Object.keys(normalized).join(", ") || "(none)"} (table baseline: ${PRICING_AS_OF}).`
      );
    }
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

  const likelyStuck = isReviewLikelyStuck(review);

  if (options.json) {
    output({ review, workspaceRoot, likelyStuck }, true);
    return;
  }

  const lines = [];
  lines.push(`Last Codex ${review.kind} review (${review.id})`);
  lines.push(`  status:    ${review.status}${likelyStuck ? " (LIKELY STUCK)" : ""}`);
  lines.push(`  updated:   ${review.updatedAt}`);
  if (review.backend) {
    lines.push(`  backend:   ${review.backend}${review.degraded ? " (degraded result)" : ""}`);
  }
  if (review.verdict) {
    lines.push(`  verdict:   ${review.verdict}`);
  }
  const usage = review.result && review.result.usage ? review.result.usage : null;
  if (usage && (usage.tokensIn || usage.tokensOut)) {
    const cost =
      typeof usage.costUsd === "number"
        ? ` · ~$${usage.costUsd.toFixed(usage.costUsd < 0.01 ? 4 : 2)}`
        : usage.model
          ? ` · ~$? (${usage.model} not priced)`
          : " · ~$? (cost unknown)";
    lines.push(`  tokens:    ${usage.tokensIn ?? 0}/${usage.tokensOut ?? 0}${cost}`);
  }
  if (review.errorMessage) {
    lines.push(`  error:     ${review.errorMessage}`);
  }
  lines.push("");
  if (likelyStuck) {
    const staleMin = Math.round(STALE_RUNNING_MS / 60000);
    lines.push(
      `This review has been "${review.status}" for over ${staleMin} minutes — its background ` +
        "worker has most likely died without recording a result. It is not healthily in " +
        "progress. Re-run the action to dispatch a fresh review."
    );
  } else if (review.output) {
    lines.push("--- Codex output ---");
    lines.push(review.output);
  } else if (review.status === "queued" || review.status === "running") {
    lines.push("The review is still running in the background. Re-run /codex-autoreview:last shortly.");
  } else {
    lines.push("(no output captured)");
  }
  output(`${lines.join("\n")}\n`, false);
}

/**
 * Build the review prompt for a manual `run`. Mirrors what the auto hooks do
 * (`loadPromptTemplate` + `interpolateTemplate`) so a manual review uses the
 * SAME versioned prompt contract as an automatic one — no ad-hoc prompts.
 *
 * @param {"plan" | "code"} kind
 * @param {{ planText?: string, note?: string }} extras
 * @returns {string}
 */
function buildManualReviewPrompt(kind, extras = {}) {
  if (kind === "plan") {
    const template = loadPromptTemplate(ROOT_DIR, "auto-plan-review");
    return interpolateTemplate(template, {
      PLAN_BLOCK: String(extras.planText ?? "").trim() || "(no plan text supplied)",
      REVIEWED_INPUT_HASH: ""
    });
  }
  const template = loadPromptTemplate(ROOT_DIR, "auto-code-review");
  const note = String(extras.note ?? "").trim();
  return interpolateTemplate(template, {
    CLAUDE_RESPONSE_BLOCK: note
      ? ["Context supplied with the manual review request:", note].join("\n")
      : "",
    REVIEWED_INPUT_HASH: ""
  });
}

/**
 * `run` — dispatch a manual on-demand review, then POLL until it reaches a
 * terminal state and print the verdict.
 *
 * Division of labor (per the Codex consult on Wave 2B): the command `.md`
 * spawns a native Claude Agent-tool subagent that simply runs this subcommand;
 * THIS subcommand owns the review lifecycle — dispatch + poll + print — so the
 * Agent stays active for the review's duration and Claude shows native
 * subagent status, timing, and token accounting.
 *
 * @param {string[]} argv
 * @returns {Promise<void>}
 */
async function handleRun(argv) {
  const { options, positionals } = parseArgs(argv, {
    valueFlags: ["cwd", "kind", "plan", "note", "timeout-ms", "poll-ms"],
    boolFlags: ["json", "no-wait"]
  });

  const workspaceRoot = resolveCwd(options);
  const kindArg = (typeof options.kind === "string" && options.kind) || positionals[0] || "code";
  if (kindArg !== "plan" && kindArg !== "code") {
    throw new Error(`run: kind must be "plan" or "code", got "${kindArg}".`);
  }
  /** @type {"plan" | "code"} */
  const kind = kindArg;

  const config = getConfig(workspaceRoot);

  // codex availability is a hard precondition for a manual review.
  const availability = getCodexAvailability(workspaceRoot);
  if (!availability.available && config.backend !== "external") {
    const payload = {
      ran: false,
      reason: `Codex CLI is not available — ${availability.detail}`,
      workspaceRoot
    };
    output(
      options.json
        ? payload
        : `Cannot run a manual review: the Codex CLI is not available (${availability.detail}).\n` +
            "Install it with `npm install -g @openai/codex`.\n",
      Boolean(options.json)
    );
    process.exitCode = 1;
    return;
  }

  // For a code review, refuse cleanly when there is nothing to review.
  if (kind === "code") {
    const workingTree = getWorkingTreeState(workspaceRoot);
    if (!workingTree.isDirty) {
      const payload = { ran: false, reason: "no uncommitted changes to review", workspaceRoot };
      output(
        options.json
          ? payload
          : "Nothing to review: the working tree has no uncommitted changes.\n",
        Boolean(options.json)
      );
      return;
    }
  }

  const planText =
    typeof options.plan === "string" && options.plan ? options.plan : positionals.slice(1).join(" ");
  const prompt = buildManualReviewPrompt(kind, {
    planText,
    note: typeof options.note === "string" ? options.note : ""
  });

  const dispatch = dispatchBackgroundReview({
    cwd: workspaceRoot,
    kind,
    prompt,
    ...(kind === "plan" && planText ? { planText } : {}),
    config: {
      model: config.model,
      effort: config.effort,
      timeoutMs: config.timeoutMs,
      backend: config.backend,
      backendConfig: config.backendConfig
    }
  });

  if (!dispatch.dispatched || !dispatch.reviewId) {
    const payload = {
      ran: false,
      reason: dispatch.detail || "dispatch failed",
      workspaceRoot
    };
    output(
      options.json ? payload : `Manual review dispatch failed: ${payload.reason}\n`,
      Boolean(options.json)
    );
    process.exitCode = 1;
    return;
  }

  const reviewId = dispatch.reviewId;

  // --no-wait: dispatch and return immediately (the review still runs in the
  // background; the caller can poll /codex-autoreview:last).
  if (options["no-wait"]) {
    const payload = { ran: true, waited: false, reviewId, workspaceRoot };
    output(
      options.json
        ? payload
        : `Manual ${kind} review dispatched (${reviewId}). It is running in the background; ` +
            "run /codex-autoreview:last to see the verdict.\n",
      Boolean(options.json)
    );
    return;
  }

  // Poll until the review reaches a terminal state. The hard ceiling is the
  // review's own configured timeout plus generous slack — the worker self-heals
  // a genuine hang, so this loop is bounded even if a worker is wedged.
  const reviewTimeoutMs = resolveReviewTimeoutMs({ timeoutMs: config.timeoutMs });
  const flagCeiling =
    typeof options["timeout-ms"] === "string" && options["timeout-ms"]
      ? Number(options["timeout-ms"])
      : NaN;
  const waitCeilingMs = Number.isFinite(flagCeiling) && flagCeiling > 0
    ? flagCeiling
    : reviewTimeoutMs + 120_000;
  const pollMsRaw =
    typeof options["poll-ms"] === "string" && options["poll-ms"]
      ? Number(options["poll-ms"])
      : NaN;
  const pollMs = Number.isFinite(pollMsRaw) && pollMsRaw >= 250 ? pollMsRaw : 2_000;

  const deadline = Date.now() + waitCeilingMs;
  /** @type {import("./lib/state.mjs").ReviewRecord | null} */
  let review = null;
  while (Date.now() < deadline) {
    review = listReviews(workspaceRoot).find((entry) => entry.id === reviewId) ?? null;
    if (review && isTerminalStatus(review)) {
      break;
    }
    await sleep(pollMs);
  }

  if (!review || !isTerminalStatus(review)) {
    const payload = {
      ran: true,
      waited: true,
      reviewId,
      status: review ? review.status : "unknown",
      reason: "review did not reach a terminal state within the wait window",
      workspaceRoot
    };
    output(
      options.json
        ? payload
        : `The manual ${kind} review (${reviewId}) is still running after the wait window. ` +
            "It will finish in the background — run /codex-autoreview:last shortly.\n",
      Boolean(options.json)
    );
    return;
  }

  if (options.json) {
    output({ ran: true, waited: true, reviewId, review, workspaceRoot }, true);
    return;
  }

  const lines = [];
  lines.push(`Manual Codex ${review.kind} review (${review.id})`);
  lines.push(`  status:    ${review.status}`);
  if (review.backend) {
    lines.push(`  backend:   ${review.backend}${review.degraded ? " (degraded result)" : ""}`);
  }
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
  } else {
    lines.push("(no output captured)");
  }
  output(`${lines.join("\n")}\n`, false);
}

/**
 * `onboard` — re-entry point for the guided onboarding flow.
 *
 * With no flags it REPORTS the current onboarding state plus a checklist (the
 * command `.md` walks the user through it). `--complete` marks the project
 * onboarded once the user has finished setup; `--reset` is intentionally NOT
 * offered (re-onboarding is just re-running the steps; the marker is sticky).
 *
 * @param {string[]} argv
 */
function handleOnboard(argv) {
  const { options } = parseArgs(argv, {
    valueFlags: ["cwd"],
    boolFlags: ["json", "complete"]
  });
  const workspaceRoot = resolveCwd(options);

  if (options.complete) {
    markOnboarded(workspaceRoot);
  }

  const config = getConfig(workspaceRoot);
  const availability = getCodexAvailability(workspaceRoot);
  const onboardedAt = getOnboardedAt(workspaceRoot);
  const backend = isKnownBackend(config.backend) ? config.backend : DEFAULT_BACKEND_ID;

  // The onboarding checklist — each step plus whether it already looks done.
  const steps = [
    {
      id: "codex-installed",
      label: "Codex CLI installed & logged in",
      done: availability.available,
      detail: availability.available
        ? availability.detail
        : `not available — ${availability.detail}; install with \`npm install -g @openai/codex\` then \`codex login\``
    },
    {
      id: "enabled",
      label: "Automatic review enabled for this project",
      done: Boolean(config.enabled),
      detail: config.enabled
        ? "ON"
        : "OFF — enable with `/codex-autoreview:config --enable`"
    },
    {
      id: "model-effort",
      label: "Model / reasoning effort chosen (optional)",
      done: true,
      detail: `model=${config.model ?? "codex default"}, effort=${
        config.effort ?? DEFAULT_REVIEW_EFFORT
      } — adjust with \`/codex-autoreview:config --model <m> --effort <e>\``
    },
    {
      id: "statusline",
      label: "Statusline marker added (optional)",
      done: true,
      detail:
        'add a statusLine entry running `node "${CLAUDE_PLUGIN_ROOT}/scripts/statusline.mjs"` to see the ON marker and live review progress'
    },
    {
      id: "backend",
      label: "Reviewer backend / second reviewer (optional)",
      done: true,
      detail:
        backend === "external"
          ? `external — ${config.backendConfig ? "configured" : "externalCommand NOT set yet"}`
          : `${backend} (default codex path); a second reviewer is configured via \`--backend external --backend-config '<json>'\``
    }
  ];

  const payload = {
    workspaceRoot,
    onboarded: Boolean(onboardedAt),
    onboardedAt: onboardedAt ?? null,
    justCompleted: Boolean(options.complete),
    steps
  };

  if (options.json) {
    output(payload, true);
    return;
  }

  const lines = [];
  if (options.complete) {
    lines.push(`Onboarding marked complete for ${workspaceRoot} (${onboardedAt}).`);
    lines.push("Automatic review hooks are now active for this project.");
    lines.push("");
  }
  lines.push(`codex-autoreview onboarding — ${workspaceRoot}`);
  lines.push(
    `  state: ${
      onboardedAt ? `onboarded ${onboardedAt}` : "NOT onboarded — review hooks no-op until completed"
    }`
  );
  lines.push("");
  lines.push("Checklist:");
  for (const step of steps) {
    lines.push(`  [${step.done ? "x" : " "}] ${step.label}`);
    lines.push(`        ${step.detail}`);
  }
  lines.push("");
  if (!onboardedAt) {
    lines.push(
      "Once the required steps (Codex installed+logged in, review enabled) are done, run"
    );
    lines.push("`/codex-autoreview:onboard --complete` to finish onboarding.");
  } else {
    lines.push("Onboarding is already complete. Re-run any step above to reconfigure.");
  }
  output(`${lines.join("\n")}\n`, false);
}

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/codex-autoreview.mjs config [--enable|--disable] [--model <model>]",
      `    [--effort <${VALID_REASONING_EFFORTS.join("|")}>] [--timeout <ms>]`,
      `    [--backend <${BACKEND_IDS.join("|")}>] [--backend-config <json>] [--clear-backend-config]`,
      `    [--profile <${REVIEW_PROFILES.join("|")}>] [--pricing <json>] [--clear-pricing]`,
      "    [--cwd <dir>] [--json]",
      `    (effort defaults to ${DEFAULT_REVIEW_EFFORT}; timeout defaults to ` +
        `${Math.round(DEFAULT_REVIEW_TIMEOUT_MS / 1000)}s — both independent of ~/.codex/config.toml)`,
      "  node scripts/codex-autoreview.mjs last [plan|code] [--kind <plan|code>] [--cwd <dir>] [--json]",
      "  node scripts/codex-autoreview.mjs run [plan|code] [--plan <text>] [--note <text>]",
      "    [--no-wait] [--timeout-ms <ms>] [--poll-ms <ms>] [--cwd <dir>] [--json]",
      "  node scripts/codex-autoreview.mjs onboard [--complete] [--cwd <dir>] [--json]",
      "  node scripts/codex-autoreview.mjs doctor [--cwd <dir>] [--json]"
    ].join("\n")
  );
}

/**
 * @returns {Promise<void>}
 */
async function main() {
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
    case "run":
      await handleRun(argv);
      break;
    case "onboard":
      handleOnboard(argv);
      break;
    case "doctor": {
      // `doctor` lives in its own script; delegate so the command surface is
      // unified under one CLI entry point.
      const { spawnSync } = await import("node:child_process");
      const doctorScript = path.join(SCRIPT_DIR, "doctor.mjs");
      const result = spawnSync(process.execPath, [doctorScript, ...argv], {
        stdio: "inherit"
      });
      process.exitCode = result.status ?? 0;
      break;
    }
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
