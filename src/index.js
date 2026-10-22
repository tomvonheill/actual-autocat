/**
 * Entry point. `node src/index.js` runs the scheduler; `run` does one run now;
 * `check` tests every connection.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Cron as RealCron } from "croner";
import { ConfigError, loadConfig } from "./config.js";
import { createActual } from "./actual.js";
import { createLlm } from "./llm/index.js";
import { createSearch } from "./search.js";
import { createTelegram } from "./notify/telegram.js";
import { loadState } from "./state.js";
import { parseSeeds } from "./seeds.js";
import { runOnce } from "./run.js";
import { formatSummary } from "./summary.js";
import { runCheck } from "./check.js";

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

/**
 * Console logger with ISO timestamps; warn and error go to stderr.
 * @param {string} level minimum level to print
 * @param {{out?: (line: string) => void, err?: (line: string) => void}} [sinks]
 */
export function createLogger(level, { out = console.log, err = console.error } = {}) {
  const min = LEVELS[level] ?? LEVELS.info;
  const make = (name, write) => (msg) => {
    if (LEVELS[name] >= min) write(`${new Date().toISOString()} ${name.toUpperCase()} ${msg}`);
  };
  return { debug: make("debug", out), info: make("info", out), warn: make("warn", err), error: make("error", err) };
}

/**
 * Runs `task` on the configured cron schedule. A tick that fires while the
 * previous run is still going is skipped.
 * @param {{schedule: string, tz: string}} config
 * @param {(signal: AbortSignal) => Promise<unknown>} task the signal aborts when shutdown() is called
 * @param {{Cron?: new (pattern: string, opts: object, fn: () => void) => {stop(): void},
 *   log?: {info: Function, error: Function}}} [deps]
 * @returns {{stop(): void, runNow(): Promise<void>, shutdown(): Promise<void>}} runNow goes through the
 *   same overlap guard; shutdown stops the schedule, asks a run in progress to stop and waits for it
 */
export function createScheduler(config, task, { Cron = RealCron, log = createLogger("info") } = {}) {
  let current = null;
  let stopping = false;
  const tick = async () => {
    if (stopping) return;
    if (current) {
      log.info("previous run still going, skipping");
      return;
    }
    const controller = new AbortController();
    const done = (async () => {
      try {
        await task(controller.signal);
      } catch (err) {
        log.error(`Run failed: ${err?.message ?? err}`);
      }
    })();
    current = { controller, done };
    try {
      await done;
    } finally {
      current = null;
    }
  };
  let job;
  try {
    job = new Cron(config.schedule, { timezone: config.tz }, tick);
  } catch (err) {
    throw new ConfigError(`SCHEDULE "${config.schedule}" with TZ "${config.tz}" is not valid: ${err?.message ?? err}`);
  }
  return {
    stop: () => job.stop(),
    runNow: tick,
    async shutdown() {
      stopping = true;
      job.stop();
      if (current) {
        current.controller.abort();
        await current.done;
      }
    },
  };
}

function readOptional(path, fallback) {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw err;
  }
}

const rulesPath = (config) => join(config.configDir, "rules.yaml");
const seedsOf = (config) => parseSeeds(readOptional(rulesPath(config), ""));

/** Runs fn; an error becomes `could not read <path>: <message>`. */
function reading(path, fn) {
  try {
    return fn();
  } catch (err) {
    throw new Error(`could not read ${path}: ${err?.message ?? err}`);
  }
}

/**
 * One full run, loading state, guidance and seeds fresh. The signal asks a run in progress to stop.
 * An unreadable state.json, guidance.md or rules.yaml is a failed run, reported like any other.
 * @param {{notify?: {enabled?: boolean, send: Function}}} [deps] notify defaults to Telegram
 * @returns {(signal?: AbortSignal) => Promise<import("./run.js").RunResult>}
 */
