import { test } from "node:test";
import assert from "node:assert/strict";
import { APIConnectionError, APIConnectionTimeoutError, APIUserAbortError, InternalServerError } from "@anthropic-ai/sdk";
import { createLlm, LlmError } from "../src/llm/index.js";

const SCHEMA = { type: "object", properties: { category: { type: "string" } } };
const KEY = "sk-secret-key-123";

function cfg(over = {}) {
  return {
    llmProvider: "openai",
    llmBaseUrl: "http://llm.test/v1",
    llmApiKey: "",
    llmModel: "test-model",
    llmJsonSchema: true,
    llmTimeoutMs: 5000,
    ...over,
  };
}

function reply(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (r instanceof Error) throw r;
    return r.clone();
  };
  fn.calls = calls;
  return fn;
}

const ok = (content = "{}", extra = {}) => reply({ choices: [{ message: { content, ...extra } }] });
const noSleep = async () => {};

test("openai sends schema when llmJsonSchema", async () => {
  const f = fakeFetch([ok()]);
  await createLlm(cfg(), { fetchImpl: f, sleep: noSleep }).complete("hi", SCHEMA);
  assert.equal(f.calls[0].url, "http://llm.test/v1/chat/completions");
  assert.deepEqual(f.calls[0].body, {
    model: "test-model",
    messages: [{ role: "user", content: "hi" }],
    temperature: 0,
    response_format: { type: "json_schema", json_schema: { name: "categorization", strict: true, schema: SCHEMA } },
  });
});

test("openai omits response_format when false", async () => {
  const f = fakeFetch([ok()]);
  await createLlm(cfg({ llmJsonSchema: false }), { fetchImpl: f, sleep: noSleep }).complete("hi", SCHEMA);
  assert.equal("response_format" in f.calls[0].body, false);
});

test("openai sends Authorization only when a key is set", async () => {
  const f = fakeFetch([ok(), ok()]);
  await createLlm(cfg(), { fetchImpl: f, sleep: noSleep }).complete("hi", SCHEMA);
  await createLlm(cfg({ llmApiKey: KEY }), { fetchImpl: f, sleep: noSleep }).complete("hi", SCHEMA);
  assert.equal(f.calls[0].init.headers.Authorization, undefined);
  assert.equal(f.calls[1].init.headers.Authorization, `Bearer ${KEY}`);
});

test("openai returns message content and ignores reasoning_content", async () => {
  const f = fakeFetch([ok('{"category":"x"}', { reasoning_content: "thinking..." })]);
  const out = await createLlm(cfg(), { fetchImpl: f, sleep: noSleep }).complete("hi", SCHEMA);
  assert.equal(out, '{"category":"x"}');
});

test("openai retries a 503 twice then throws LlmError whose message does not contain the key", async () => {
  const f = fakeFetch([reply({ error: KEY }, 503)]);
  const sleeps = [];
  const llm = createLlm(cfg({ llmApiKey: KEY }), { fetchImpl: f, sleep: async (ms) => sleeps.push(ms) });
  await assert.rejects(llm.complete("hi", SCHEMA), (err) => {
    assert.ok(err instanceof LlmError);
    assert.ok(!err.message.includes(KEY));
    assert.match(err.message, /503/);
    return true;
  });
  assert.equal(f.calls.length, 3);
  assert.deepEqual(sleeps, [2000, 4000]);
});

test("openai retries network errors then succeeds", async () => {
  const f = fakeFetch([new TypeError("fetch failed"), ok("done")]);
  const out = await createLlm(cfg(), { fetchImpl: f, sleep: noSleep }).complete("hi", SCHEMA);
  assert.equal(out, "done");
  assert.equal(f.calls.length, 2);
});

test("openai does not retry a 400", async () => {
  const f = fakeFetch([reply({ error: "bad" }, 400)]);
  await assert.rejects(createLlm(cfg(), { fetchImpl: f, sleep: noSleep }).complete("hi", SCHEMA), LlmError);
  assert.equal(f.calls.length, 1);
});

test("openai does not retry a timeout", async () => {
  const f = fakeFetch([new DOMException("The operation was aborted due to timeout", "TimeoutError"), ok()]);
  await assert.rejects(createLlm(cfg(), { fetchImpl: f, sleep: noSleep }).complete("hi", SCHEMA), (err) => {
    assert.ok(err instanceof LlmError);
    assert.match(err.message, /timed out/);
    return true;
  });
  assert.equal(f.calls.length, 1);
});

test("openai cancels the body of a failed response", async () => {
  let cancelled = 0;
  const failed = { ok: false, status: 503, body: { cancel: async () => { cancelled++; } } };
  failed.clone = () => failed;
  const f = fakeFetch([failed, ok("done")]);
  assert.equal(await createLlm(cfg(), { fetchImpl: f, sleep: noSleep }).complete("hi", SCHEMA), "done");
  assert.equal(cancelled, 1);
});

