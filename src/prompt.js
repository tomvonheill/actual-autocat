/**
 * Builds the one-merchant categorization prompt and validates the model's
 * JSON reply. Pure functions; no I/O.
 */

const MAX_RAW_LINES = 3;

const SEARCH_INTRO =
  "Web search results for this merchant (may be incomplete or about a different business with a similar name; use them only to learn what kind of business it is):";

/** Categories the model may choose for this kind of transaction. */
function eligible(categories, isIncome) {
  return categories.filter((c) => !c.hidden && Boolean(c.isIncome) === isIncome);
}

function groupLines(categories) {
  const groups = new Map();
  for (const c of categories) {
    if (!groups.has(c.groupName)) groups.set(c.groupName, []);
    groups.get(c.groupName).push(`* ${c.name} (ID: "${c.id}")`);
  }
  return [...groups].map(([name, lines]) => [name, ...lines].join("\n"));
}

/**
 * @param {{categories: object[], guidance: string, payeeName: string,
 *   rawLines: string[], typicalAmount: number, isIncome: boolean,
 *   snippets: string[], allowVaries: boolean}} input typicalAmount is absolute cents
 * @returns {string}
 */
export function buildPrompt({ categories, guidance, payeeName, rawLines, typicalAmount, isIncome, snippets, allowVaries }) {
  const parts = [
    `Pick the single best budget category for this ${isIncome ? "income" : "expense"} merchant.`,
    "Categories by group:\n" + groupLines(eligible(categories, isIncome)).join("\n"),
  ];
  if (guidance && guidance.trim()) parts.push(guidance.trim());
  if (allowVaries) {
    parts.push(
      'If the merchant has no single category (marketplaces, general stores, payment apps, cash withdrawals), answer "varies".'
    );
  }
  if (snippets && snippets.length) {
    parts.push([SEARCH_INTRO, ...snippets].join("\n"));
  }
  parts.push(
    'Respond with ONLY a JSON object, no other text: {"category": "<category ID' +
      (allowVaries ? ' or varies' : "") +
      '>", "reason": "<one short line>"}'
  );
  const lines = [...new Set(rawLines)].slice(0, MAX_RAW_LINES);
  parts.push(
    [
      "Transaction:",
      `* Payee: ${payeeName}`,
      ...lines.map((l) => `* Bank text: ${l}`),
      `* Typical amount: ${(typicalAmount / 100).toFixed(2)}`,
      `* Type: ${isIncome ? "Income" : "Expense"}`,
    ].join("\n")
  );
  return parts.join("\n\n");
}

/**
 * JSON schema for the reply, in plain JSON Schema for OpenAI-compatible and
 * Anthropic structured output.
 * @param {object[]} categories
 * @param {boolean} allowVaries
 */
export function replySchema(categories, allowVaries) {
  const ids = categories.map((c) => c.id);
  return {
    type: "object",
    properties: {
      category: { type: "string", enum: allowVaries ? [...ids, "varies"] : ids },
      reason: { type: "string" },
    },
    required: ["category", "reason"],
    additionalProperties: false,
  };
}

/** Every top-level balanced {...} slice of text, string-aware. */
function* objectSlices(text) {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"' && depth > 0) {
      inString = true;
    } else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" && depth > 0) {
      depth--;
      if (depth === 0) yield text.slice(start, i + 1);
    }
  }
}

function extractReply(text) {
  const stripped = text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/^[\s\S]*<\/think>/i, "");
  for (const slice of objectSlices(stripped)) {
    try {
      const obj = JSON.parse(slice);
      if (obj && typeof obj === "object" && typeof obj.category === "string") return obj;
    } catch {
      // not JSON; keep looking
    }
  }
  return null;
}

/**
 * @param {string} text raw model output
 * @param {{categories: object[], isIncome: boolean, allowVaries: boolean}} ctx
 * @returns {{kind: "category", categoryId: string, reason: string} | {kind: "varies", reason: string} | {kind: "invalid", error: string}}
 */
export function parseReply(text, { categories, isIncome, allowVaries }) {
  const reply = extractReply(String(text ?? ""));
  if (!reply) return { kind: "invalid", error: "no JSON object with a category in the reply" };
  const reason = typeof reply.reason === "string" ? reply.reason : "";
  const id = reply.category;
  if (id === "varies") {
    return allowVaries ? { kind: "varies", reason } : { kind: "invalid", error: '"varies" is not allowed here' };
  }
  const cat = categories.find((c) => c.id === id);
  if (!cat) return { kind: "invalid", error: `unknown category id "${id}"` };
  if (cat.hidden) return { kind: "invalid", error: `category "${id}" is hidden` };
  if (Boolean(cat.isIncome) !== isIncome) {
    return { kind: "invalid", error: `category "${id}" is ${cat.isIncome ? "an income" : "an expense"} category` };
  }
  return { kind: "category", categoryId: id, reason };
}
