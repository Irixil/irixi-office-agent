import assert from "node:assert/strict";
import test from "node:test";
import { clientStateErrorStatus } from "./client-state-http.js";

function statusError(status: unknown, message = "controlled client-state failure") {
  return Object.assign(new Error(message), { status });
}

test("client-state preserves validated integration status codes", () => {
  assert.equal(clientStateErrorStatus(statusError(400, "expectedRevision is required")), 400);
  assert.equal(clientStateErrorStatus(statusError(409, "client-state CAS conflict")), 409);
  assert.equal(clientStateErrorStatus(statusError(409, "current binding is stale")), 409);
  assert.equal(clientStateErrorStatus(statusError(413, "state exceeds limit")), 413);
});

test("client-state reports its 64 KiB body overflow as 413", () => {
  assert.equal(clientStateErrorStatus(new Error("Request is too large")), 413);
});

test("client-state malformed or untrusted status values fail closed to 409", () => {
  for (const status of [undefined, null, "400", 399, 600, 418.5, Number.NaN]) {
    assert.equal(clientStateErrorStatus(statusError(status)), 409);
  }
  assert.equal(clientStateErrorStatus("not an error"), 409);
});
