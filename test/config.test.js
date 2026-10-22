import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, ConfigError, redact } from "../src/config.js";

const base = {
  ACTUAL_SERVER_URL: "http://actual:5006",
  ACTUAL_PASSWORD: "pw",
  ACTUAL_BUDGET_ID: "budget-1",
  LLM_BASE_URL: "http://llm:8080/v1",
  LLM_MODEL: "some-model",
};

test("minimal valid env gives defaults", () => {
  const c = loadConfig(base);
  assert.equal(c.dryRun, true);
  assert.equal(c.llmProvider, "openai");
  assert.equal(c.llmTimeoutMs, 300000);
  assert.equal(c.searchResults, 3);
  assert.equal(c.schedule, "0 2 * * *");
  assert.equal(c.tz, "UTC");
  assert.equal(c.notesTag, "#autocat");
  assert.equal(c.skipPayees, null);
  assert.equal(c.mixedPayeeCategory, "");
  assert.equal(c.llmJsonSchema, true);
  assert.equal(c.runOnStart, false);
  assert.equal(c.syncBeforeRun, true);
  assert.equal(c.maxPayeesPerRun, 0);
  assert.equal(c.logLevel, "info");
  assert.equal(c.configDir, "/config");
  assert.equal(c.dataDir, "/data");
  assert.equal(c.actualServerUrl, "http://actual:5006");
});

test("CONFIG_DIR and DATA_DIR override paths", () => {
  const c = loadConfig({ ...base, CONFIG_DIR: "/tmp/c", DATA_DIR: "/tmp/d" });
  assert.equal(c.configDir, "/tmp/c");
  assert.equal(c.dataDir, "/tmp/d");
});

test("missing ACTUAL_PASSWORD throws ConfigError mentioning ACTUAL_PASSWORD", () => {
  const { ACTUAL_PASSWORD, ...env } = base;
  assert.throws(() => loadConfig(env), (e) => e instanceof ConfigError && /ACTUAL_PASSWORD/.test(e.message));
});

test("openai provider requires LLM_BASE_URL", () => {
  const { LLM_BASE_URL, ...env } = base;
  assert.throws(() => loadConfig(env), (e) => e instanceof ConfigError && /LLM_BASE_URL/.test(e.message));
});

test("anthropic provider requires LLM_API_KEY and not LLM_BASE_URL", () => {
  const { LLM_BASE_URL, ...rest } = base;
  const env = { ...rest, LLM_PROVIDER: "anthropic" };
  assert.throws(() => loadConfig(env), (e) => e instanceof ConfigError && /LLM_API_KEY/.test(e.message));
  const c = loadConfig({ ...env, LLM_API_KEY: "k" });
  assert.equal(c.llmProvider, "anthropic");
  assert.throws(
    () => loadConfig({ ...env, LLM_API_KEY: "k", LLM_BASE_URL: "http://x" }),
    (e) => e instanceof ConfigError && /LLM_BASE_URL/.test(e.message),
  );
});

test("invalid SKIP_PAYEES regex throws ConfigError mentioning SKIP_PAYEES", () => {
  assert.throws(
    () => loadConfig({ ...base, SKIP_PAYEES: "(unclosed" }),
    (e) => e instanceof ConfigError && /SKIP_PAYEES/.test(e.message),
  );
});

test("valid SKIP_PAYEES becomes a case-insensitive RegExp", () => {
  const c = loadConfig({ ...base, SKIP_PAYEES: "^transfer|venmo" });
  assert.ok(c.skipPayees instanceof RegExp);
  assert.ok(c.skipPayees.test("VENMO payment"));
});

test("booleans accept true/false/1/0 case-insensitively; anything else throws", () => {
  for (const [v, exp] of [["true", true], ["TRUE", true], ["1", true], ["false", false], ["False", false], ["0", false]]) {
    assert.equal(loadConfig({ ...base, DRY_RUN: v }).dryRun, exp, v);
  }
  assert.throws(() => loadConfig({ ...base, DRY_RUN: "yes" }), (e) => e instanceof ConfigError && /DRY_RUN/.test(e.message));
});

test("LLM_PROVIDER=gemini throws", () => {
  assert.throws(() => loadConfig({ ...base, LLM_PROVIDER: "gemini" }), (e) => e instanceof ConfigError && /LLM_PROVIDER/.test(e.message));
});

test("trailing slash is stripped from LLM_BASE_URL and SEARXNG_URL", () => {
  const c = loadConfig({ ...base, LLM_BASE_URL: "http://llm:8080/v1/", SEARXNG_URL: "http://s:8080//" });
  assert.equal(c.llmBaseUrl, "http://llm:8080/v1");
  assert.equal(c.searxngUrl, "http://s:8080");
});

test("LLM_TIMEOUT_SECONDS converts to milliseconds; bad numbers throw", () => {
  assert.equal(loadConfig({ ...base, LLM_TIMEOUT_SECONDS: "30" }).llmTimeoutMs, 30000);
  assert.throws(() => loadConfig({ ...base, SEARCH_RESULTS: "abc" }), (e) => e instanceof ConfigError && /SEARCH_RESULTS/.test(e.message));
});

test("LLM_TIMEOUT_SECONDS must be at least 1", () => {
  assert.equal(loadConfig({ ...base, LLM_TIMEOUT_SECONDS: "1" }).llmTimeoutMs, 1000);
  assert.throws(
    () => loadConfig({ ...base, LLM_TIMEOUT_SECONDS: "0" }),
    (e) => e instanceof ConfigError && /LLM_TIMEOUT_SECONDS/.test(e.message) && /at least 1/.test(e.message),
  );
});

test("redact hides set secrets and leaves empty ones empty", () => {
  const c = loadConfig({ ...base, LLM_API_KEY: "sk-secret", TELEGRAM_BOT_TOKEN: "tok" });
  const r = redact(c);
  assert.equal(r.actualPassword, "***");
  assert.equal(r.llmApiKey, "***");
  assert.equal(r.telegramBotToken, "***");
  assert.equal(r.actualEncryptionPassword, "");
  assert.equal(r.actualServerUrl, "http://actual:5006");
  assert.ok(!JSON.stringify(r).includes("sk-secret"));
  assert.equal(c.actualPassword, "pw");
});
