import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadState, saveState, appendLog } from "../src/state.js";

const tmp = () => mkdtempSync(join(tmpdir(), "autocat-state-"));

test("missing state file gives empty state", () => {
  assert.deepEqual(loadState(join(tmp(), "state.json")), { seeded: [], varies: [] });
});

test("state round-trips and leaves no temp file", () => {
  const dir = tmp();
  const path = join(dir, "state.json");
  const state = { seeded: ["blue bottle"], varies: ["p1", "p2"] };
  saveState(path, state);
  assert.deepEqual(loadState(path), state);
  assert.deepEqual(readdirSync(dir), ["state.json"]);
});

test("partial state file is filled with defaults", () => {
  const dir = tmp();
  const path = join(dir, "state.json");
  saveState(path, { varies: ["p1"] });
  assert.deepEqual(loadState(path), { seeded: [], varies: ["p1"] });
});

test("appendLog writes one JSON line per call", () => {
  const path = join(tmp(), "rules-created.jsonl");
  appendLog(path, { payee: "Target", ruleId: "r1", at: "2026-10-22T00:00:00Z" });
  appendLog(path, { payee: "Blue Bottle", ruleId: "r2", at: "2026-10-22T00:00:01Z" });
  const lines = readFileSync(path, "utf8").split("\n");
  assert.equal(lines.length, 3);
  assert.equal(lines[2], "");
  assert.equal(JSON.parse(lines[0]).payee, "Target");
  assert.equal(JSON.parse(lines[1]).ruleId, "r2");
});
