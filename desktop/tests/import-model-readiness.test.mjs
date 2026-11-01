import test from "node:test";
import assert from "node:assert/strict";
import { importModelReadiness, importModelReady } from "../src/import-model-readiness.ts";

test("simulated import roles work with no active assembly model", () => {
  const settings = { configured:false, importConfigured:true, importSourceConfigured:true, importTeachingConfigured:true };
  assert.equal(importModelReady(settings), true);
  assert.equal(importModelReadiness(settings).activeConfigured, false);
});
test("simulated completed source resumes teaching without requiring source role", () => {
  const settings = { configured:false, importConfigured:false, importSourceConfigured:false, importTeachingConfigured:true };
  assert.equal(importModelReady(settings), false);
  assert.equal(importModelReady(settings, true), true);
});
test("simulated active assembly setup cannot override incomplete explicit import roles", () => {
  const settings = { configured:true, importConfigured:false, importSourceConfigured:true, importTeachingConfigured:false };
  assert.equal(importModelReady(settings), false);
  assert.equal(importModelReady(settings, true), false);
  assert.equal(importModelReadiness(settings).activeConfigured, true);
});
test("simulated legacy local readiness and absent settings retain prior behavior", () => {
  assert.equal(importModelReady({ configured:true }), true);
  assert.equal(importModelReady({ configured:false }), false);
  assert.equal(importModelReady(null), false);
});
