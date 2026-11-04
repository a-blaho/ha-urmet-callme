import { test } from "node:test";
import assert from "node:assert/strict";
import { camFifos, sanitize, sipUri, stableUuid } from "./util.js";

test("camFifos names the pair stream.sh is handed for camera i", () => {
  assert.deepEqual(camFifos(0), { h264: "/tmp/urmet_cam_0.h264", pcm: "/tmp/urmet_cam_0.pcm" });
  assert.deepEqual(camFifos(3), { h264: "/tmp/urmet_cam_3.h264", pcm: "/tmp/urmet_cam_3.pcm" });
});

test("sanitize keeps [A-Za-z0-9_] and replaces the rest", () => {
  assert.equal(sanitize("urmet_ab-12.x@y z"), "urmet_ab_12_x_y_z");
  assert.equal(sanitize(""), "");
});

// A gateway may answer with or without the scheme; either way the URI carries it exactly once.
test("sipUri adds the scheme only when the address lacks one", () => {
  assert.equal(sipUri("1060abc@sip.urmet.com"), "sip:1060abc@sip.urmet.com");
  assert.equal(sipUri("sip:1060abc@sip.urmet.com"), "sip:1060abc@sip.urmet.com");
  assert.equal(sipUri("SIPS:1060abc@sip.urmet.com"), "SIPS:1060abc@sip.urmet.com");
  assert.equal(sipUri(" sip:1060abc@sip.urmet.com "), "sip:1060abc@sip.urmet.com");
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
  // The recv seeds (video.ts: the shared account B; video2voice.ts: channel account + place) used to
  // go through a duplicate of this function in video.ts; same recipe, so the same bindings.
  assert.equal(stableUuid("urmet-recv:userB"), "f86eb632-e31d-57c9-b963-5270befc26cb");
  assert.equal(stableUuid("urmet-recv:user:place1"), "0bf72356-9f74-9992-222f-807a54ae0dd3");
});
