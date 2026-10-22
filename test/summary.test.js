import { test } from "node:test";
import assert from "node:assert/strict";
import { formatSummary } from "../src/summary.js";

const base = { dryRun: false, created: [], undecided: [], variesLeftAlone: [], leftForUserRules: 0, seedProblems: [] };
const rec = (o = {}) => ({ payee: "Blue Bottle", category: "Coffee", reason: "coffee shop", source: "model", ruleId: "r1", txnCount: 2, ...o });

test("nothing to report gives an empty array", () => {
  assert.deepEqual(formatSummary(base), []);
  assert.deepEqual(formatSummary({ ...base, dryRun: true }), []);
});

test("live run wording and bullets", () => {
  const out = formatSummary({
    ...base,
    created: [
      rec(),
      rec({ payee: "Metro Transit Card", category: "Transit", reason: "from rules.yaml", source: "seed", txnCount: 4 }),
      rec({ payee: "Target", category: "Misc", reason: "general store", source: "mixed", txnCount: 3 }),
    ],
  });
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].split("\n"), [
    "Budget: 3 new rules, 9 transactions categorized",
    "• Blue Bottle → Coffee: coffee shop (2)",
    "• Metro Transit Card → Transit: from rules.yaml (4)",
    "• Target → Misc: varies, general store (3)",
    "Fix a rule in Actual → Rules.",
  ]);
});

test("singular rule wording", () => {
  const [m] = formatSummary({ ...base, created: [rec({ txnCount: 1 })] });
  assert.match(m.split("\n")[0], /^Budget: 1 new rule, 1 transaction categorized$/);
});

test("dry run wording", () => {
  const [m] = formatSummary({ ...base, dryRun: true, created: [rec(), rec({ payee: "Target" })] });
  const lines = m.split("\n");
  assert.equal(lines[0], "DRY RUN: Budget: would create 2 new rules, would categorize 4 transactions");
  assert.ok(lines.at(-1).startsWith("Fix a rule"));
});

test("sections appear only when non-empty", () => {
  const [m] = formatSummary({
    ...base,
    undecided: [{ payee: "Oak Street Property Mgmt", error: "model reply invalid" }],
    variesLeftAlone: [{ payee: "Amazon", reason: "everything" }],
    leftForUserRules: 5,
    seedProblems: ["rules.yaml: unknown category Foo"],
  });
  const lines = m.split("\n");
  assert.equal(lines[0], "Budget: 0 new rules, 0 transactions categorized");
  assert.ok(lines.includes("Not decided: 1: Oak Street Property Mgmt (model reply invalid)"));
  assert.ok(lines.includes("Varies, left alone: Amazon"));
  assert.ok(lines.includes("Left for your rules: 5 transactions"));
  assert.ok(lines.includes("Seed problem: rules.yaml: unknown category Foo"));
  assert.ok(!m.includes("Fix a rule"));
  const [only] = formatSummary({ ...base, created: [rec()] });
  assert.ok(!/Not decided|Varies|Left for|Seed/.test(only));
});

test("many rules split into messages within the limit", () => {
  const created = Array.from({ length: 150 }, (_, i) => rec({ payee: `Merchant ${i}`, reason: "x".repeat(40) }));
  const out = formatSummary({ ...base, created });
  assert.ok(out.length > 1);
  for (const m of out) assert.ok(m.length <= 4096);
  const all = out.join("\n");
  for (let i = 0; i < 150; i++) assert.equal(all.split(`• Merchant ${i} →`).length - 1, 1);
  assert.ok(out[0].startsWith("Budget: 150 new rules"));
});

test("an overlong single line is hard-split, not dropped", () => {
  const names = Array.from({ length: 800 }, (_, i) => `Payee${i}`);
  const out = formatSummary({ ...base, variesLeftAlone: names.map((payee) => ({ payee, reason: "r" })) });
  for (const m of out) assert.ok(m.length <= 4096);
  assert.ok(out.join("").includes("Payee799"));
});

test("error with nothing done gives a single line", () => {
  assert.deepEqual(formatSummary({ ...base, error: "Actual unreachable" }), ["Budget autocat failed: Actual unreachable"]);
});

test("error after some work: failure line first, then the normal report", () => {
  const [m] = formatSummary({
    ...base,
    error: "model unreachable: model request failed: HTTP 503",
    created: [rec()],
    undecided: [{ payee: "Target", error: "model request failed: HTTP 503" }],
  });
  assert.deepEqual(m.split("\n"), [
    "Budget autocat failed: model unreachable: model request failed: HTTP 503",
    "Budget: 1 new rule, 2 transactions categorized",
    "• Blue Bottle → Coffee: coffee shop (2)",
    "Not decided: 1: Target (model request failed: HTTP 503)",
    "Fix a rule in Actual → Rules.",
  ]);
});
