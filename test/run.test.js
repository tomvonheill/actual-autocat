import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOnce } from "../src/run.js";
import { LlmError } from "../src/llm/index.js";
import { buildCategoryRule } from "../src/select.js";
import { loadState } from "../src/state.js";

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const cats = [
  { id: "c-coffee", name: "Coffee", groupName: "Food", isIncome: false, hidden: false },
  { id: "c-misc", name: "Miscellaneous", groupName: "Other", isIncome: false, hidden: false },
  { id: "c-transit", name: "Transit", groupName: "Bills", isIncome: false, hidden: false },
  { id: "c-pay", name: "Paycheck", groupName: "Income", isIncome: true, hidden: false },
];
const payees = [
  { id: "p-bb", name: "Blue Bottle" },
  { id: "p-tg", name: "Target" },
  { id: "p-vn", name: "Metro Transit Card" },
];
const tx = (id, payeeId, o = {}) => ({ id, payeeId, notes: `RAW ${id}`, amount: -500, date: "2026-10-01", accountId: "a1", ...o });

function setup(over = {}) {
  const dir = mkdtempSync(join(tmpdir(), "run-"));
  const data = {
    categories: cats,
    payees,
    rules: [],
    transactions: [tx("t1", "p-bb", { date: "2026-10-01" }), tx("t2", "p-bb", { date: "2026-10-03", notes: "LATEST" }), tx("t3", "p-bb", { date: "2026-10-02" })],
    ...over.data,
  };
  const calls = { open: 0, syncs: [], ruleReads: 0, close: 0, rules: [], cat: [], prompts: [], sent: [], lookups: [] };
  const actual = {
    async open() { calls.open++; if (over.openError) throw new Error(over.openError); },
    async sync(opts) { calls.syncs.push(opts); },
    async load() { return data; },
    async rules() { calls.ruleReads++; return over.liveRules ? over.liveRules(calls.ruleReads) : data.rules; },
    async createRule(r) { calls.rules.push(r); return `rule${calls.rules.length}`; },
    async categorize(t, c, tag) { calls.cat.push([t.id, c, tag]); return over.written ? over.written(t) : true; },
    async close() { calls.close++; },
  };
  const llm = {
    async complete(prompt, schema, opts) {
      calls.prompts.push({ prompt, schema, opts });
      const r = (over.reply ?? (() => '{"category":"c-coffee","reason":"coffee shop"}'))(prompt, calls.prompts.length);
      if (r instanceof Error) throw r;
      return r;
    },
  };
  const search = { async lookup(q) { calls.lookups.push(q); return over.snippets ?? ["- Blue Bottle: coffee"]; } };
  const notify = { enabled: true, async send(m) { calls.sent.push(m); } };
  const config = { dryRun: false, syncBeforeRun: true, skipPayees: null, maxPayeesPerRun: 0, mixedPayeeCategory: "", notesTag: "#autocat", logLevel: "info", ...over.config };
  const statePath = join(dir, "state.json");
  const logPath = join(dir, "rules-created.jsonl");
  const run = (st) =>
    runOnce({ config, actual, llm, search, notify, guidance: "", seeds: over.seeds ?? [], state: st ?? { seeded: [], varies: [] }, statePath, logPath, log: over.log ?? silent, signal: over.signal });
  return { run, calls, statePath, logPath, data };
}

test("dry run creates no rules and no categorizations, summary says DRY RUN", async () => {
  const s = setup({ config: { dryRun: true } });
  const r = await s.run();
  assert.equal(r.dryRun, true);
  assert.equal(r.created.length, 1);
  assert.equal(s.calls.rules.length, 0);
  assert.equal(s.calls.cat.length, 0);
  assert.equal(existsSync(s.logPath), false);
  assert.equal(existsSync(s.statePath), false);
  assert.match(s.calls.sent[0][0], /^DRY RUN/);
});

test("dry run skips bank sync (it writes to the budget) but still syncs with the server, and says so", async () => {
  const infos = [];
  const s = setup({ config: { dryRun: true }, log: { ...silent, info: (m) => infos.push(m) } });
  await s.run();
  assert.deepEqual(s.calls.syncs, [{ bank: false }]);
  assert.equal(s.calls.ruleReads, 0);
  assert.ok(infos.some((m) => /bank sync skipped/i.test(m)), infos.join("\n"));
});

