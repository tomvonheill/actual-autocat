import { test } from "node:test";
import assert from "node:assert/strict";
import { searchQuery } from "../src/query.js";

const cases = [
  ["SQ *BLUE BOTTLE OAKLAND CA", "Blue", "BLUE BOTTLE OAKLAND"],
  ["TST* PIZZA PALACE - DOWNTOWN AUSTIN TX", "P", "PIZZA PALACE DOWNTOWN AUSTIN"],
  ["SHELL OIL 57444 ##123 DENVER CO", "P", "SHELL OIL DENVER"],
  ["ACME UTILITY PAYMENTS PPD ID: 1234567890", "P", "ACME UTILITY PAYMENTS"],
  ["BP##9250465DOWNTOWN QPS BOSTON MA", "P", "BP QPS BOSTON"],
  ["PAYPAL PURCHASE SPOTIFY MEMBER WEB ID: P12345", "P", "SPOTIFY MEMBER"],
  ["Cloud Host Inc SEATTLE WA - Virtual Account Number", "P", "Cloud Host SEATTLE"],
  [null, "Corner Deli", "Corner Deli"],
  ["12345 67890", "X", "X"],
];

for (const [notes, payee, want] of cases) {
  test(`searchQuery(${JSON.stringify(notes)})`, () => {
    assert.equal(searchQuery(notes, payee), want);
  });
}
