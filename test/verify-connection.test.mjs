// Pins the LOAD-BEARING verify_connection probe interpretation:
//   - any processed, non-auth, non-access reply  -> "healthy" (proves SSO+SigV4+reach)
//   - auth / access failures                     -> "failed"  (real setup problem)
//   - network / 5xx / internal-error            -> "transient" (reached/retried, retry later)
// In particular: "healthy" must NOT be keyed on a specific not-found code, so a
// future change to the endpoint's not-found code can't regress it to "failed".
// Run: node test/verify-connection.test.mjs
import assert from "node:assert/strict";
import { classifyVerifyError } from "../server/tools/index.js";
import { PartnerCentralError } from "../server/services/partner-central-client.js";
import { ERROR_CODE } from "../server/constants.js";

let pass = 0;
let fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); pass += 1; }
  catch (err) { console.error(`  FAIL  ${name}\n        ${err.message}`); fail += 1; }
}

const pcErr = (o) =>
  new PartnerCentralError(o.message ?? "x", o.code, o.httpStatus, undefined, o.isNetworkError ?? false);

test("session-not-found (RESOURCE_NOT_FOUND) → healthy", () => {
  assert.equal(
    classifyVerifyError(pcErr({ code: ERROR_CODE.RESOURCE_NOT_FOUND, httpStatus: 200, message: "not found" })),
    "healthy",
  );
});

test("a DIFFERENT not-found code (-32602) → healthy (not keyed on a specific code)", () => {
  assert.equal(
    classifyVerifyError(pcErr({ code: -32602, httpStatus: 200, message: "Session ... not found" })),
    "healthy",
  );
});

test("rate-limited (LIMIT_EXCEEDED) still proves connectivity → healthy", () => {
  assert.equal(classifyVerifyError(pcErr({ code: ERROR_CODE.LIMIT_EXCEEDED, httpStatus: 200 })), "healthy");
});

test("auth failure (AUTHENTICATION_FAILURE) → failed", () => {
  assert.equal(classifyVerifyError(pcErr({ code: ERROR_CODE.AUTHENTICATION_FAILURE, httpStatus: 200 })), "failed");
});

test("HTTP 403 → failed", () => {
  assert.equal(classifyVerifyError(pcErr({ httpStatus: 403 })), "failed");
});

test("access denied (ACCESS_DENIED) → failed", () => {
  assert.equal(classifyVerifyError(pcErr({ code: ERROR_CODE.ACCESS_DENIED, httpStatus: 200 })), "failed");
});

test("network error → transient", () => {
  assert.equal(classifyVerifyError(pcErr({ isNetworkError: true })), "transient");
});

test("internal server error (INTERNAL_ERROR) → transient", () => {
  assert.equal(classifyVerifyError(pcErr({ code: ERROR_CODE.INTERNAL_ERROR, httpStatus: 200 })), "transient");
});

test("HTTP 503 → transient", () => {
  assert.equal(classifyVerifyError(pcErr({ httpStatus: 503 })), "transient");
});

test("non-PartnerCentralError → failed", () => {
  assert.equal(classifyVerifyError(new Error("boom")), "failed");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
