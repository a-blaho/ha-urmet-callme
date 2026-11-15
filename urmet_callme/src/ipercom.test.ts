import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDoors } from "./ipercom.js";
import { compareVersions, familyOf, twoVoiceDoorRequests, twoVoiceGroupOf } from "./place.js";

test("compareVersions compares like the app: numbers split on any non-digit", () => {
  assert.equal(compareVersions("1.5.0-13", "1.5.0-13"), 0);
  assert.equal(compareVersions("1.5.0_13", "1.5.0-13"), 0);
  assert.equal(compareVersions("1.5.0-14", "1.5.0-13"), 1);
  assert.equal(compareVersions("1.5.0", "1.5.0-13"), -1, "a missing part counts as 0");
  assert.equal(compareVersions("1.10.0", "1.9.9"), 1, "numeric, not lexical");
  assert.equal(compareVersions("v2.0", "0.2.0"), 0, "a leading non-digit is an empty part, counted as 0");
});

test("twoVoiceDoorRequests follows the app's per-group firmware thresholds", () => {
  assert.equal(twoVoiceGroupOf("1760/16U"), "1760_16");
  assert.equal(twoVoiceGroupOf("1760_31"), "1760_31");
  assert.equal(twoVoiceGroupOf("1083/83"), undefined);
  assert.equal(twoVoiceDoorRequests("1760/16", "1.5.0-13"), true);
  assert.equal(twoVoiceDoorRequests("1760/16", "1.5.0-12"), false);
  assert.equal(twoVoiceDoorRequests("1760/31", "4.9.9"), false);
  assert.equal(twoVoiceDoorRequests("1760/33U", "5.0.0-4"), true);
  assert.equal(twoVoiceDoorRequests("1083/83", "9.9.9"), false, "no door requests outside the 1760 groups");
  assert.equal(twoVoiceDoorRequests("1760/16", ""), false);
});

test("familyOf maps model codes", () => {
  assert.equal(familyOf("1060"), "ipercom");
  assert.equal(familyOf("1083/83"), "twovoice");
  assert.equal(familyOf("1760/16"), "twovoice");
  assert.equal(familyOf("1083/58A"), "twovoice");
  assert.equal(familyOf("1722/58 B"), "twovoice"); // whitespace ignored
  assert.equal(familyOf("9854/58"), "twovoice");
  assert.equal(familyOf(""), "unknown");
  assert.equal(familyOf("1083/59"), "unknown");
});

const doorsJson = JSON.stringify([
  { id: 7, device_name: "Main entrance", door_name: "door", gate_name: "gate", device_topology: "1.2" },
  { id: 8, device_name: "Side", door_name: "door" },
]);

test("parseDoors accepts the string-encoded inner response (real gateways)", () => {
  const reply = { result: 0, data: { response: [{ type: "residentDoors", response: doorsJson }] } };
  assert.deepEqual(parseDoors(reply, "p1"), [
    { placeId: "p1", doorId: 7, name: "Main entrance", hasDoor: true, hasGate: true, topology: "1.2" },
    { placeId: "p1", doorId: 8, name: "Side", hasDoor: true, hasGate: false, topology: "" },
  ]);
});

test("parseDoors accepts an object inner response and skips other item types", () => {
  const reply = {
    result: 0,
    data: {
      response: [
        { type: "somethingElse", response: "[]" },
        { type: "residentDoors", response: JSON.parse(doorsJson).slice(0, 1) },
      ],
    },
  };
  assert.equal(parseDoors(reply, "p2").length, 1);
  assert.equal(parseDoors(reply, "p2")[0].placeId, "p2");
});

test("parseDoors returns [] on an empty or shapeless reply", () => {
  assert.deepEqual(parseDoors({ result: 0 }, "p"), []);
  assert.deepEqual(parseDoors(undefined, "p"), []);
});
