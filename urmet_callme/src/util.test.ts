import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitize, stableUuid } from "./util.js";

test("sanitize keeps [A-Za-z0-9_] and replaces the rest", () => {
  assert.equal(sanitize("urmet_ab-12.x@y z"), "urmet_ab_12_x_y_z");
  assert.equal(sanitize(""), "");
});

test("stableUuid is deterministic and RFC 4122 shaped", () => {
  const a = stableUuid("x");
  assert.equal(a, stableUuid("x"));
  assert.notEqual(a, stableUuid("y"));
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

// These seeds ARE the registrar identity of the running helpers (a changed value means a restart
// adds a binding instead of replacing it, the 1.0.5 bug). Pin the exact outputs.
test("stableUuid seeds used on the wire are pinned", () => {
  assert.equal(stableUuid("urmet-callme:user"), "b2dfa53e-af12-2e1e-0143-5ed0706ad4d0");
  assert.equal(
    stableUuid("urmet-opendoor:user:place1"),
    "06a3a7f5-2773-e405-7224-d551a6e52c24",
  );
});
