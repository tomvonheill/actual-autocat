/**
 * The `check` command: tests every connection and reports what it found.
 * Changes nothing in Actual and never prints secret values.
 */
import { redact } from "./config.js";
import { replySchema } from "./prompt.js";

const OK = "✓";
const BAD = "✗";

/**
 * @param {{config: object, actual: object, llm: {complete: Function}, search: {lookup: Function},
 *   notify: {enabled?: boolean, send: Function}, seeds?: Array<{payeeName: string, categoryName: string}>,
 *   problems?: string[]}} deps
 *   `problems` is the array the search and Telegram loggers push their warnings/errors into; new entries
 *   after a probe are treated as that probe failing (those modules log failures instead of throwing).
 * @returns {Promise<{ok: boolean, lines: string[]}>}
 */
export async function runCheck({ config, actual, llm, search, notify, seeds = [], problems = [] }) {
  const lines = [];
  let ok = true;
  const pass = (text) => lines.push(`${OK} ${text}`);
  const fail = (text) => {
    ok = false;
    lines.push(`${BAD} ${text}`);
  };
  const secrets = [config.actualPassword, config.actualEncryptionPassword, config.llmApiKey, config.telegramBotToken].filter(Boolean);
  const scrub = (s) => secrets.reduce((acc, v) => acc.split(v).join("***"), String(s));
  const errMsg = (err) => scrub(err?.message ?? err);
  /** Warnings/errors logged while fn runs. */
  async function watch(fn) {
    const before = problems.length;
    const value = await fn();
    return { value, logged: problems.slice(before).map(scrub) };
  }

  const summary = Object.entries(redact(config))
    .filter(([k, v]) => v !== "" && v !== null && v !== undefined)
    .map(([k, v]) => `${k}=${v instanceof RegExp ? v.source : v}`)
    .join(", ");
  pass(`Configuration loaded: ${summary}`);

  let data = null;
  try {
    try {
      await actual.open();
      data = await actual.load();
      pass(`Actual: logged in to ${config.actualServerUrl} and downloaded the budget`);
    } catch (err) {
      fail(
        `Actual: ${errMsg(err)}. Check that ACTUAL_SERVER_URL (${config.actualServerUrl}) is reachable from inside ` +
          "the container (localhost there is the container itself), and that @actual-app/api matches your " +
          "server version (rebuild with --build-arg ACTUAL_API_VERSION=<server version>).",
      );
    }
  } finally {
    try {
      await actual.close();
    } catch {
      // nothing useful to add; the budget was only read
    }
  }

  // Model: one tiny request using the real reply schema.
  const first = data?.categories.find((c) => !c.hidden && !c.isIncome);
  if (!data) {
    fail("Model: not tested, the budget could not be loaded (a category is needed for the test request)");
  } else if (!first) {
    fail("Model: not tested, the budget has no visible expense category");
  } else {
    try {
      const prompt = `Reply with the JSON {"category":"${first.id}","reason":"ok"}`;
      const reply = String(await llm.complete(prompt, replySchema([first], false)));
      if (reply.includes(first.id)) pass(`Model: ${config.llmModel} answered`);
      else fail(`Model: ${config.llmModel} answered, but not as asked: ${scrub(reply).slice(0, 200)}`);
    } catch (err) {
      fail(`Model: ${errMsg(err)}`);
    }
  }

  if (!config.searxngUrl) {
    pass("SearXNG: not configured (merchant web search is off)");
  } else {
    const { value, logged } = await watch(() => search.lookup("coffee").catch((err) => {
      problems.push(errMsg(err));
      return [];
    }));
    const why = logged.length ? logged[logged.length - 1] : "";
    if (value.length === 0) {
      fail(
        `SearXNG: ${config.searxngUrl} gave no usable results${why ? ` (${why})` : ""}. If it returned HTML or a ` +
          "403, enable the JSON output in SearXNG's settings.yml: search.formats: [html, json].",
      );
    } else {
      pass(`SearXNG: ${config.searxngUrl} returned ${value.length} result(s)`);
    }
  }

  if (!notify.enabled) {
    pass("Telegram: not configured (no summary messages)");
  } else {
    const { logged } = await watch(() => notify.send(["actual-autocat check: Telegram works"]));
    if (logged.length) fail(`Telegram: could not send the test message (${logged[logged.length - 1]})`);
    else pass("Telegram: test message sent");
  }

  if (data) {
    const visible = (name) => data.categories.some((c) => !c.hidden && c.name.toLowerCase() === name.toLowerCase());
    if (config.mixedPayeeCategory) {
      if (visible(config.mixedPayeeCategory)) pass(`MIXED_PAYEE_CATEGORY "${config.mixedPayeeCategory}" exists`);
      else fail(`MIXED_PAYEE_CATEGORY "${config.mixedPayeeCategory}" is not the name of a visible category in the budget`);
    }
    for (const s of seeds) {
      if (!visible(s.categoryName)) {
        fail(`rules.yaml: no visible category named "${s.categoryName}" (for ${s.payeeName})`);
      }
    }
    if (seeds.length && !lines.some((l) => l.startsWith(`${BAD} rules.yaml`))) {
      pass(`rules.yaml: all ${seeds.length} category name(s) exist`);
    }

    const groups = new Map();
    for (const c of data.categories) {
      if (!groups.has(c.groupName)) groups.set(c.groupName, []);
      groups.get(c.groupName).push(c.hidden ? `${c.name} (hidden)` : c.name);
    }
    pass(`Categories (${data.categories.length}):`);
    for (const [g, names] of groups) lines.push(`    ${g}: ${names.join(", ")}`);
    pass(`${data.transactions.length} uncategorized transaction(s) waiting`);
  }

  return { ok, lines };
}
