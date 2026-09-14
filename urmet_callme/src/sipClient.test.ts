import { test } from "node:test";
import assert from "node:assert/strict";
import { callerName, uriUser } from "./sipClient.js";

test("callerName formats display name + uri", () => {
  assert.equal(
    callerName('"Panel 1" <sip:cfw_abc@sip.urmet.com>;tag=1'),
    "Panel 1 (sip:cfw_abc@sip.urmet.com)",
  );
  assert.equal(callerName("<sip:x@h>"), "sip:x@h");
  assert.equal(callerName("sip:x@h"), "sip:x@h");
});

test("uriUser extracts the user part, ignoring params", () => {
  assert.equal(uriUser('"Panel" <sip:00_1E_E0_03_38_F8@sip.urmet.com;transport=tls>'), "00_1E_E0_03_38_F8");
  assert.equal(uriUser("<SIP:abc@h>"), "abc");
  assert.equal(uriUser("nonsense"), "");
});
