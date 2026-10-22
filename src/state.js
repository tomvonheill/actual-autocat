/**
 * Persistent run state (state.json) and the append-only audit log of created rules.
 */
import { appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";

/**
 * @param {string} path
 * @returns {{seeded: string[], varies: string[]}} seeded = lower-case payee names, varies = payee ids
 */
export function loadState(path) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return { seeded: [], varies: [] };
    throw err;
  }
  return {
    seeded: Array.isArray(raw?.seeded) ? raw.seeded : [],
    varies: Array.isArray(raw?.varies) ? raw.varies : [],
  };
}

/**
 * Writes via a temp file and rename so a crash never leaves a half-written file.
 * @param {string} path
 * @param {{seeded: string[], varies: string[]}} state
 */
export function saveState(path, state) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  renameSync(tmp, path);
}

/**
 * Appends one JSON line.
 * @param {string} path
 * @param {object} entry RuleRecord plus `at` (ISO timestamp)
 */
export function appendLog(path, entry) {
  appendFileSync(path, JSON.stringify(entry) + "\n");
}