test("openai: aborting the caller's signal cancels the request, which is not retried", async () => {
  const controller = new AbortController();
  const calls = [];
  const fetchImpl = (url, init) => {
    calls.push(init);
    return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
  };
  const pending = createLlm(cfg(), { fetchImpl, sleep: noSleep }).complete("hi", SCHEMA, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (err) => err instanceof LlmError && /cancelled/.test(err.message));
  assert.equal(calls.length, 1);
});

test("openai throws LlmError when the reply has no content", async () => {
  const f = fakeFetch([reply({ choices: [] })]);
  await assert.rejects(createLlm(cfg(), { fetchImpl: f, sleep: noSleep }).complete("hi", SCHEMA), LlmError);
});

function fakeAnthropic(message) {
  const calls = [];
  return { calls, messages: { create: async (p) => (calls.push(p), message) } };
}

test("anthropic passes model, effort low, the schema, and returns text", async () => {
  const client = fakeAnthropic({
    stop_reason: "end_turn",
    content: [{ type: "text", text: '{"a":' }, { type: "thinking", thinking: "x" }, { type: "text", text: "1}" }],
  });
  const llm = createLlm(cfg({ llmProvider: "anthropic", llmModel: "claude-opus-5-5", llmApiKey: KEY }), { anthropicClient: client });
  assert.equal(await llm.complete("hi", SCHEMA), '{"a":1}');
  assert.deepEqual(client.calls[0], {
    model: "claude-opus-5-5",
    max_tokens: 1024,
    messages: [{ role: "user", content: "hi" }],
    output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
  });
});

test("anthropic refusal -> LlmError(model declined)", async () => {
  const client = fakeAnthropic({ stop_reason: "refusal", content: [] });
  const llm = createLlm(cfg({ llmProvider: "anthropic", llmApiKey: KEY }), { anthropicClient: client });
  await assert.rejects(llm.complete("hi", SCHEMA), (err) => err instanceof LlmError && err.message === "model declined");
});

test("anthropic SDK errors become LlmError without the key", async () => {
  const client = { messages: { create: async () => { throw new Error(`401 bad key ${KEY}`); } } };
  const llm = createLlm(cfg({ llmProvider: "anthropic", llmApiKey: KEY }), { anthropicClient: client });
  await assert.rejects(llm.complete("hi", SCHEMA), (err) => err instanceof LlmError && !err.message.includes(KEY));
});

test("anthropic client does no retries of its own", async () => {
  const { createAnthropic } = await import("../src/llm/anthropic.js");
  const seen = [];
  createAnthropic(cfg({ llmProvider: "anthropic", llmApiKey: KEY }), { makeClient: (opts) => seen.push(opts) });
  assert.equal(seen[0].maxRetries, 0);
  assert.equal(seen[0].timeout, 5000);
});

function failingAnthropic(errors) {
  const calls = [];
  return {
    calls,
    messages: {
      create: async (p, opts) => {
        calls.push(opts);
        const e = errors[Math.min(calls.length - 1, errors.length - 1)];
        if (e) throw e;
        return { stop_reason: "end_turn", content: [{ type: "text", text: "done" }] };
      },
    },
  };
}

test("anthropic does not retry a timeout", async () => {
  const client = failingAnthropic([new APIConnectionTimeoutError()]);
  const llm = createLlm(cfg({ llmProvider: "anthropic", llmApiKey: KEY }), { anthropicClient: client, sleep: noSleep });
  await assert.rejects(llm.complete("hi", SCHEMA), (err) => err instanceof LlmError && /timed out/.test(err.message));
  assert.equal(client.calls.length, 1);
});

test("anthropic retries connection errors and 5xx twice with backoff", async () => {
  const sleeps = [];
  const fiveHundred = new InternalServerError(529, { type: "overloaded_error" }, "overloaded", new Headers());
  const client = failingAnthropic([new APIConnectionError({ message: "reset" }), fiveHundred, null]);
  const llm = createLlm(cfg({ llmProvider: "anthropic", llmApiKey: KEY }), { anthropicClient: client, sleep: async (ms) => sleeps.push(ms) });
  assert.equal(await llm.complete("hi", SCHEMA), "done");
  assert.equal(client.calls.length, 3);
  assert.deepEqual(sleeps, [2000, 4000]);
});

test("anthropic passes the caller's signal and does not retry a cancelled request", async () => {
  const controller = new AbortController();
  const client = failingAnthropic([new APIUserAbortError()]);
  const llm = createLlm(cfg({ llmProvider: "anthropic", llmApiKey: KEY }), { anthropicClient: client, sleep: noSleep });
  await assert.rejects(llm.complete("hi", SCHEMA, { signal: controller.signal }), (err) => err instanceof LlmError && /cancelled/.test(err.message));
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].signal, controller.signal);
});
