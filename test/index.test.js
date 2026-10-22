import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCheckActual, createLogger, createScheduler, makeRunTask } from "../src/index.js";
import { ConfigError } from "../src/config.js";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

function fakeCron() {
  const made = [];
  class FakeCron {
    constructor(pattern, opts, fn) {
      this.pattern = pattern;
      this.opts = opts;
      this.fn = fn;
      this.stopped = false;
      made.push(this);
    }
    stop() { this.stopped = true; }
  }
  return { FakeCron, made };
}

test("scheduler skips a tick while the previous run is still going", async () => {
  const { FakeCron, made } = fakeCron();
  const infos = [];
  let calls = 0;
  let release;
  const task = () => { calls++; return calls === 1 ? new Promise((r) => { release = r; }) : Promise.resolve(); };
  const s = createScheduler({ schedule: "0 2 * * *", tz: "UTC" }, task, { Cron: FakeCron, log: { ...silent, info: (m) => infos.push(m) } });
  assert.equal(made[0].pattern, "0 2 * * *");
  assert.deepEqual(made[0].opts, { timezone: "UTC" });
  const first = made[0].fn();
  await made[0].fn();
  assert.equal(calls, 1);
  assert.deepEqual(infos, ["previous run still going, skipping"]);
  release();
  await first;
  await made[0].fn();
  assert.equal(calls, 2);
  s.stop();
  assert.equal(made[0].stopped, true);
});

test("shutdown stops the cron, aborts the running task's signal and waits for it to finish", async () => {
  const { FakeCron, made } = fakeCron();
  let signal;
  let finished = false;
  const task = (s) => {
    signal = s;
    return new Promise((resolve) => {
      s.addEventListener("abort", () => setTimeout(() => { finished = true; resolve(); }, 5));
    });
  };
  const s = createScheduler({ schedule: "0 2 * * *", tz: "UTC" }, task, { Cron: FakeCron, log: silent });
  const run = made[0].fn();
  assert.equal(signal.aborted, false);
  await s.shutdown();
  assert.equal(made[0].stopped, true);
  assert.equal(signal.aborted, true);
  assert.equal(finished, true);
  await run;
  let again = 0;
  await createScheduler({ schedule: "0 2 * * *", tz: "UTC" }, async () => { again++; }, { Cron: FakeCron, log: silent }).shutdown();
  await made[1].fn();
  assert.equal(again, 0, "no run starts after shutdown");
});

test("a failing task is logged and does not block later ticks", async () => {
  const { FakeCron, made } = fakeCron();
  const errors = [];
  let calls = 0;
  createScheduler({ schedule: "* * * * *", tz: "UTC" }, async () => { calls++; throw new Error("boom"); }, {
    Cron: FakeCron,
    log: { ...silent, error: (m) => errors.push(m) },
  });
  await made[0].fn();
  await made[0].fn();
  assert.equal(calls, 2);
  assert.match(errors[0], /boom/);
});

test("an invalid schedule is a ConfigError", () => {
  assert.throws(() => createScheduler({ schedule: "not a cron", tz: "UTC" }, async () => {}, { log: silent }), ConfigError);
});

test("logger honors the level and prefixes a timestamp", () => {
  const out = [];
  const err = [];
  const log = createLogger("warn", { out: (l) => out.push(l), err: (l) => err.push(l) });
  log.info("hidden");
  log.warn("shown");
  assert.deepEqual(out, []);
  assert.match(err[0], /^\d{4}-\d{2}-\d{2}T[\d:.]+Z WARN shown$/);
});

test("check's search ignores a cached hit in the live cache and always contacts the server", async () => {
  const { mkdtempSync, writeFileSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createCheckSearch } = await import("../src/index.js");
  const { runCheck } = await import("../src/check.js");
  const dataDir = mkdtempSync(join(tmpdir(), "live-"));
  const live = join(dataDir, "search-cache.json");
  const seeded = JSON.stringify({ coffee: { lines: ["- Coffee: cached"], at: Date.now() } });
  writeFileSync(live, seeded);
  const problems = [];
  const sink = { ...silent, warn: (m) => problems.push(m) };
  const config = { searxngUrl: "http://searx:8080", searchResults: 3, dataDir, actualServerUrl: "http://a", llmModel: "m" };
  const { search, cleanup } = createCheckSearch(config, sink, async () => { throw new Error("connection refused"); });
  const actual = { async open() {}, async load() { return { categories: [], payees: [], rules: [], transactions: [] }; }, async close() {} };
  const res = await runCheck({ config, actual, llm: { complete: async () => "" }, search, notify: { enabled: false }, problems });
  cleanup();
  assert.ok(res.lines.some((l) => l.startsWith("✗ SearXNG")), res.lines.join("\n"));
  assert.equal(readFileSync(live, "utf8"), seeded);
});

test("run task: an invalid rules.yaml or corrupt state.json is a failed run reported through notify, with the path", async () => {
  for (const [file, text] of [["rules.yaml", "a: [unclosed\n"], ["state.json", "{not json"]]) {
    const dir = mkdtempSync(join(tmpdir(), "autocat-task-"));
    writeFileSync(join(dir, file), text);
    const sent = [];
    const errors = [];
    const config = { configDir: dir, dataDir: dir, searxngUrl: "", searchResults: 3, llmProvider: "openai", llmBaseUrl: "http://llm", llmTimeoutMs: 1000 };
    const task = makeRunTask(config, { ...silent, error: (m) => errors.push(m) }, { notify: { async send(m) { sent.push(m); } } });
    const result = await task(new AbortController().signal);
    assert.ok(result.error.includes(join(dir, file)), result.error);
    assert.equal(sent.length, 1, file);
    assert.match(sent[0][0], new RegExp(`^Budget autocat failed: .*${file.replace(".", "\\.")}`));
    assert.equal(errors.length, 1);
  }
});

test("check opens the budget in its own temporary folder, never the scheduler's data/actual-cache", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "autocat-data-"));
  const inits = [];
  const api = { init: async (c) => inits.push(c), downloadBudget: async () => {}, shutdown: async () => {} };
  const config = { dataDir, actualServerUrl: "http://a", actualPassword: "pw", actualBudgetId: "b" };
  const { actual, cleanup } = createCheckActual(config, silent, { api });
  await actual.open();
  await actual.close();
  assert.ok(!inits[0].dataDir.startsWith(dataDir), inits[0].dataDir);
  assert.ok(existsSync(inits[0].dataDir));
  cleanup();
  assert.equal(existsSync(inits[0].dataDir), false);
  assert.equal(existsSync(join(dataDir, "actual-cache")), false);
});
