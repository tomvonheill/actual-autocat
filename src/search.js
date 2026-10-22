/**
 * Web-search snippets about a merchant, fetched from a SearXNG instance and
 * cached in a JSON file for 30 days. Failures never throw: they log a warning
 * and yield no snippets (and are not cached). Empty results are not cached either.
 */
import fs from "node:fs/promises";
import path from "node:path";

const TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SNIPPET_CHARS = 200;

const noopLog = { debug() {}, info() {}, warn() {}, error() {} };

async function readCache(cachePath, log) {
  try {
    const parsed = JSON.parse(await fs.readFile(cachePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    if (err.code !== "ENOENT") log.warn(`search cache unreadable, starting empty: ${err.message}`);
    return {};
  }
}

async function writeCache(cachePath, cache) {
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  const tmp = `${cachePath}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(cache, null, 2));
  await fs.rename(tmp, cachePath);
}

/**
 * Rejects after ms, or when `signal` aborts, so a fetch that ignores its abort signal
 * still ends.
 */
function timeoutAfter(ms, signal) {
  let timer;
  let onAbort;
  const promise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    onAbort = () => reject(new Error("cancelled"));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  return {
    promise,
    cancel: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

async function fetchSnippets({ url, results, query, fetchImpl, timeoutMs, signal }) {
  const endpoint = `${url}/search?q=${encodeURIComponent(query)}&format=json`;
  const timeout = timeoutAfter(timeoutMs, signal);
  const fetchSignal = signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]) : AbortSignal.timeout(timeoutMs);
  try {
    if (signal?.aborted) throw new Error("cancelled");
    const res = await Promise.race([fetchImpl(endpoint, { signal: fetchSignal }), timeout.promise]);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await Promise.race([res.text(), timeout.promise]);
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error("response was not JSON");
    }
    if (!body || !Array.isArray(body.results)) throw new Error("response had no results array");
    const lines = [];
    for (const r of body.results) {
      if (lines.length >= results) break;
      const content = typeof r?.content === "string" ? r.content.trim() : "";
      if (!content) continue;
      const title = typeof r.title === "string" ? r.title.trim() : "";
      lines.push(`- ${title}: ${content.slice(0, SNIPPET_CHARS).trim()}`);
    }
    return lines;
  } finally {
    timeout.cancel();
  }
}

/**
 * @param {object} opts
 * @param {string} opts.url SearXNG base URL (no trailing slash); empty disables search
 * @param {number} opts.results max snippets per query
 * @param {string} opts.cachePath JSON cache file
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {() => number} [opts.now]
 * @param {number} [opts.timeoutMs]
 * @param {{debug: Function, info: Function, warn: Function, error: Function}} [opts.log]
 * @returns {{ lookup(query: string, opts?: {signal?: AbortSignal}): Promise<string[]> }}
 *   aborting `signal` ends the lookup at once with no snippets
 */
export function createSearch({
  url,
  results,
  cachePath,
  fetchImpl = fetch,
  now = Date.now,
  timeoutMs = 30000,
  log = noopLog,
}) {
  return {
    async lookup(query, { signal } = {}) {
      if (!url) return [];
      const key = query.toLowerCase();
      const cache = await readCache(cachePath, log);
      const hit = cache[key];
      if (hit && Array.isArray(hit.lines) && now() - hit.at <= TTL_MS) return hit.lines;

      let lines;
      try {
        lines = await fetchSnippets({ url, results, query, fetchImpl, timeoutMs, signal });
      } catch (err) {
        log.warn(`search failed for "${query}": ${err.message}`);
        return [];
      }
      // An empty list is often SearXNG with its engines blocked (it still answers 200), so
      // don't keep it for 30 days.
      if (!lines.length) return lines;
      cache[key] = { lines, at: now() };
      try {
        await writeCache(cachePath, cache);
      } catch (err) {
        log.warn(`could not write search cache: ${err.message}`);
      }
      return lines;
    },
  };
}
