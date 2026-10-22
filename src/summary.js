/**
 * Turns a RunResult into plain-text chat messages (see docs/design.md, "Summary message").
 */

const MAX_LEN = 4096;

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function bullet(r) {
  let reason = r.reason;
  if (r.source === "seed") reason = "from rules.yaml";
  else if (r.source === "mixed") reason = `varies, ${r.reason}`;
  return `• ${r.payee} → ${r.category}: ${reason} (${r.txnCount})`;
}

/** Split text longer than MAX_LEN into pieces, preferring to break at a space. */
function hardSplit(line) {
  const parts = [];
  let rest = line;
  while (rest.length > MAX_LEN) {
    let cut = rest.lastIndexOf(" ", MAX_LEN);
    if (cut < MAX_LEN / 2) cut = MAX_LEN;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^ /, "");
  }
  parts.push(rest);
  return parts;
}

/** Pack lines into messages of at most MAX_LEN characters, splitting on line boundaries. */
function pack(lines) {
  const messages = [];
  let current = "";
  for (const line of lines.flatMap(hardSplit)) {
    if (current && current.length + 1 + line.length > MAX_LEN) {
      messages.push(current);
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current) messages.push(current);
  return messages;
}

/**
 * @param {import("./run.js").RunResult} result
 * @returns {string[]} messages to send; empty when there is nothing to report.
 *   A run whose only finding is untouched transactions (leftForUserRules) is not worth a message.
 *   A failed run starts with the failure line, followed by whatever it did before failing.
 */
export function formatSummary(result) {
  const lines = reportLines(result);
  if (result.error) lines.unshift(`Budget autocat failed: ${result.error}`);
  return lines.length ? pack(lines) : [];
}

/** The run's report lines without the failure line; empty when there is nothing to report. */
function reportLines(result) {
  const { dryRun, created, undecided, variesLeftAlone, leftForUserRules, seedProblems } = result;
  if (!created.length && !undecided.length && !variesLeftAlone.length && !seedProblems.length) return [];

  const txns = created.reduce((sum, r) => sum + r.txnCount, 0);
  const lines = [
    dryRun
      ? `DRY RUN: Budget: would create ${plural(created.length, "new rule", "new rules")}, would categorize ${plural(txns, "transaction", "transactions")}`
      : `Budget: ${plural(created.length, "new rule", "new rules")}, ${txns} ${txns === 1 ? "transaction" : "transactions"} categorized`,
    ...created.map(bullet),
  ];
  if (undecided.length) {
    lines.push(`Not decided: ${undecided.length}: ${undecided.map((u) => `${u.payee} (${u.error})`).join(", ")}`);
  }
  if (variesLeftAlone.length) {
    lines.push(`Varies, left alone: ${variesLeftAlone.map((v) => v.payee).join(", ")}`);
  }
  if (leftForUserRules > 0) {
    lines.push(`Left for your rules: ${plural(leftForUserRules, "transaction", "transactions")}`);
  }
  for (const p of seedProblems) lines.push(`Seed problem: ${p}`);
  if (created.length) lines.push("Fix a rule in Actual → Rules.");
  return lines;
}
