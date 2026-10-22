/**
 * Optional rules.yaml: preset payee -> category rules created once, without the model.
 */
import { parse } from "yaml";
import { ConfigError } from "./config.js";
import { ruleCoversPayee } from "./select.js";

/**
 * @param {string} yamlText
 * @returns {Array<{payeeName: string, categoryName: string}>}
 */
export function parseSeeds(yamlText) {
  let doc;
  try {
    doc = parse(yamlText);
  } catch (err) {
    throw new ConfigError(`rules.yaml is not valid YAML: ${err.message}`);
  }
  if (doc == null) return [];
  if (typeof doc !== "object" || Array.isArray(doc)) {
    throw new ConfigError("rules.yaml must be a flat map of payee name: category name");
  }
  return Object.entries(doc).map(([payeeName, categoryName]) => {
    if (typeof categoryName !== "string") {
      throw new ConfigError(`rules.yaml: the category for "${payeeName}" must be a text value`);
    }
    return { payeeName, categoryName };
  });
}

/**
 * @param {Array<{payeeName: string, categoryName: string}>} seeds
 * @param {{categories: object[], payees: object[], rules: object[], transactions: object[]}} data BudgetData
 * @param {{seeded: string[]}} state
 * @returns {{toCreate: Array<{payee: object, category: object, txns: object[]}>, problems: string[]}}
 */
export function resolveSeeds(seeds, data, state) {
  const seeded = new Set(state.seeded);
  const seen = new Set();
  const toCreate = [];
  const problems = [];
  for (const { payeeName, categoryName } of seeds) {
    const key = payeeName.toLowerCase();
    if (seen.has(key)) {
      problems.push(`rules.yaml: ${payeeName} is listed twice (names are matched ignoring case); only the first entry is used`);
      continue;
    }
    seen.add(key);
    if (seeded.has(key)) continue;
    const payee = data.payees.find((p) => p.name.toLowerCase() === key);
    if (!payee) continue; // may show up in a later run
    if (data.rules.some((r) => ruleCoversPayee(r, payee.id))) continue;
    const category = data.categories.find((c) => !c.hidden && c.name.toLowerCase() === categoryName.toLowerCase());
    if (!category) {
      problems.push(`rules.yaml: no category named ${categoryName} (for ${payeeName}); it may be misspelled or hidden`);
      continue;
    }
    toCreate.push({ payee, category, txns: data.transactions.filter((t) => t.payeeId === payee.id) });
  }
  return { toCreate, problems };
}
