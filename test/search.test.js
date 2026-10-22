import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSearch } from "../src/search.js";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

function recordingLog() {
  const warnings = [];
  return { ...silent, warn: (m) => warnings.push(m), warnings };
}

async function tmpCache() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "autocat-search-"));
  return path.join(dir, "search-cache.json");
}

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function fakeFetch(body) {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, opts });
    return jsonResponse(body);
  };
  impl.calls = calls;
  return impl;
}

const DAY = 24 * 60 * 60 * 1000;

test("requests the SearXNG JSON endpoint and formats the first N results with content", async () => {
  const fetchImpl = fakeFetch({
    results: [
      { title: "Blue Bottle Coffee", content: "  Specialty coffee roaster  ", url: "https://a" },
      { title: "Menu", content: "x".repeat(300), url: "https://b" },
      { title: "Third", content: "third", url: "https://c" },
    ],
  });
  const search = createSearch({
    url: "http://searx.test",
    results: 2,
    cachePath: await tmpCache(),
    fetchImpl,
    log: silent,
  });
  const lines = await search.lookup("Blue Bottle & Co");
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, "http://searx.test/search?q=Blue%20Bottle%20%26%20Co&format=json");
  assert.deepEqual(lines, [
    "- Blue Bottle Coffee: Specialty coffee roaster",
    `- Menu: ${"x".repeat(200)}`,
  ]);
});

test("an empty result list is not cached (SearXNG answers 200 + [] when its engines are blocked)", async () => {
  const fetchImpl = fakeFetch({ results: [] });
  const cachePath = await tmpCache();
  const search = createSearch({ url: "http://s", results: 3, cachePath, fetchImpl, log: silent });
  assert.deepEqual(await search.lookup("a"), []);
  assert.deepEqual(await search.lookup("a"), []);
  assert.equal(fetchImpl.calls.length, 2);
  await assert.rejects(fs.access(cachePath));
});

test("SEARCH_RESULTS=0 gives no snippets", async () => {
  const fetchImpl = fakeFetch({ results: [{ title: "T", content: "c" }, { title: "U", content: "d" }] });
  const search = createSearch({ url: "http://s", results: 0, cachePath: await tmpCache(), fetchImpl, log: silent });
  assert.deepEqual(await search.lookup("a"), []);
});

test("skips results without content", async () => {
  const fetchImpl = fakeFetch({
    results: [
      { title: "Empty", content: "" },
      { title: "Missing" },
      { title: "Blank", content: "   " },
      { title: "Good", content: "has text" },
    ],
  });
  const search = createSearch({ url: "http://s", results: 3, cachePath: await tmpCache(), fetchImpl, log: silent });
  assert.deepEqual(await search.lookup("target"), ["- Good: has text"]);
});

test("second lookup of the same query (any case) uses the cache", async () => {
  const fetchImpl = fakeFetch({ results: [{ title: "T", content: "c" }] });
  const cachePath = await tmpCache();
  const search = createSearch({ url: "http://s", results: 3, cachePath, fetchImpl, log: silent });
  const first = await search.lookup("Target");
  const second = await search.lookup("TARGET");
  assert.equal(fetchImpl.calls.length, 1);
  assert.deepEqual(second, first);
  const onDisk = JSON.parse(await fs.readFile(cachePath, "utf8"));
  assert.deepEqual(Object.keys(onDisk), ["target"]);
  assert.deepEqual(onDisk.target.lines, ["- T: c"]);
});

test("cache persists across instances", async () => {
  const fetchImpl = fakeFetch({ results: [{ title: "T", content: "c" }] });
  const cachePath = await tmpCache();
  await createSearch({ url: "http://s", results: 3, cachePath, fetchImpl, log: silent }).lookup("a");
  await createSearch({ url: "http://s", results: 3, cachePath, fetchImpl, log: silent }).lookup("a");
  assert.equal(fetchImpl.calls.length, 1);
});

test("cache older than 30 days is refetched", async () => {
  const fetchImpl = fakeFetch({ results: [{ title: "T", content: "c" }] });
  let t = 1_000_000;
  const search = createSearch({
    url: "http://s", results: 3, cachePath: await tmpCache(), fetchImpl, now: () => t, log: silent,
  });
  await search.lookup("a");
  t += 29 * DAY;
  await search.lookup("a");
  assert.equal(fetchImpl.calls.length, 1);
  t += 2 * DAY;
  await search.lookup("a");
  assert.equal(fetchImpl.calls.length, 2);
});

async function assertFailureYieldsEmpty(fetchImpl, extra = {}) {
  const log = recordingLog();
  const cachePath = await tmpCache();
  const search = createSearch({ url: "http://s", results: 3, cachePath, fetchImpl, log, ...extra });
  assert.deepEqual(await search.lookup("a"), []);
  assert.equal(log.warnings.length, 1);
  await assert.rejects(fs.access(cachePath));
}

test("non-2xx returns [] and logs a warning, nothing cached", async () => {
  await assertFailureYieldsEmpty(async () => new Response("nope", { status: 503 }));
});

test("HTML body returns [] and logs a warning, nothing cached", async () => {
  await assertFailureYieldsEmpty(
    async () => new Response("<html>blocked</html>", { status: 200, headers: { "content-type": "text/html" } }),
  );
});

test("network error returns [] and logs a warning, nothing cached", async () => {
  await assertFailureYieldsEmpty(async () => {
    throw new TypeError("fetch failed");
  });
});

test("timeout returns [] and logs a warning, nothing cached", async () => {
  await assertFailureYieldsEmpty(() => new Promise(() => {}), { timeoutMs: 10 });
});

test("an aborted signal cancels the lookup: [] right away, nothing cached", async () => {
  const controller = new AbortController();
  let seen;
  let started;
  const fetching = new Promise((r) => { started = r; });
  const fetchImpl = (url, opts) => { seen = opts.signal; started(); return new Promise(() => {}); };
  const cachePath = await tmpCache();
  const search = createSearch({ url: "http://s", results: 3, cachePath, fetchImpl, log: silent, timeoutMs: 60000 });
  const pending = search.lookup("a", { signal: controller.signal });
  await fetching;
  controller.abort();
  assert.deepEqual(await pending, []);
  assert.equal(seen.aborted, true);
  await assert.rejects(fs.access(cachePath));
});

test("empty url returns [] without calling fetch", async () => {
  const fetchImpl = fakeFetch({ results: [] });
  const search = createSearch({ url: "", results: 3, cachePath: await tmpCache(), fetchImpl, log: silent });
  assert.deepEqual(await search.lookup("a"), []);
  assert.equal(fetchImpl.calls.length, 0);
});
