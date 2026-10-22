import { test } from "node:test";
import assert from "node:assert/strict";
import { runCheck } from "../src/check.js";
import { createSearch } from "../src/search.js";
import { createTelegram } from "../src/notify/telegram.js";

const cats = [
  { id: "c-coffee", name: "Coffee", groupName: "Food", isIncome: false, hidden: false },
  { id: "c-pay", name: "Paycheck", groupName: "Income", isIncome: true, hidden: false },
];
const config = {
  actualServerUrl: "http://actual:5006",
  actualPassword: "pw-secret-1",
  actualBudgetId: "b1",
  actualEncryptionPassword: "enc-secret-2",
  llmProvider: "openai",
  llmApiKey: "key-secret-3",
  llmModel: "test-model",
  searxngUrl: "http://searx:8080",
  searchResults: 3,
  telegramBotToken: "tok-secret-4",
  telegramChatId: "42",
  mixedPayeeCategory: "",
  dataDir: "/tmp/none",
};
const secrets = ["pw-secret-1", "enc-secret-2", "key-secret-3", "tok-secret-4"];
const json = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });

function setup({ cfg = {}, searchFetch, seeds } = {}) {
  const problems = [];
  const log = { debug() {}, info() {}, warn: (m) => problems.push(m), error: (m) => problems.push(m) };
  const calls = { close: 0, rules: 0, categorize: 0, prompts: [], sent: [] };
  const merged = { ...config, ...cfg };
  const actual = {
    async open() {},
    async load() { return { categories: cats, payees: [], rules: [], transactions: [{ id: "t1" }, { id: "t2" }] }; },
    async createRule() { calls.rules++; },
    async categorize() { calls.categorize++; },
    async close() { calls.close++; },
  };
  const llm = { async complete(prompt, schema) { calls.prompts.push([prompt, schema]); return '{"category":"c-coffee","reason":"ok"}'; } };
  const search = createSearch({
    url: merged.searxngUrl,
    results: 3,
    cachePath: "/nonexistent-dir-for-test/cache.json",
    fetchImpl: searchFetch ?? (async () => json({ results: [{ title: "Coffee", content: "A drink" }] })),
    log,
  });
  const notify = createTelegram(merged, async (url, init) => { calls.sent.push(init.body); return { ok: true, status: 200 }; }, log);
  return { deps: { config: merged, actual, llm, search, notify, seeds, problems }, calls };
}

test("healthy check passes, uses the real schema, and prints no secrets", async () => {
  const { deps, calls } = setup();
  const res = await runCheck(deps);
  assert.equal(res.ok, true, res.lines.join("\n"));
  const text = res.lines.join("\n");
  for (const s of secrets) assert.ok(!text.includes(s), `leaked ${s}`);
  assert.deepEqual(calls.prompts[0][1].properties.category.enum, ["c-coffee"]);
  assert.match(calls.prompts[0][0], /c-coffee/);
  assert.equal(calls.sent.length, 1);
  assert.match(text, /2 uncategorized/);
  assert.match(text, /Food: Coffee/);
  assert.equal(calls.close, 1);
  assert.equal(calls.rules + calls.categorize, 0);
});

test("a bad MIXED_PAYEE_CATEGORY fails and is named", async () => {
  const { deps } = setup({ cfg: { mixedPayeeCategory: "Nonexistent" } });
  const res = await runCheck(deps);
  assert.equal(res.ok, false);
  assert.ok(res.lines.some((l) => l.startsWith("✗") && l.includes("Nonexistent")));
});

test("rules.yaml with an unknown category fails", async () => {
  const { deps } = setup({ seeds: [{ payeeName: "Blue Bottle", categoryName: "Cofee" }] });
  const res = await runCheck(deps);
  assert.equal(res.ok, false);
  assert.ok(res.lines.some((l) => l.includes("Cofee")));
});

test("SearXNG returning HTML fails with the JSON-format hint", async () => {
  const { deps } = setup({ searchFetch: async () => ({ ok: true, status: 200, text: async () => "<html></html>" }) });
  const res = await runCheck(deps);
  assert.equal(res.ok, false);
  assert.ok(res.lines.some((l) => l.startsWith("✗") && l.includes("search.formats: [html, json]")));
});

test("Actual failure still closes the budget and skips the model", async () => {
  const { deps, calls } = setup();
  deps.actual.open = async () => { throw new Error("connect ECONNREFUSED pw-secret-1"); };
  const res = await runCheck(deps);
  assert.equal(res.ok, false);
  assert.equal(calls.close, 1);
  assert.equal(calls.prompts.length, 0);
  assert.ok(!res.lines.join("\n").includes("pw-secret-1"));
  assert.ok(res.lines.some((l) => l.includes("ACTUAL_SERVER_URL")));
});

test("unconfigured search and Telegram are reported, not failed", async () => {
  const { deps } = setup({ cfg: { searxngUrl: "", telegramBotToken: "", telegramChatId: "" } });
  const res = await runCheck(deps);
  assert.equal(res.ok, true);
  assert.equal(res.lines.filter((l) => l.includes("not configured")).length, 2);
});
