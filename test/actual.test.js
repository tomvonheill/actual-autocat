import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createActual } from "../src/actual.js";

/** Minimal stand-in for the package's `q` query builder: records the table, filter and select. */
function fakeQ(table) {
  const state = { table };
  const query = {
    state,
    filter(f) { state.filter = f; return query; },
    select(s) { state.select = s; return query; },
  };
  return query;
}

function fakeApi(overrides = {}) {
  const calls = [];
  // Current server-side state of transactions, as aqlQuery sees it (by id).
  const current = {
    t1: { category: null, notes: "latte" },
    t2: { category: null, notes: "x #autocat" },
    t3: { category: null, notes: null },
    t4: { category: null, notes: "keep" },
  };
  const api = {
    calls,
    current,
    q: fakeQ,
    aqlQuery: async (query) => {
      calls.push(["query", query.state]);
      const row = current[query.state.filter?.id];
      return { data: row ? [{ ...row }] : [] };
    },
    init: async (c) => calls.push(["init", c]),
    downloadBudget: async (id, o) => calls.push(["download", id, o]),
    runBankSync: async () => calls.push(["bank"]),
    sync: async () => calls.push(["sync"]),
    shutdown: async () => calls.push(["shutdown"]),
    getCategoryGroups: async () => [
      { id: "g1", name: "Food", is_income: false, hidden: false, categories: [
        { id: "c1", name: "Coffee", is_income: false, hidden: false, group_id: "g1" },
        { id: "c2", name: "Old", is_income: false, hidden: true, group_id: "g1" },
      ] },
      { id: "g2", name: "Income", is_income: true, hidden: false, categories: [
        { id: "c3", name: "Pay", is_income: true, hidden: false, group_id: "g2" },
      ] },
    ],
    getPayees: async () => [{ id: "p1", name: "Blue Bottle", transfer_acct: null }],
    getRules: async () => [{ id: "r1", stage: null }],
    getAccounts: async () => [
      { id: "a1", name: "Checking" },
      { id: "a2", name: "Brokerage", offbudget: true },
      { id: "a3", name: "Old", closed: true },
    ],
    getTransactions: async (id, start, end) => {
      calls.push(["txns", id, start, end]);
      return [
        { id: "t1", account: "a1", payee: "p1", amount: -450, date: "2026-01-02", notes: "latte" },
        { id: "t2", account: "a1", payee: "p1", amount: -1, date: "2026-01-03", category: "c1" },
        { id: "t3", account: "a1", amount: -1, date: "2026-01-03", transfer_id: "x" },
        { id: "t4", account: "a1", amount: 1, date: "2026-01-03", starting_balance_flag: true },
        { id: "t5", account: "a1", amount: -1, date: "2026-01-03", is_parent: true },
      ];
    },
    createRule: async () => ({ id: "r9" }),
    updateTransaction: async (id, f) => calls.push(["update", id, f]),
    ...overrides,
  };
  return api;
}

const cfg = () => ({
  actualServerUrl: "http://x",
  actualPassword: "pw",
  actualBudgetId: "b1",
  actualEncryptionPassword: "",
  dataDir: mkdtempSync(join(tmpdir(), "autocat-actual-")),
});

test("load flattens categories and keeps only uncategorized plain txns of open on-budget accounts", async () => {
  const api = fakeApi();
  const actual = createActual(cfg(), { api, now: () => new Date("2026-06-01T00:00:00Z") });
  const data = await actual.load();
  assert.deepEqual(data.categories, [
    { id: "c1", name: "Coffee", groupName: "Food", isIncome: false, hidden: false },
    { id: "c2", name: "Old", groupName: "Food", isIncome: false, hidden: true },
    { id: "c3", name: "Pay", groupName: "Income", isIncome: true, hidden: false },
  ]);
  assert.deepEqual(data.payees, [{ id: "p1", name: "Blue Bottle" }]);
  assert.deepEqual(data.rules, [{ id: "r1", stage: null }]);
  assert.deepEqual(data.transactions, [
    { id: "t1", payeeId: "p1", notes: "latte", amount: -450, date: "2026-01-02", accountId: "a1" },
  ]);
  assert.deepEqual(api.calls.filter((c) => c[0] === "txns"), [["txns", "a1", "1970-01-01", "2027-06-01"]]);
});

test("categorize appends the notes tag once", async () => {
  const api = fakeApi();
  const actual = createActual(cfg(), { api });
  assert.equal(await actual.categorize({ id: "t1", notes: "latte" }, "c1", "#autocat"), true);
  assert.equal(await actual.categorize({ id: "t2", notes: "x #autocat" }, "c1", "#autocat"), true);
  assert.equal(await actual.categorize({ id: "t3", notes: "" }, "c1", "#autocat"), true);
  assert.equal(await actual.categorize({ id: "t4", notes: "keep" }, "c1", ""), true);
  assert.deepEqual(api.calls.find((c) => c[0] === "query")[1], {
    table: "transactions",
    filter: { id: "t1" },
    select: ["category", "notes"],
  });
  assert.deepEqual(api.calls.filter((c) => c[0] === "update").map((c) => c[2]), [
    { category: "c1", notes: "latte #autocat" },
    { category: "c1", notes: "x #autocat" },
    { category: "c1", notes: "#autocat" },
    { category: "c1", notes: "keep" },
  ]);
});

