import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSeeds, resolveSeeds } from "../src/seeds.js";
import { ConfigError } from "../src/config.js";

test("parseSeeds reads a flat map", () => {
  assert.deepEqual(parseSeeds("Blue Bottle: Coffee\nTarget: Shopping\n"), [
    { payeeName: "Blue Bottle", categoryName: "Coffee" },
    { payeeName: "Target", categoryName: "Shopping" },
  ]);
});

test("parseSeeds treats empty text as no seeds", () => {
  assert.deepEqual(parseSeeds(""), []);
});

test("parseSeeds rejects nested maps, lists, non-strings and bad yaml", () => {
  for (const text of ["Target:\n  a: b\n", "- a\n- b\n", "Target: 5\n", "a: [unclosed\n"]) {
    assert.throws(() => parseSeeds(text), ConfigError, text);
  }
});

const data = {
  categories: [
    { id: "c1", name: "Coffee", groupName: "Food", isIncome: false, hidden: false },
    { id: "c2", name: "Old", groupName: "Food", isIncome: false, hidden: true },
  ],
  payees: [
    { id: "p1", name: "Blue Bottle" },
    { id: "p2", name: "Target" },
  ],
  rules: [],
  transactions: [
    { id: "t1", payeeId: "p1", notes: "", amount: -500, date: "2026-10-01", accountId: "a" },
    { id: "t2", payeeId: "p2", notes: "", amount: -900, date: "2026-10-02", accountId: "a" },
    { id: "t3", payeeId: "p1", notes: "", amount: -450, date: "2026-10-03", accountId: "a" },
  ],
};
const empty = { seeded: [], varies: [] };

test("creates for a known payee with its uncategorized txns", () => {
  const r = resolveSeeds([{ payeeName: "Blue Bottle", categoryName: "Coffee" }], data, empty);
  assert.deepEqual(r.problems, []);
  assert.equal(r.toCreate.length, 1);
  assert.equal(r.toCreate[0].payee.id, "p1");
  assert.equal(r.toCreate[0].category.id, "c1");
  assert.deepEqual(r.toCreate[0].txns.map((t) => t.id), ["t1", "t3"]);
});

test("names match case-insensitively", () => {
  const r = resolveSeeds([{ payeeName: "BLUE bottle", categoryName: "coffee" }], data, empty);
  assert.equal(r.toCreate.length, 1);
});

test("skips seeds already created", () => {
  const r = resolveSeeds([{ payeeName: "Blue Bottle", categoryName: "Coffee" }], data, { seeded: ["blue bottle"], varies: [] });
  assert.deepEqual(r, { toCreate: [], problems: [] });
});

test("skips payees already covered by a rule", () => {
  const rule = { id: "r", conditions: [{ op: "is", field: "payee", value: "p1" }], actions: [{ op: "set", field: "category", value: "c2" }] };
  const r = resolveSeeds([{ payeeName: "Blue Bottle", categoryName: "Coffee" }], { ...data, rules: [rule] }, empty);
  assert.deepEqual(r, { toCreate: [], problems: [] });
});

test("reports unknown and hidden categories", () => {
  const r = resolveSeeds(
    [
      { payeeName: "Blue Bottle", categoryName: "Nope" },
      { payeeName: "Target", categoryName: "Old" },
    ],
    data,
    empty,
  );
  assert.deepEqual(r.toCreate, []);
  assert.equal(r.problems.length, 2);
  assert.match(r.problems[0], /^rules\.yaml: no category named Nope/);
  assert.match(r.problems[1], /^rules\.yaml: no category named Old/);
});

test("unknown payee waits silently", () => {
  const r = resolveSeeds([{ payeeName: "Not Yet", categoryName: "Coffee" }], data, empty);
  assert.deepEqual(r, { toCreate: [], problems: [] });
});

test("a payee listed twice (any case) is used once and reported", () => {
  const r = resolveSeeds(
    [
      { payeeName: "Blue Bottle", categoryName: "Coffee" },
      { payeeName: "blue bottle", categoryName: "Nope" },
    ],
    data,
    empty,
  );
  assert.equal(r.toCreate.length, 1);
  assert.equal(r.toCreate[0].category.id, "c1");
  assert.deepEqual(r.problems, ["rules.yaml: blue bottle is listed twice (names are matched ignoring case); only the first entry is used"]);
});
