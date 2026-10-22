import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPrompt, replySchema, parseReply } from "../src/prompt.js";

const categories = [
  { id: "c-groc", name: "Groceries", groupName: "Food", isIncome: false, hidden: false },
  { id: "c-rest", name: "Restaurants", groupName: "Food", isIncome: false, hidden: false },
  { id: "c-old", name: "Old Stuff", groupName: "Misc", isIncome: false, hidden: true },
  { id: "c-pay", name: "Paycheck", groupName: "Income", isIncome: true, hidden: false },
];

const base = {
  categories,
  guidance: "",
  payeeName: "Corner Deli",
  rawLines: ["CORNER DELI 123"],
  typicalAmount: 1234,
  isIncome: false,
  snippets: [],
  allowVaries: false,
};

const CAVEAT =
  "Web search results for this merchant (may be incomplete or about a different business with a similar name; use them only to learn what kind of business it is):";

test("buildPrompt lists only categories of the right kind and not hidden ones", () => {
  const p = buildPrompt(base);
  assert.match(p, /\* Groceries \(ID: "c-groc"\)/);
  assert.match(p, /\* Restaurants \(ID: "c-rest"\)/);
  assert.doesNotMatch(p, /c-old/);
  assert.doesNotMatch(p, /c-pay/);
  const income = buildPrompt({ ...base, isIncome: true });
  assert.match(income, /c-pay/);
  assert.doesNotMatch(income, /c-groc/);
  assert.match(income, /Income/);
});

test("buildPrompt groups categories by group name", () => {
  const p = buildPrompt(base);
  assert.match(p, /Food\n\* Groceries[^\n]*\n\* Restaurants/);
});

test("buildPrompt omits the search block when there are no snippets, includes it before the transaction when there are", () => {
  assert.doesNotMatch(buildPrompt(base), /Web search results/);
  const snippet = "- Corner Deli: A deli in town.";
  const p = buildPrompt({ ...base, snippets: [snippet, "- Other: more text"] });
  assert.ok(p.includes(CAVEAT));
  assert.equal(p.split(snippet).length - 1, 1);
  assert.ok(p.includes(`${CAVEAT}\n${snippet}\n- Other: more text`));
  assert.doesNotMatch(p, /\* - /);
  assert.ok(p.indexOf(CAVEAT) < p.indexOf("Corner Deli"));
});

test("buildPrompt includes guidance only when non-empty", () => {
  assert.doesNotMatch(buildPrompt(base), /MY-GUIDANCE/);
  assert.match(buildPrompt({ ...base, guidance: "MY-GUIDANCE" }), /MY-GUIDANCE/);
});

test("buildPrompt includes at most 3 distinct raw lines", () => {
  const p = buildPrompt({ ...base, rawLines: ["AAA", "BBB", "AAA", "CCC", "DDD"] });
  assert.equal(p.match(/AAA/g).length, 1);
  assert.match(p, /BBB/);
  assert.match(p, /CCC/);
  assert.doesNotMatch(p, /DDD/);
});

test("buildPrompt formats 1234 cents as 12.34 and labels the kind", () => {
  assert.match(buildPrompt(base), /12\.34/);
  assert.match(buildPrompt(base), /Expense/);
  assert.match(buildPrompt({ ...base, isIncome: true }), /Income\s*$/);
});

test('buildPrompt mentions "varies" only when allowVaries', () => {
  assert.doesNotMatch(buildPrompt(base), /varies/);
  assert.match(buildPrompt({ ...base, allowVaries: true }), /"varies"/);
});

test("buildPrompt puts the transaction last", () => {
  const p = buildPrompt({ ...base, allowVaries: true, snippets: ["- x: y"], guidance: "MY-GUIDANCE" });
  const t = p.indexOf("Corner Deli");
  assert.ok(t >= 0);
  for (const marker of ['"varies"', "Web search results", "MY-GUIDANCE"]) {
    const i = p.indexOf(marker);
    assert.ok(i >= 0 && i < t, marker);
  }
});

test("replySchema is plain JSON schema with category enum", () => {
  const s = replySchema(categories, false);
  assert.equal(s.type, "object");
  assert.equal(s.additionalProperties, false);
  assert.deepEqual(s.required, ["category", "reason"]);
  assert.deepEqual(s.properties.category.enum, ["c-groc", "c-rest", "c-old", "c-pay"]);
  assert.equal(s.properties.reason.type, "string");
  assert.deepEqual(replySchema(categories, true).properties.category.enum.at(-1), "varies");
});

const ctx = { categories, isIncome: false, allowVaries: false };

test('parseReply accepts {"category":"<id>","reason":"r"}', () => {
  assert.deepEqual(parseReply('{"category":"c-groc","reason":"r"}', ctx), {
    kind: "category",
    categoryId: "c-groc",
    reason: "r",
  });
});

test("parseReply finds the JSON object inside prose or a code fence", () => {
  const want = { kind: "category", categoryId: "c-rest", reason: "a {tricky} reason" };
  const json = '{"category":"c-rest","reason":"a {tricky} reason"}';
  assert.deepEqual(parseReply(`Sure! Here you go: ${json} Hope that helps.`, ctx), want);
  assert.deepEqual(parseReply("```json\n" + json + "\n```", ctx), want);
});

test("parseReply ignores a <think>…</think> block before the JSON", () => {
  const text = '<think>maybe {"category":"c-rest","reason":"x"} or not</think>\n{"category":"c-groc","reason":"y"}';
  assert.deepEqual(parseReply(text, ctx), { kind: "category", categoryId: "c-groc", reason: "y" });
});

test("parseReply rejects an unknown id, an income category for an expense and a hidden category", () => {
  for (const id of ["nope", "c-pay", "c-old"]) {
    const d = parseReply(JSON.stringify({ category: id, reason: "r" }), ctx);
    assert.equal(d.kind, "invalid", id);
    assert.equal(typeof d.error, "string");
  }
  assert.equal(parseReply('{"category":"c-groc","reason":"r"}', { ...ctx, isIncome: true }).kind, "invalid");
});

test('parseReply "varies" is allowed only when allowVaries', () => {
  const text = '{"category":"varies","reason":"marketplace"}';
  assert.deepEqual(parseReply(text, { ...ctx, allowVaries: true }), { kind: "varies", reason: "marketplace" });
  assert.equal(parseReply(text, ctx).kind, "invalid");
});

test("parseReply with no JSON, bad JSON or a missing category is invalid", () => {
  for (const t of ["", "I think groceries.", "{not json}", '{"reason":"r"}', '{"category":5}']) {
    assert.equal(parseReply(t, ctx).kind, "invalid", t);
  }
});

test("parseReply tolerates a missing reason", () => {
  assert.deepEqual(parseReply('{"category":"c-groc"}', ctx), { kind: "category", categoryId: "c-groc", reason: "" });
});
