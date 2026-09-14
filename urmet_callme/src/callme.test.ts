import { test } from "node:test";
import assert from "node:assert/strict";
import { familyOf, parseDoors } from "./callme.js";

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