export function makeRunTask(config, log, deps = {}) {
  return async (signal) => {
    const notify = deps.notify ?? createTelegram(config, globalThis.fetch, log);
    const statePath = join(config.dataDir, "state.json");
    const guidancePath = join(config.configDir, "guidance.md");
    let state, guidance, seeds;
    try {
      state = reading(statePath, () => loadState(statePath));
      guidance = reading(guidancePath, () => readOptional(guidancePath, ""));
      seeds = reading(rulesPath(config), () => seedsOf(config));
    } catch (err) {
      /** @type {import("./run.js").RunResult} */
      const result = {
        dryRun: config.dryRun, created: [], undecided: [], variesLeftAlone: [], leftForUserRules: 0, seedProblems: [],
        error: err.message,
      };
      log.error(`Run failed: ${result.error}`);
      try {
        await notify.send(formatSummary(result));
      } catch (sendErr) {
        log.warn(`Could not send the summary: ${sendErr?.message ?? sendErr}`);
      }
      return result;
    }
    return runOnce({
      config,
      actual: createActual(config, { logger: log }),
      llm: createLlm(config),
      search: createSearch({
        url: config.searxngUrl,
        results: config.searchResults,
        cachePath: join(config.dataDir, "search-cache.json"),
        log,
      }),
      notify,
      guidance,
      seeds,
      state,
      statePath,
      logPath: join(config.dataDir, "rules-created.jsonl"),
      log,
      signal,
    });
  };
}

/**
 * Actual for `check`: downloads the budget into a throwaway folder, so it never shares
 * data/actual-cache with a scheduled run that may be going on.
 * @param {{api?: object}} [deps]
 * @returns {{actual: object, cleanup(): void}}
 */
export function createCheckActual(config, log, { api } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "autocat-check-actual-"));
  return {
    actual: createActual({ ...config, dataDir: dir }, { api, logger: log }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * Search for `check`: a throwaway cache, so the probe always contacts SearXNG
 * and never reads or writes the live cache.
 * @returns {{search: object, cleanup(): void}}
 */
export function createCheckSearch(config, log, fetchImpl = globalThis.fetch) {
  const dir = mkdtempSync(join(tmpdir(), "autocat-check-"));
  return {
    search: createSearch({
      url: config.searxngUrl,
      results: config.searchResults,
      cachePath: join(dir, "search-cache.json"),
      fetchImpl,
      log,
    }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

async function check(config) {
  const problems = [];
  const sink = { debug() {}, info() {}, warn: (m) => problems.push(m), error: (m) => problems.push(m) };
  const { search, cleanup } = createCheckSearch(config, sink);
  const checkActual = createCheckActual(config, sink);
  let ok, lines;
  try {
    ({ ok, lines } = await runCheck({
      config,
      actual: checkActual.actual,
      llm: createLlm(config),
      search,
      notify: createTelegram(config, globalThis.fetch, sink),
      seeds: seedsOf(config),
      problems,
    }));
  } finally {
    cleanup();
    checkActual.cleanup();
  }
  console.log(lines.join("\n"));
  return ok ? 0 : 1;
}

/**
 * On the first SIGTERM/SIGINT calls `stop` (a run in progress then stops before its next payee,
 * saves state and closes the budget); a second signal exits at once. Explicit because node runs
 * as PID 1 in the container, where signals without a handler are ignored.
 */
function onStopSignal(log, stop) {
  let received = 0;
  const handler = (sig) => {
    if (++received > 1) process.exit(1);
    log.info(`${sig} received, stopping after the current payee`);
    stop();
  };
  process.on("SIGTERM", handler);
  process.on("SIGINT", handler);
}

/** @returns {Promise<number|undefined>} exit code, or undefined to keep running */
async function main(argv, env) {
  const command = argv[0];
  if (command !== undefined && command !== "run" && command !== "check") {
    console.error(`Unknown command "${command}". Use: run, check, or no command to start the scheduler.`);
    return 2;
  }
  const config = loadConfig(env);
  const log = createLogger(config.logLevel);

  if (command === "check") return check(config);

  const task = makeRunTask(config, log);
  if (command === "run" || config.schedule === "") {
    const controller = new AbortController();
    onStopSignal(log, () => controller.abort());
    const result = await task(controller.signal);
    return result.error ? 1 : 0;
  }

  const scheduler = createScheduler(config, task, { log });
  log.info(`Scheduled "${config.schedule}" (${config.tz})`);
  onStopSignal(log, async () => {
    await scheduler.shutdown();
    process.exit(0);
  });
  if (config.runOnStart) await scheduler.runNow();
  return undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), process.env).then(
    (code) => {
      if (code !== undefined) process.exit(code);
    },
    (err) => {
      if (err instanceof ConfigError) console.error(`Configuration error: ${err.message}`);
      else console.error(err?.stack ?? err);
      process.exit(1);
    },
  );
}
