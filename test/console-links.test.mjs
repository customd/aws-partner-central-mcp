// Tests for opportunity-ID linkification (console-links.ts).
// Run: node test/console-links.test.mjs   (build first: npm run build)

import assert from "node:assert/strict";
import { linkifyOpportunities } from "../server/tools/console-links.js";

let pass = 0;
let fail = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    pass += 1;
  } catch (err) {
    console.error(`  FAIL  ${name}\n        ${err.message}`);
    fail += 1;
  }
}

const BASE = "https://us-east-1.console.aws.amazon.com/partnercentral/opportunities";

test("links the three observed ID lengths (7, 8, 10 digits) for the AWS catalog", () => {
  for (const id of ["O7000000", "O2100000", "O1234567890"]) {
    const r = linkifyOpportunities(`See ${id} now.`, "AWS");
    assert.equal(r.text, `See [${id}](${BASE}/${id}) now.`);
    assert.deepEqual(r.links, [{ id, url: `${BASE}/${id}` }]);
  }
});

test("Sandbox catalog emits no links", () => {
  const r = linkifyOpportunities("See O7000000 now.", "Sandbox");
  assert.equal(r.text, "See O7000000 now.");
  assert.deepEqual(r.links, []);
});

test("undefined/unknown catalog emits no links (fail safe)", () => {
  assert.deepEqual(linkifyOpportunities("O7000000", undefined).links, []);
  assert.deepEqual(linkifyOpportunities("O7000000", "Nope").links, []);
});

test("does not double-link an ID already inside a markdown link", () => {
  const input = `[O7000000](${BASE}/O7000000) and O2100000`;
  const r = linkifyOpportunities(input, "AWS");
  // existing link untouched; only the bare second ID linked
  assert.equal(r.text, `[O7000000](${BASE}/O7000000) and [O2100000](${BASE}/O2100000)`);
  assert.deepEqual(r.links, [{ id: "O2100000", url: `${BASE}/O2100000` }]);
});

test("leaves IDs inside inline code / code fences alone", () => {
  const r = linkifyOpportunities("Use `O7000000` in code, but O2100000 in prose.", "AWS");
  assert.equal(
    r.text,
    "Use `O7000000` in code, but [O2100000](" + BASE + "/O2100000) in prose.",
  );
  assert.deepEqual(r.links, [{ id: "O2100000", url: `${BASE}/O2100000` }]);
});

test("no false positives: < 6 digits, or O mid-identifier", () => {
  const r = linkifyOpportunities("O5 and O12345 and FOO7000000 stay literal.", "AWS");
  assert.equal(r.text, "O5 and O12345 and FOO7000000 stay literal.");
  assert.deepEqual(r.links, []);
});

test("de-dupes a repeated ID in the links list but links every occurrence", () => {
  const r = linkifyOpportunities("O7000000 then O7000000 again.", "AWS");
  assert.equal(
    r.text,
    `[O7000000](${BASE}/O7000000) then [O7000000](${BASE}/O7000000) again.`,
  );
  assert.deepEqual(r.links, [{ id: "O7000000", url: `${BASE}/O7000000` }]);
});

test("empty / missing text is safe", () => {
  assert.deepEqual(linkifyOpportunities("", "AWS"), { text: "", links: [] });
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
