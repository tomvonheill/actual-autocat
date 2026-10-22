/**
 * Thin adapter over the official @actual-app/api package. Everything else in the
 * tool sees only the plain objects documented below.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * @typedef {{id: string, name: string, groupName: string, isIncome: boolean, hidden: boolean}} Category
 * @typedef {{id: string, name: string}} Payee
 * @typedef {{id: string, payeeId: string|null, notes: string, amount: number, date: string, accountId: string}} Txn
 * @typedef {{categories: Category[], payees: Payee[], rules: object[], transactions: Txn[]}} BudgetData
 */

const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };

/** Waits between connection attempts while the Actual server starts (about 90 s in all). */
const RETRY_DELAYS_MS = [2000, 4000, 8000, 16000, 30000, 30000];

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** True for failures that mean the server is not accepting connections (yet). */
const isConnectionProblem = (err) =>
  /network-failure|ECONNREFUSED|ECONNRESET|ENOTFOUND|fetch failed/i.test(`${err?.message ?? err} ${err?.cause?.code ?? ""}`);

/** @param {Date} d */
const isoDate = (d) => d.toISOString().slice(0, 10);

/**
 * @param {{actualServerUrl: string, actualPassword: string, actualBudgetId: string,
 *   actualEncryptionPassword?: string, dataDir: string}} config
 * @param {{api?: object, logger?: object, now?: () => Date, sleep?: (ms: number) => Promise<void>}} [deps]
 *   api defaults to the real package; sleep is injectable so tests need not wait
 */
export function createActual(config, { api, logger = noopLogger, now = () => new Date(), sleep = defaultSleep } = {}) {
  let apiPromise = api ? Promise.resolve(api) : null;
  const getApi = () => (apiPromise ??= import("@actual-app/api"));

  return {
    /** Connects to the server and downloads the budget. */
    async open() {
      const a = await getApi();
      const dataDir = join(config.dataDir, "actual-cache");
      mkdirSync(dataDir, { recursive: true });
      for (let attempt = 0; ; attempt++) {
        let initialized = false;
        try {
          await a.init({
            dataDir,
            serverURL: config.actualServerUrl,
            password: config.actualPassword,
          });
          initialized = true;
          await a.downloadBudget(
            config.actualBudgetId,
            config.actualEncryptionPassword ? { password: config.actualEncryptionPassword } : undefined,
          );
          return;
        } catch (err) {
          const delay = RETRY_DELAYS_MS[attempt];
          if (delay === undefined || !isConnectionProblem(err)) {
            logger.error(`Could not open budget on ${config.actualServerUrl}: ${err?.message ?? err}`);
            throw err;
          }
          if (initialized) await a.shutdown().catch(() => {});
          logger.info(`Actual not reachable yet, retrying in ${delay / 1000}s`);
          await sleep(delay);
        }
      }
    },

    /**
     * Bank sync (failures only warn), then sync with the server.
     * @param {{bank?: boolean}} [opts] bank: false skips bank sync (it writes imported
     *   transactions into the budget) and only exchanges changes with the server.
     */
    async sync({ bank = true } = {}) {
      const a = await getApi();
      if (bank) {
        try {
          await a.runBankSync();
        } catch (err) {
          logger.warn(`Bank sync failed, continuing: ${err?.message ?? err}`);
        }
      }
      await a.sync();
    },

    /** @returns {Promise<object[]>} the budget's current rules (after a sync, includes rules made meanwhile). */
    async rules() {
      const a = await getApi();
      return a.getRules();
    },

    /** @returns {Promise<BudgetData>} */
    async load() {
      const a = await getApi();
      const [groups, payees, rules, accounts] = await Promise.all([
        a.getCategoryGroups(),
        a.getPayees(),
        a.getRules(),
        a.getAccounts(),
      ]);

      /** @type {Category[]} */
      const categories = [];
      for (const g of groups) {
        for (const c of g.categories ?? []) {
          categories.push({
            id: c.id,
            name: c.name,
            groupName: g.name,
            isIncome: Boolean(g.is_income),
            hidden: Boolean(c.hidden || g.hidden),
          });
        }
      }

      const end = now();
      end.setFullYear(end.getFullYear() + 1);
      const endDate = isoDate(end);

      /** @type {Txn[]} */
      const transactions = [];
      for (const acct of accounts) {
        if (acct.offbudget || acct.closed) continue;
        const txns = await a.getTransactions(acct.id, "1970-01-01", endDate);
        for (const t of txns) {
          if (t.category || t.transfer_id || t.starting_balance_flag || t.is_parent) continue;
          transactions.push({
            id: t.id,
            payeeId: t.payee ?? null,
            notes: t.notes ?? "",
            amount: t.amount,
            date: t.date,
            accountId: t.account,
          });
        }
      }

      return {
        categories,
        payees: payees.map((p) => ({ id: p.id, name: p.name })),
        rules,
        transactions,
      };
    },

    /** @returns {Promise<string>} the new rule's id */
    async createRule(rule) {
      const a = await getApi();
      const created = await a.createRule(rule);
      return created.id;
    },

    /**
     * Sets the category and appends the notes tag (unless empty or already present).
     * Re-reads the transaction first, so one categorized (or deleted) since the budget was
     * loaded is left alone, and notes edited since then are kept.
     * @param {Txn} txn
     * @returns {Promise<boolean>} true when the transaction was written
     */
    async categorize(txn, categoryId, notesTag) {
      const a = await getApi();
      const { data } = await a.aqlQuery(a.q("transactions").filter({ id: txn.id }).select(["category", "notes"]));
      const current = data?.[0];
      if (!current || current.category) return false;
      const notes = current.notes ?? "";
      const tagged =
        !notesTag || notes.includes(notesTag) ? notes : notes ? `${notes} ${notesTag}` : notesTag;
      await a.updateTransaction(txn.id, { category: categoryId, notes: tagged });
      return true;
    },

    async close() {
      const a = await getApi();
      await a.shutdown();
    },
  };
}
