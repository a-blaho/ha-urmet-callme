import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { buildToken } from "./token.js";
import { buildBody } from "./query.js";

test("buildToken is sha1(ts$password) lowercase hex", () => {
  const expect = createHash("sha1").update("1700000000$secret").digest("hex");
  assert.equal(buildToken(1700000000, "secret"), expect);
  assert.match(buildToken(1, ""), /^[0-9a-f]{40}$/);
});

test("buildBody produces a version-2 SipRequestMessageBody", () => {
  const body = buildBody({
    typeReq: "open_door_req",
    channel: 3,
    responseUri: "sip:a@h",
    tokenPassword: "pw",
    ts: 1700000000,
    id: 42,
    extra: { data: { id: 7 } },
  });
  assert.deepEqual(body, {
    channel: 3,
    id: 42,
    response_uri: "sip:a@h",
    token: buildToken(1700000000, "pw"),
    ts: 1700000000,
    type: "open_door_req",
    version: 2,
    data: { id: 7 },
  });
});

test("buildBody defaults ts to now and id to a random positive int", () => {
  const before = Math.floor(Date.now() / 1000);
  const body = buildBody({ typeReq: "t", channel: 1, responseUri: "u", tokenPassword: "p" });
  assert.ok((body.ts as number) >= before);
  assert.ok(Number.isInteger(body.id) && (body.id as number) > 0);
});
