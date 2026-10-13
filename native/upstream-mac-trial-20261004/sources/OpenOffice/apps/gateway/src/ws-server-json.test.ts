import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import type { IncomingMessage } from "node:http";
import { readSmallJson } from "./json-body.js";
import { shouldStartFreshProductPlan } from "./ws-server.js";

test("a fresh Lead plan starts only for the current, runnable, unplanned zero-call execution", () => {
  const state = {
    current: true,
    product: { bindingCurrent: true },
    execution: { phase: "planned" },
    native: { phase: "design", plan: null, sessions: [], actions: { canRun: true } },
  };
  assert.equal(shouldStartFreshProductPlan(state), true);
  assert.equal(shouldStartFreshProductPlan({ ...state, current: false }), false);
  assert.equal(shouldStartFreshProductPlan({ ...state, product: { bindingCurrent: false } }), false);
  assert.equal(shouldStartFreshProductPlan({ ...state, execution: { phase: "running" } }), false);
  assert.equal(shouldStartFreshProductPlan({ ...state, native: { ...state.native, phase: "create" } }), false);
  assert.equal(shouldStartFreshProductPlan({ ...state, native: { ...state.native, plan: { text: "old", sha256: "a".repeat(64) } } }), false);
  assert.equal(shouldStartFreshProductPlan({ ...state, native: { ...state.native, sessions: [{ status: "complete" }] } }), false);
  assert.equal(shouldStartFreshProductPlan({ ...state, native: { ...state.native, actions: { canRun: false } } }), false);
});

function requestBody(bytes: number): { raw: string; request: IncomingMessage } {
  const prefix = '{"payload":"', suffix = '"}';
  const raw = prefix + "x".repeat(bytes - Buffer.byteLength(prefix) - Buffer.byteLength(suffix)) + suffix;
  const chunks = [raw.slice(0, 7011), raw.slice(7011, 17003), raw.slice(17003)];
  return { raw, request: Readable.from(chunks.map((chunk) => Buffer.from(chunk))) as IncomingMessage };
}

test("the native inference body contract accepts the observed 22,813-byte request", async () => {
  const { raw, request } = requestBody(22_813);
  assert.equal(Buffer.byteLength(raw), 22_813);
  const parsed = await readSmallJson(request, 64 * 1024);
  assert.equal(typeof parsed.payload, "string");
});

test("the native inference body contract rejects a request above 64 KiB", async () => {
  const { request } = requestBody(64 * 1024 + 1);
  await assert.rejects(readSmallJson(request, 64 * 1024), /Request is too large/);
});