test("live: one payee with 3 txns gives one rule, 3 categorizations with the tag, one log line", async () => {
  const s = setup();
  const r = await s.run();
  assert.deepEqual(s.calls.rules, [buildCategoryRule("p-bb", "c-coffee")]);
  assert.deepEqual(s.calls.cat.map((c) => c[0]).sort(), ["t1", "t2", "t3"]);
  assert.ok(s.calls.cat.every((c) => c[1] === "c-coffee" && c[2] === "#autocat"));
  const lines = readFileSync(s.logPath, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  const e = JSON.parse(lines[0]);
  assert.equal(e.payee, "Blue Bottle");
  assert.equal(e.category, "Coffee");
  assert.equal(e.ruleId, "rule1");
  assert.equal(e.txnCount, 3);
  assert.ok(e.at);
  assert.equal(r.created[0].source, "model");
  assert.equal(s.calls.close, 1);
});

test("query uses the most recent notes; schema only offers eligible categories", async () => {
  const s = setup();
  await s.run();
  assert.equal(s.calls.lookups.length, 1);
  assert.match(s.calls.lookups[0], /LATEST/i);
  const ids = s.calls.prompts[0].schema.properties.category.enum;
  assert.deepEqual(ids, ["c-coffee", "c-misc", "c-transit", "varies"]);
  assert.match(s.calls.prompts[0].prompt, /Bank text: LATEST\n\* Bank text: RAW t3/);
});

test("seeds are applied before the model and never sent to it", async () => {
  const s = setup({
    data: { transactions: [tx("t1", "p-bb"), tx("v1", "p-vn", { date: "2026-10-02" }), tx("v2", "p-vn")] },
    seeds: [{ payeeName: "metro transit card", categoryName: "transit" }],
  });
  const state = { seeded: [], varies: [] };
  const r = await s.run(state);
  assert.equal(s.calls.prompts.length, 1);
  assert.ok(!s.calls.prompts[0].prompt.includes("Metro Transit Card"));
  const seed = r.created.find((c) => c.source === "seed");
  assert.equal(seed.reason, "from rules.yaml");
  assert.equal(seed.category, "Transit");
  assert.equal(seed.txnCount, 2);
  assert.deepEqual(s.calls.rules[0], buildCategoryRule("p-vn", "c-transit"));
  assert.deepEqual(loadState(s.statePath).seeded, ["metro transit card"]);
  assert.equal(readFileSync(s.logPath, "utf8").trim().split("\n").length, 2);
});

test("varies with MIXED_PAYEE_CATEGORY=Miscellaneous creates a rule to Miscellaneous", async () => {
  const s = setup({ config: { mixedPayeeCategory: "miscellaneous" }, reply: () => '{"category":"varies","reason":"general store"}' });
  const r = await s.run();
  assert.deepEqual(s.calls.rules, [buildCategoryRule("p-bb", "c-misc")]);
  assert.equal(r.created[0].source, "mixed");
  assert.equal(r.created[0].category, "Miscellaneous");
});

test("varies with MIXED_PAYEE_CATEGORY empty: no rule, saved in state.varies, not asked next run", async () => {
  const s = setup({ reply: () => '{"category":"varies","reason":"general store"}' });
  const r = await s.run();
  assert.equal(s.calls.rules.length, 0);
  assert.deepEqual(r.variesLeftAlone, [{ payee: "Blue Bottle", reason: "general store" }]);
  const state = loadState(s.statePath);
  assert.deepEqual(state.varies, ["p-bb"]);
  const s2 = setup();
  const r2 = await s2.run(state);
  assert.equal(s2.calls.prompts.length, 0);
  assert.equal(r2.created.length, 0);
  assert.equal(s2.calls.sent.length, 0);
});

test("invalid reply and LlmError give undecided and the run continues", async () => {
  const s = setup({
    data: { transactions: [tx("t1", "p-bb"), tx("t2", "p-bb"), tx("t3", "p-tg"), tx("t4", "p-tg"), tx("t5", "p-vn")] },
    reply: (_p, n) => (n === 1 ? "nonsense" : n === 2 ? new LlmError("boom") : '{"category":"c-transit","reason":"bus"}'),
  });
  const r = await s.run();
  assert.equal(r.undecided.length, 2);
  assert.equal(r.created.length, 1);
  assert.equal(r.created[0].payee, "Metro Transit Card");
  assert.equal(r.error, undefined);
});

test("search returning [] still classifies", async () => {
  const s = setup({ snippets: [] });
  const r = await s.run();
  assert.equal(r.created.length, 1);
  assert.ok(!s.calls.prompts[0].prompt.includes("Web search results"));
});

test("nothing to do: notify not called", async () => {
  const s = setup({ data: { transactions: [] } });
  const r = await s.run();
  assert.equal(r.created.length, 0);
  assert.equal(s.calls.sent.length, 0);
  assert.equal(s.calls.close, 1);
});

test("actual.open throws: result.error set, notify gets failure line, close still called", async () => {
  const s = setup({ openError: "no server" });
  const r = await s.run();
  assert.match(r.error, /no server/);
  assert.match(s.calls.sent[0][0], /^Budget autocat failed: .*no server/);
  assert.equal(s.calls.close, 1);
});

test("bank sync skipped when syncBeforeRun is false", async () => {
  const off = setup({ config: { syncBeforeRun: false } });
  await off.run();
  assert.equal(off.calls.syncs.filter((o) => o?.bank !== false).length, 0);
  const on = setup();
  await on.run();
  assert.deepEqual(on.calls.syncs[0], { bank: true });
  assert.equal(on.calls.syncs.filter((o) => o?.bank !== false).length, 1);
});

test("live: before each payee's writes, syncs with the server (no bank sync) and re-reads rules", async () => {
  const s = setup({
    data: { transactions: [tx("t1", "p-bb"), tx("t2", "p-bb"), tx("t3", "p-tg")] },
    seeds: [{ payeeName: "Metro Transit Card", categoryName: "Transit" }],
  });
  s.data.transactions.push(tx("v1", "p-vn"));
  await s.run();
  // one bank+server sync before the run, then one server-only sync per payee written (seed + 2 model)
  assert.deepEqual(s.calls.syncs, [{ bank: true }, { bank: false }, { bank: false }, { bank: false }]);
  assert.equal(s.calls.ruleReads, 3);
});

test("live: a payee covered by a rule made during the run is skipped and counted as left for your rules", async () => {
  const userRule = buildCategoryRule("p-tg", "c-misc");
  const s = setup({
    data: { transactions: [tx("t1", "p-bb"), tx("t2", "p-bb"), tx("t3", "p-tg")] },
    liveRules: (n) => (n === 1 ? [] : [userRule]),
  });
  const r = await s.run();
  assert.deepEqual(s.calls.rules, [buildCategoryRule("p-bb", "c-coffee")]);
  assert.deepEqual(r.created.map((c) => c.payee), ["Blue Bottle"]);
  assert.deepEqual(s.calls.cat.map((c) => c[0]).sort(), ["t1", "t2"]);
  assert.equal(r.leftForUserRules, 1);
});

test("live: a seed whose payee got a rule during the run is skipped and not sent to the model", async () => {
  const s = setup({
    data: { transactions: [tx("v1", "p-vn")] },
    seeds: [{ payeeName: "Metro Transit Card", categoryName: "Transit" }],
    liveRules: () => [buildCategoryRule("p-vn", "c-misc")],
  });
  const state = { seeded: [], varies: [] };
  const r = await s.run(state);
  assert.equal(s.calls.rules.length, 0);
  assert.equal(s.calls.prompts.length, 0);
  assert.equal(r.created.length, 0);
  assert.equal(r.leftForUserRules, 1);
  assert.deepEqual(state.seeded, []);
});

test("live: txnCount counts only transactions actually written", async () => {
  const s = setup({ written: (t) => t.id !== "t2" });
  const r = await s.run();
  assert.equal(r.created[0].txnCount, 2);
  assert.equal(JSON.parse(readFileSync(s.logPath, "utf8").trim()).txnCount, 2);
});

test("varies goes to MIXED_PAYEE_CATEGORY only when its kind matches the payee's (income vs expense)", async () => {
  const s = setup({
    data: { transactions: [tx("t1", "p-tg", { amount: 2500 })] },
    config: { mixedPayeeCategory: "Miscellaneous" },
    reply: () => '{"category":"varies","reason":"refunds of all sorts"}',
  });
  const r = await s.run();
  assert.equal(s.calls.rules.length, 0);
  assert.deepEqual(r.variesLeftAlone, [{ payee: "Target", reason: "refunds of all sorts" }]);
  assert.deepEqual(loadState(s.statePath).varies, ["p-tg"]);
});

test("unresolvable MIXED_PAYEE_CATEGORY is an error and no work is done", async () => {
  const s = setup({ config: { mixedPayeeCategory: "Nope" } });
  const r = await s.run();
  assert.match(r.error, /MIXED_PAYEE_CATEGORY/);
  assert.equal(s.calls.prompts.length, 0);
  assert.equal(s.calls.close, 1);
});

test("logs one info line per payee", async () => {
  const lines = [];
  const s = setup({ log: { ...silent, info: (m) => lines.push(m) } });
  await s.run();
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^Blue Bottle: Coffee \(\d+(\.\d+)?s\)$/);
});

