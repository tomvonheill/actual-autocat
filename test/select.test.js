import { test } from "node:test";
import assert from "node:assert/strict";
import { ruleCoversPayee, selectWork, buildCategoryRule, typicalAmount } from "../src/select.js";

const catAction = { op: "set", field: "category", value: "c1" };
const rule = (conditions, actions = [catAction]) => ({ id: "r", stage: null, conditionsOp: "and", conditions, actions });

test("payee is rule covers", () => {
  assert.equal(ruleCoversPayee(rule([{ op: "is", field: "payee", value: "p1" }]), "p1"), true);
  assert.equal(ruleCoversPayee(rule([{ op: "is", field: "payee", value: "p2" }]), "p1"), false);
});

test("oneOf rule covers", () => {
  assert.equal(ruleCoversPayee(rule([{ op: "oneOf", field: "payee", value: ["p0", "p1"] }]), "p1"), true);
  assert.equal(ruleCoversPayee(rule([{ op: "oneOf", field: "payee", value: ["p0"] }]), "p1"), false);
});

test("rule with extra conditions still covers", () => {
  const r = rule([
    { op: "is", field: "payee", value: "p1" },
    { op: "gt", field: "amount", value: 1000 },
  ]);
  assert.equal(ruleCoversPayee(r, "p1"), true);
});

test("rename-only rule does not cover", () => {
  const r = rule([{ op: "is", field: "payee", value: "p1" }], [{ op: "set", field: "payee", value: "p9" }]);
  assert.equal(ruleCoversPayee(r, "p1"), false);
});

const tx = (id, payeeId, amount = -500) => ({ id, payeeId, notes: null, amount, date: "2026-01-01", accountId: "a" });
const payees = [
  { id: "p1", name: "Corner Deli" },
  { id: "p2", name: "Acme Hardware" },
  { id: "p3", name: "Zed Cafe" },
  { id: "p4", name: "Bay Books" },
];
const opts = { skipPayees: null, maxPayees: 0, knownVaries: new Set() };
const data = (transactions, rules = []) => ({ categories: [], payees, rules, transactions });

test("orders by txn count desc then name; drops txns without payee", () => {
  const d = data([tx("1", "p1"), tx("2", "p3"), tx("3", "p3"), tx("4", "p2"), tx("5", null)]);
  const { work } = selectWork(d, opts);
  assert.deepEqual(work.map((w) => [w.payee.name, w.txns.length]), [["Zed Cafe", 2], ["Acme Hardware", 1], ["Corner Deli", 1]]);
});

test("skipPayees regex drops and counts skipped payees", () => {
  const d = data([tx("1", "p1"), tx("2", "p2"), tx("3", "p2")]);
  const r = selectWork(d, { ...opts, skipPayees: /^acme/i });
  assert.deepEqual(r.work.map((w) => w.payee.id), ["p1"]);
  assert.equal(r.skipped, 1);
});

test("maxPayees truncates when > 0", () => {
  const d = data([tx("1", "p1"), tx("2", "p2"), tx("3", "p3")]);
  assert.equal(selectWork(d, { ...opts, maxPayees: 2 }).work.length, 2);
  assert.equal(selectWork(d, opts).work.length, 3);
});

test("covered payees are left for user rules, counting txns", () => {
  const d = data([tx("1", "p1"), tx("2", "p1"), tx("3", "p2")], [rule([{ op: "is", field: "payee", value: "p1" }])]);
  const r = selectWork(d, opts);
  assert.deepEqual(r.work.map((w) => w.payee.id), ["p2"]);
  assert.equal(r.leftForUserRules, 2);
});

test("knownVaries payees are excluded", () => {
  const d = data([tx("1", "p1"), tx("2", "p2")]);
  const r = selectWork(d, { ...opts, knownVaries: new Set(["p1"]) });
  assert.deepEqual(r.work.map((w) => w.payee.id), ["p2"]);
});

test("typicalAmount treats a refund among purchases as an expense", () => {
  assert.deepEqual(typicalAmount([tx("1", "p", -1000), tx("2", "p", -3000), tx("3", "p", 500), tx("4", "p", -2000)]), { cents: 2000, isIncome: false });
});

test("typicalAmount detects income and averages even medians", () => {
  assert.deepEqual(typicalAmount([tx("1", "p", 1000), tx("2", "p", 2001), tx("3", "p", -5)]), { cents: 1501, isIncome: true });
});

test("buildCategoryRule exact shape", () => {
  assert.deepEqual(buildCategoryRule("p1", "c1"), {
    stage: null,
    conditionsOp: "and",
    conditions: [{ op: "is", field: "payee", value: "p1" }],
    actions: [{ op: "set", field: "category", value: "c1" }],
  });
});