test("categorize re-reads the transaction: skips one categorized meanwhile, uses its current notes", async () => {
  const api = fakeApi();
  api.current.t1 = { category: "c-user", notes: "latte" };
  api.current.t2 = { category: null, notes: "edited by you" };
  const actual = createActual(cfg(), { api });
  assert.equal(await actual.categorize({ id: "t1", notes: "latte" }, "c1", "#autocat"), false);
  assert.equal(await actual.categorize({ id: "t2", notes: "old notes" }, "c1", "#autocat"), true);
  assert.equal(await actual.categorize({ id: "gone", notes: "" }, "c1", "#autocat"), false);
  assert.deepEqual(api.calls.filter((c) => c[0] === "update"), [
    ["update", "t2", { category: "c1", notes: "edited by you #autocat" }],
  ]);
});

test("sync({bank: false}) syncs with the server but skips bank sync; rules() re-reads rules", async () => {
  const api = fakeApi();
  const actual = createActual(cfg(), { api });
  await actual.sync({ bank: false });
  assert.deepEqual(api.calls.map((c) => c[0]), ["sync"]);
  await actual.sync();
  assert.deepEqual(api.calls.map((c) => c[0]), ["sync", "bank", "sync"]);
  assert.deepEqual(await actual.rules(), [{ id: "r1", stage: null }]);
});

test("sync continues when bank sync throws, and open passes the encryption password", async () => {
  const warnings = [];
  const api = fakeApi({ runBankSync: async () => { throw new Error("no bank"); } });
  const c = { ...cfg(), actualEncryptionPassword: "enc" };
  const actual = createActual(c, { api, logger: { warn: (m) => warnings.push(m), error() {} } });
  await actual.open();
  await actual.sync();
  assert.equal(warnings.length, 1);
  assert.ok(!warnings[0].includes("pw"));
  assert.deepEqual(api.calls.find((x) => x[0] === "download"), ["download", "b1", { password: "enc" }]);
  assert.ok(api.calls.some((x) => x[0] === "sync"));
  assert.equal(await actual.createRule({}), "r9");
});

function recordingLogger() {
  const lines = { info: [], error: [] };
  return { lines, debug() {}, warn() {}, info: (m) => lines.info.push(m), error: (m) => lines.error.push(m) };
}

test("open retries while the server is not reachable yet, then succeeds", async () => {
  let attempts = 0;
  const api = fakeApi({
    init: async (c) => {
      api.calls.push(["init", c]);
      if (++attempts <= 2) throw new Error("Authentication failed: network-failure");
    },
  });
  const logger = recordingLogger();
  const sleeps = [];
  const actual = createActual(cfg(), { api, logger, sleep: async (ms) => sleeps.push(ms) });
  await actual.open();
  assert.deepEqual(sleeps, [2000, 4000]);
  assert.deepEqual(logger.lines.info, [
    "Actual not reachable yet, retrying in 2s",
    "Actual not reachable yet, retrying in 4s",
  ]);
  assert.deepEqual(logger.lines.error, []);
  assert.equal(api.calls.filter((c) => c[0] === "init").length, 3);
  assert.equal(api.calls.filter((c) => c[0] === "download").length, 1);
});

test("open shuts the api down between attempts when init succeeded but the download failed", async () => {
  let downloads = 0;
  const api = fakeApi({
    downloadBudget: async () => {
      api.calls.push(["download"]);
      if (++downloads === 1) throw new Error("fetch failed");
    },
  });
  const actual = createActual(cfg(), { api, logger: recordingLogger(), sleep: async () => {} });
  await actual.open();
  assert.deepEqual(api.calls.map((c) => c[0]), ["init", "download", "shutdown", "init", "download"]);
});

test("open does not retry other errors such as a wrong password", async () => {
  const api = fakeApi({
    init: async () => {
      throw new Error("Authentication failed: invalid-password");
    },
  });
  const logger = recordingLogger();
  const sleeps = [];
  const actual = createActual(cfg(), { api, logger, sleep: async (ms) => sleeps.push(ms) });
  await assert.rejects(actual.open(), /invalid-password/);
  assert.deepEqual(sleeps, []);
  assert.deepEqual(logger.lines.info, []);
  assert.equal(logger.lines.error.length, 1);
});

test("open gives up after the last backoff with the original message", async () => {
  let attempts = 0;
  const api = fakeApi({
    init: async () => {
      attempts++;
      throw new Error("Authentication failed: network-failure");
    },
  });
  const logger = recordingLogger();
  const sleeps = [];
  const actual = createActual(cfg(), { api, logger, sleep: async (ms) => sleeps.push(ms) });
  await assert.rejects(actual.open(), /Authentication failed: network-failure/);
  assert.deepEqual(sleeps, [2000, 4000, 8000, 16000, 30000, 30000]);
  assert.equal(attempts, 7);
  assert.equal(logger.lines.info.length, 6);
  assert.equal(logger.lines.error.length, 1);
});
