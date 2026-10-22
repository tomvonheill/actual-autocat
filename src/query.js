/**
 * Turns a raw bank line into a web-search query by stripping processor
 * prefixes, reference numbers, and trailing state codes.
 */

const PREFIX = /^\s*(?:TST\*|SQ \*|SP \*|PY \*|PAYPAL PURCHASE|PAYPAL \*|DD \*|IC\* )/i;
const CUTS = [" - Virtual Account Number", " PPD ID:", " WEB ID:", " WEB PMTS"].map((s) => s.toLowerCase());
const DROP = new Set(["USA", "LLC", "INC", "INC.", "-", "@", "/"]);

/**
 * @param {string|null} notes raw bank line (transaction notes)
 * @param {string} payeeName fallback when nothing usable remains
 * @returns {string}
 */
export function searchQuery(notes, payeeName) {
  let s = String(notes ?? "").replace(PREFIX, "");
  const lower = s.toLowerCase();
  const cut = Math.min(...CUTS.map((c) => (lower.indexOf(c) === -1 ? Infinity : lower.indexOf(c))));
  if (cut !== Infinity) s = s.slice(0, cut);
  const tokens = s
    .split(/[\s*#]+/)
    .filter((t) => t && !/\d/.test(t) && !DROP.has(t.toUpperCase()));
  while (tokens.length > 1 && /^[A-Z]{2}$/.test(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join(" ") || payeeName;
}
