import { test } from "node:test";
import assert from "node:assert/strict";
import { parseResult, sanitize, stableUuid } from "./util.js";

// Both helpers' tone replies must parse, whatever surrounds the RESULT token.
test("parseResult reads opendoor's and recv's RESULT lines", () => {
  assert.deepEqual(parseResult("[opendoor] RESULT 1 ok"), { digit: "1", ok: true });
  assert.deepEqual(parseResult("2026-09-23T10:00:00.123Z [recv] RESULT 2 ok"), {
    digit: "2",
    ok: true,
  });
  assert.deepEqual(parseResult("2026-09-23T10:00:00.123Z [recv] RESULT 1 fail (no call up)"), {
    digit: "1",
    ok: false,
  });
  assert.equal(parseResult("[opendoor] sent DTMF '1' (status 0)"), null);
  assert.equal(parseResult("RESULT 4 ok"), null); // only door/gate digits are tone results
});

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
