/**
 * One categorization run: seeds, then one model decision per remaining payee.
 * See docs/design.md, "How a run works".
 */
import { buildPrompt, parseReply, replySchema } from "./prompt.js";
import { searchQuery } from "./query.js";
import { resolveSeeds } from "./seeds.js";
import { appendLog, saveState } from "./state.js";
import { buildCategoryRule, ruleCoversPayee, selectWork, typicalAmount } from "./select.js";
import { formatSummary } from "./summary.js";
import { LlmError } from "./llm/errors.js";

/**
 * @typedef {{payee: string, category: string, reason: string, source: "model"|"seed"|"mixed", ruleId: string, txnCount: number}} RuleRecord
 * @typedef {{dryRun: boolean, created: RuleRecord[], undecided: Array<{payee: string, error: string}>,
 *   variesLeftAlone: Array<{payee: string, reason: string}>, leftForUserRules: number,
 *   seedProblems: string[], error?: string}} RunResult
 */

const errMsg = (err) => err?.message ?? String(err);

const COVERED = "left alone, a rule for it was made during the run";

/** Model request failures in a row (not invalid replies) after which the run stops. */
const MAX_MODEL_FAILURES = 3;
const STOPPED = "stopped: the container is shutting down";

/** Transactions newest first (stable for equal dates). */
const newestFirst = (txns) => [...txns].sort((a, b) => String(b.date).localeCompare(String(a.date)));

/** Up to 3 distinct non-empty notes, most recent first. */
function rawLinesOf(sorted) {
  const lines = [];
  for (const t of sorted) {
    const n = (t.notes ?? "").trim();
    if (n && !lines.includes(n)) lines.push(n);
    if (lines.length === 3) break;
  }
  return lines;
}

/**
 * @param {{config: object, actual: object, llm: {complete: Function}, search: {lookup: Function},
 *   notify: {enabled?: boolean, send: Function}, guidance: string,
 *   seeds: Array<{payeeName: string, categoryName: string}>, state: {seeded: string[], varies: string[]},
 *   statePath: string, logPath: string, log: {debug: Function, info: Function, warn: Function, error: Function},
 *   signal?: AbortSignal}} deps
 *   signal: when aborted, the current model call is cancelled and the run stops before the next
 *   payee (the payee being written is finished first); state is still saved and the budget closed.
 * @returns {Promise<RunResult>}
 */
