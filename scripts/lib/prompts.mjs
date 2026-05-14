/**
 * Prompt-template loading and interpolation.
 *
 * Vendored from codex-plugin-cc (plugins/codex/scripts/lib/prompts.mjs),
 * Copyright 2026 OpenAI, licensed under the Apache License, Version 2.0.
 * See ../../NOTICE.
 *
 * @file
 */

import fs from "node:fs";
import path from "node:path";

/**
 * Load a prompt template from `<rootDir>/prompts/<name>.md`.
 *
 * @param {string} rootDir - Plugin root directory.
 * @param {string} name - Template basename without extension.
 * @returns {string}
 */
export function loadPromptTemplate(rootDir, name) {
  const promptPath = path.join(rootDir, "prompts", `${name}.md`);
  return fs.readFileSync(promptPath, "utf8");
}

/**
 * Replace `{{UPPER_SNAKE}}` placeholders in `template` with `variables` values.
 *
 * @param {string} template
 * @param {Record<string, string>} variables
 * @returns {string}
 */
export function interpolateTemplate(template, variables) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
    return Object.prototype.hasOwnProperty.call(variables, key) ? variables[key] : "";
  });
}
