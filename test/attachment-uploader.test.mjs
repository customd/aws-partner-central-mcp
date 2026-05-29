// Tests for attachment path validation (pure, no network/filesystem).
// Run: node test/attachment-uploader.test.mjs

import assert from "node:assert/strict";
import {
  validateAttachmentPaths,
  AttachmentError,
} from "../server/services/attachment-uploader.js";

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

test("accepts up to 3 files with allowed extensions", () => {
  validateAttachmentPaths(["/x/a.pdf", "/y/b.docx", "/z/c.csv"]);
});

test("accepts mixed-case extensions (PNG, JPEG)", () => {
  validateAttachmentPaths(["/x/a.PNG", "/y/b.Jpeg"]);
});

test("rejects more than 3 files", () => {
  assert.throws(
    () => validateAttachmentPaths(["a.pdf", "b.pdf", "c.pdf", "d.pdf"]),
    (e) => e instanceof AttachmentError && /at most 3/.test(e.message),
  );
});

test("rejects unsupported extension", () => {
  assert.throws(
    () => validateAttachmentPaths(["/x/malware.exe"]),
    (e) => e instanceof AttachmentError && /Unsupported attachment type 'exe'/.test(e.message),
  );
});

test("rejects file with no extension", () => {
  assert.throws(
    () => validateAttachmentPaths(["/x/README"]),
    (e) => e instanceof AttachmentError && /Unsupported attachment type/.test(e.message),
  );
});

test("empty list is allowed (no-op)", () => {
  validateAttachmentPaths([]);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