export async function runOnce({ config, actual, llm, search, notify, guidance, seeds, state, statePath, logPath, log, signal }) {
  const live = !config.dryRun;
  /** @type {RunResult} */
  const result = { dryRun: !live, created: [], undecided: [], variesLeftAlone: [], leftForUserRules: 0, seedProblems: [] };
  let loaded = false;
  const stopIfAsked = () => {
    if (signal?.aborted) throw new Error(STOPPED);
  };

  /**
   * Creates the rule, categorizes the txns, and writes the audit entry (live), or only records (dry run).
   * Live, it first syncs with the server and re-reads the rules, so a rule you made for this payee
   * while the run was going wins: the payee is then left alone.
   * @returns {Promise<boolean>} false when the payee was skipped because a rule now covers it
   */
  async function apply(payee, category, txns, reason, source) {
    if (!live) {
      result.created.push({ payee: payee.name, category: category.name, reason, source, ruleId: "", txnCount: txns.length });
      return true;
    }
    await actual.sync({ bank: false });
    const rules = await actual.rules();
    if (rules.some((r) => ruleCoversPayee(r, payee.id))) {
      result.leftForUserRules += txns.length;
      return false;
    }
    const ruleId = await actual.createRule(buildCategoryRule(payee.id, category.id));
    // The rule exists now: record it even if categorizing fails part-way (txnCount = actually categorized).
    const record = { payee: payee.name, category: category.name, reason, source, ruleId, txnCount: 0 };
    result.created.push(record);
    if (source === "seed") state.seeded.push(payee.name.toLowerCase());
    try {
      for (const t of txns) {
        // false: categorized or deleted since the budget was loaded, so left alone.
        if (await actual.categorize(t, category.id, config.notesTag)) record.txnCount++;
      }
    } finally {
      appendLog(logPath, { at: new Date().toISOString(), ...record });
    }
    return true;
  }

  try {
    await actual.open();
    if (config.syncBeforeRun) {
      // Bank sync imports transactions into the budget, so a dry run skips it.
      if (!live) log.info("Dry run: bank sync skipped, syncing with the server only");
      await actual.sync({ bank: live });
    }
    const data = await actual.load();
    loaded = true;

    let mixed = null;
    if (config.mixedPayeeCategory) {
      const want = config.mixedPayeeCategory.toLowerCase();
      mixed = data.categories.find((c) => !c.hidden && c.name.toLowerCase() === want) ?? null;
      if (!mixed) {
        throw new Error(
          `MIXED_PAYEE_CATEGORY "${config.mixedPayeeCategory}" is not the name of a visible category in the budget`,
        );
      }
    }

    // Seeds first; they never go to the model.
    const { toCreate, problems } = resolveSeeds(seeds ?? [], data, state);
    result.seedProblems = problems;
    const seededIds = new Set();
    for (const s of toCreate) {
      stopIfAsked();
      await apply(s.payee, s.category, s.txns, "from rules.yaml", "seed");
      seededIds.add(s.payee.id);
    }

    const selected = selectWork(data, {
      skipPayees: config.skipPayees,
      maxPayees: 0,
      knownVaries: new Set(state.varies),
    });
    result.leftForUserRules += selected.leftForUserRules;
    const remaining = selected.work.filter((w) => !seededIds.has(w.payee.id));
    const work = config.maxPayeesPerRun > 0 ? remaining.slice(0, config.maxPayeesPerRun) : remaining;

    let modelFailures = 0;
    for (const { payee, txns } of work) {
      stopIfAsked();
      const started = Date.now();
      const sorted = newestFirst(txns);
      const { cents, isIncome } = typicalAmount(txns);
      let outcome = "not decided";
      let decision;
      try {
        const snippets = await search.lookup(searchQuery(sorted[0].notes, payee.name), { signal });
        const prompt = buildPrompt({
          categories: data.categories,
          guidance,
          payeeName: payee.name,
          rawLines: rawLinesOf(sorted),
          typicalAmount: cents,
          isIncome,
          snippets,
          allowVaries: true,
        });
        log.debug(`Prompt for ${payee.name}:\n${prompt}`);
        const eligible = data.categories.filter((c) => !c.hidden && Boolean(c.isIncome) === isIncome);
        stopIfAsked();
        let raw;
        try {
          raw = await llm.complete(prompt, replySchema(eligible, true), { signal });
          modelFailures = 0;
        } catch (err) {
          if (err instanceof LlmError) modelFailures++;
          throw err;
        }
        log.debug(`Reply for ${payee.name}: ${raw}`);
        decision = parseReply(raw, { categories: data.categories, isIncome, allowVaries: true });
      } catch (err) {
        decision = { kind: "invalid", error: errMsg(err) };
      }
      // A model call cancelled by the stop is not a decision; an answer that arrived is still used.
      if (decision.kind === "invalid") stopIfAsked();

      // Failures past this point are Actual write errors and abort the run.
      if (decision.kind === "category") {
        const category = data.categories.find((c) => c.id === decision.categoryId);
        outcome = (await apply(payee, category, txns, decision.reason, "model")) ? category.name : COVERED;
      } else if (decision.kind === "varies") {
        outcome = "varies";
        // An income payee never goes to an expense category (or the other way round).
        if (mixed && Boolean(mixed.isIncome) === isIncome) {
          if (!(await apply(payee, mixed, txns, decision.reason, "mixed"))) outcome = COVERED;
        } else {
          result.variesLeftAlone.push({ payee: payee.name, reason: decision.reason });
          if (live) state.varies.push(payee.id);
        }
      } else {
        result.undecided.push({ payee: payee.name, error: decision.error });
      }
      log.info(`${payee.name}: ${outcome} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
      if (modelFailures >= MAX_MODEL_FAILURES) throw new Error(`model unreachable: ${decision.error}`);
    }
  } catch (err) {
    result.error = errMsg(err);
    log.error(`Run failed: ${result.error}`);
  } finally {
    if (live && loaded) {
      try {
        saveState(statePath, state);
      } catch (err) {
        log.warn(`Could not save state: ${errMsg(err)}`);
      }
    }
    try {
      await actual.close();
    } catch (err) {
      log.warn(`Could not close the budget cleanly: ${errMsg(err)}`);
    }
  }

  const messages = formatSummary(result);
  if (messages.length) {
    try {
      await notify.send(messages);
    } catch (err) {
      log.warn(`Could not send the summary: ${errMsg(err)}`);
    }
  }
  return result;
}
