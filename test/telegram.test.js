import { test } from "node:test";
import assert from "node:assert/strict";
import { createTelegram } from "../src/notify/telegram.js";

const TOKEN = "123:SECRET";
function logger() {
  const lines = [];
  const f = (m) => lines.push(String(m));
  return { debug: f, info: f, warn: f, error: f, lines };
}

test("disabled when token or chat id missing", async () => {
  assert.equal(createTelegram({ telegramBotToken: "", telegramChatId: "1" }).enabled, false);
  assert.equal(createTelegram({ telegramBotToken: TOKEN, telegramChatId: "" }).enabled, false);
  let called = false;
  const t = createTelegram({ telegramBotToken: "", telegramChatId: "" }, async () => { called = true; });
  await t.send(["hi"]);
  assert.equal(called, false);
});

test("posts each message in order to the right URL", async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 200 }; };
  const t = createTelegram({ telegramBotToken: TOKEN, telegramChatId: "42" }, fetchImpl, logger());
  assert.equal(t.enabled, true);
  await t.send(["one", "two"]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
  assert.equal(calls[0].opts.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].opts.body), { chat_id: "42", text: "one" });
  assert.equal(JSON.parse(calls[1].opts.body).text, "two");
  assert.ok(!("parse_mode" in JSON.parse(calls[0].opts.body)));
});

test("network error is swallowed and logged without the token", async () => {
  const log = logger();
  const fetchImpl = async (url) => { throw new Error(`fetch failed for ${url}`); };
  const t = createTelegram({ telegramBotToken: TOKEN, telegramChatId: "42" }, fetchImpl, log);
  await t.send(["a"]);
  assert.ok(log.lines.length > 0);
  assert.ok(!log.lines.join("\n").includes("SECRET"));
});

test("HTTP failure is logged without the token and does not throw", async () => {
  const log = logger();
  const fetchImpl = async () => ({ ok: false, status: 400, text: async () => "bad" });
  const t = createTelegram({ telegramBotToken: TOKEN, telegramChatId: "42" }, fetchImpl, log);
  await t.send(["a", "b"]);
  assert.ok(log.lines.some((l) => l.includes("400")));
  assert.ok(!log.lines.join("\n").includes("SECRET"));
});