test("categorize failing part-way still records the rule, seed state and audit entry", async () => {
  for (const seed of [false, true]) {
    const s = setup({
      data: { transactions: [tx("t1", "p-bb"), tx("t2", "p-bb"), tx("t3", "p-bb")] },
      seeds: seed ? [{ payeeName: "Blue Bottle", categoryName: "Coffee" }] : [],
    });
    let n = 0;
    const state = { seeded: [], varies: [] };
    const dir = mkdtempSync(join(tmpdir(), "run-"));
    const calls = { close: 0, sent: [] };
    const actual = {
      async open() {}, async sync() {},
      async load() { return s.data; },
      async rules() { return []; },
      async createRule() { return "rule1"; },
      async categorize() { if (++n === 2) throw new Error("write failed"); return true; },
      async close() { calls.close++; },
    };
    const llm = { async complete() { return '{"category":"c-coffee","reason":"coffee"}'; } };
    const config = { dryRun: false, syncBeforeRun: false, skipPayees: null, maxPayeesPerRun: 0, mixedPayeeCategory: "", notesTag: "#autocat" };
    const logPath = join(dir, "l.jsonl");
    const r = await runOnce({
      config, actual, llm, search: { async lookup() { return []; } },
      notify: { async send(m) { calls.sent.push(m); } }, guidance: "", seeds: seed ? [{ payeeName: "Blue Bottle", categoryName: "Coffee" }] : [],
      state, statePath: join(dir, "s.json"), logPath, log: silent,
    });
    assert.match(r.error, /write failed/);
    assert.equal(r.created.length, 1);
    assert.equal(r.created[0].txnCount, 1);
    assert.equal(JSON.parse(readFileSync(logPath, "utf8").trim()).txnCount, 1);
    assert.deepEqual(loadState(join(dir, "s.json")).seeded, seed ? ["blue bottle"] : []);
    assert.equal(calls.close, 1);
    // The failure line comes first, followed by the rule already created (with its reason).
    const lines = calls.sent[0][0].split("\n");
    assert.equal(lines[0], "Budget autocat failed: write failed");
    assert.ok(lines.includes(`• Blue Bottle → Coffee: ${seed ? "from rules.yaml" : "coffee"} (1)`), lines.join("\n"));
  }
});

