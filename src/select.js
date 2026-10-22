/**
 * Work selection: decides which payees still need a decision and builds the
 * Actual rule object for a chosen category.
 */

/**
 * True when the rule sets a category and has a payee condition naming payeeId.
 * Rename rules (set payee) never count.
 * @param {{conditions?: Array<{field: string, value: unknown}>, actions?: Array<{op: string, field: string}>}} rule
 * @param {string} payeeId
 * @returns {boolean}
 */
export function ruleCoversPayee(rule, payeeId) {
  const setsCategory = (rule.actions ?? []).some((a) => a.op === "set" && a.field === "category");
  if (!setsCategory) return false;
  return (rule.conditions ?? []).some(
    (c) => c.field === "payee" && (c.value === payeeId || (Array.isArray(c.value) && c.value.includes(payeeId))),
  );
}

/**
 * @param {{payees: Array<{id: string, name: string}>, rules: object[], transactions: object[]}} data BudgetData
 * @param {{skipPayees: RegExp|null, maxPayees: number, knownVaries: Set<string>}} opts
 * @returns {{work: Array<{payee: {id: string, name: string}, txns: object[]}>, leftForUserRules: number, skipped: number}}
 */
export function selectWork(data, { skipPayees, maxPayees, knownVaries }) {
  const byPayee = new Map();
  for (const t of data.transactions) {
    if (!t.payeeId) continue;
    if (!byPayee.has(t.payeeId)) byPayee.set(t.payeeId, []);
    byPayee.get(t.payeeId).push(t);
  }
  const names = new Map(data.payees.map((p) => [p.id, p]));
  let skipped = 0;
  let leftForUserRules = 0;
  const work = [];
  for (const [id, txns] of byPayee) {
    const payee = names.get(id);
    if (!payee) continue;
    if (skipPayees && skipPayees.test(payee.name)) {
      skipped++;
      continue;
    }
    if (data.rules.some((r) => ruleCoversPayee(r, id))) {
      leftForUserRules += txns.length;
      continue;
    }
    if (knownVaries.has(id)) continue;
    work.push({ payee, txns });
  }
  work.sort((a, b) => b.txns.length - a.txns.length || a.payee.name.localeCompare(b.payee.name));
  return { work: maxPayees > 0 ? work.slice(0, maxPayees) : work, leftForUserRules, skipped };
}

/**
 * Same shape Actual's own category learning creates.
 * @param {string} payeeId
 * @param {string} categoryId
 */
export function buildCategoryRule(payeeId, categoryId) {
  return {
    stage: null,
    conditionsOp: "and",
    conditions: [{ op: "is", field: "payee", value: payeeId }],
    actions: [{ op: "set", field: "category", value: categoryId }],
  };
}

/**
 * Sign by majority (ties count as expense); cents = median absolute amount of that sign.
 * @param {Array<{amount: number}>} txns
 * @returns {{cents: number, isIncome: boolean}}
 */
export function typicalAmount(txns) {
  const income = txns.filter((t) => t.amount > 0).length;
  const isIncome = income > txns.length - income;
  const abs = txns
    .filter((t) => (t.amount > 0) === isIncome)
    .map((t) => Math.abs(t.amount))
    .sort((a, b) => a - b);
  const mid = abs.length >> 1;
  const cents = abs.length % 2 ? abs[mid] : Math.round((abs[mid - 1] + abs[mid]) / 2);
  return { cents, isIncome };
}