const manyPayees = Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, name: `Merchant ${i}` }));
// Merchant 0 has the most transactions, so payees are asked in order 0, 1, 2, ...
const manyTxns = manyPayees.flatMap((p, i) => Array.from({ length: 6 - i }, (_, k) => tx(`${p.id}-${k}`, p.id)));

test("3 model failures in a row stop the run: model unreachable, with what was done so far", async () => {
  const s = setup({
    data: { payees: manyPayees, transactions: manyTxns },
    reply: (_p, n) => (n === 1 ? '{"category":"c-coffee","reason":"cafe"}' : new LlmError(`model request failed: HTTP 50${n}`)),
  });
  const r = await s.run();
  assert.equal(s.calls.prompts.length, 4);
  assert.equal(r.error, "model unreachable: model request failed: HTTP 504");
  assert.equal(r.undecided.length, 3);
  assert.equal(r.created.length, 1);
  const lines = s.calls.sent[0][0].split("\n");
  assert.equal(lines[0], "Budget autocat failed: model unreachable: model request failed: HTTP 504");
  assert.ok(lines.includes("• Merchant 0 → Coffee: cafe (6)"));
  assert.equal(s.calls.close, 1);
  assert.ok(existsSync(s.statePath));
});

test("invalid replies don't count toward the model-unreachable stop; a reply resets the count", async () => {
  const s = setup({
    data: { payees: manyPayees, transactions: manyTxns },
    reply: (_p, n) => ([1, 2, 4, 5].includes(n) ? new LlmError("model request failed: HTTP 503") : "nonsense"),
  });
  const r = await s.run();
  assert.equal(s.calls.prompts.length, 6);
  assert.equal(r.error, undefined);
  assert.equal(r.undecided.length, 6);
});

test("stop signal: the run stops between payees, saves state and closes", async () => {
  const controller = new AbortController();
  const s = setup({
    data: { payees: manyPayees, transactions: manyTxns },
    signal: controller.signal,
    reply: (_p, n) => {
      if (n === 1) controller.abort();
      return '{"category":"c-coffee","reason":"cafe"}';
    },
  });
  const r = await s.run();
  assert.equal(s.calls.prompts.length, 1);
  assert.equal(s.calls.prompts[0].opts.signal, controller.signal);
  assert.equal(r.created.length, 1, "the payee being written when the stop came is finished");
  assert.match(r.error, /stopped/);
  assert.ok(existsSync(s.statePath));
  assert.equal(s.calls.close, 1);
});

test("stop signal during a model call: that payee is not listed as undecided", async () => {
  const controller = new AbortController();
  const s = setup({
    data: { payees: manyPayees, transactions: manyTxns },
    signal: controller.signal,
    reply: () => {
      controller.abort();
      return new LlmError("model request cancelled");
    },
  });
  const r = await s.run();
  assert.equal(r.undecided.length, 0);
  assert.match(r.error, /stopped/);
  assert.equal(s.calls.close, 1);
});
