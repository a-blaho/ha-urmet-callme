import { test } from "node:test";
import assert from "node:assert/strict";
import type { CallMe, Door } from "./callme.js";
import { MqttBridge, MqttLike } from "./mqtt.js";
import type { TwoVoiceStation } from "./twoVoiceStation.js";

/** An in-memory broker-less client: records publishes/subscriptions, lets the test inject messages. */
class FakeMqtt implements MqttLike {
  published: { topic: string; payload: string; retain?: boolean }[] = [];
  subscribed: string[] = [];
  private listeners = new Map<string, ((...a: any[]) => void)[]>();
  publish(topic: string, payload: string, opts?: { retain?: boolean }) {
    this.published.push({ topic, payload, retain: opts?.retain });
  }
  async publishAsync(topic: string, payload: string, opts?: { retain?: boolean }) {
    this.publish(topic, payload, opts);
  }
  subscribe(topic: string) {
    this.subscribed.push(topic);
  }
  on(event: string, cb: (...a: any[]) => void) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), cb]);
  }
  once(event: string, cb: () => void) {
    // The bridge awaits the first 'connect': deliver it on the next tick like a real client would.
    setImmediate(cb);
  }
  async endAsync() {}
  /** Inject an inbound message as the broker would. */
  message(topic: string, payload: string) {
    for (const cb of this.listeners.get("message") ?? []) cb(topic, Buffer.from(payload));
  }
  config(component: string, uid: string): Record<string, unknown> | undefined {
    const p = this.published.find((x) => x.topic === `homeassistant/${component}/${uid}/config`);
    return p && p.payload ? (JSON.parse(p.payload) as Record<string, unknown>) : undefined;
  }
}

const doors: Door[] = [
  { placeId: "dev-1", doorId: 7, name: "Main entrance", hasDoor: true, hasGate: true, topology: "1.2#" },
  { placeId: "dev-1", doorId: 8, name: "Side", hasDoor: true, hasGate: false, topology: "1.3#" },
];

function bridge(fake: FakeMqtt, tv?: object) {
  const opened: unknown[][] = [];
  const callme = {
    places: [{ id: "dev-1" }],
    open: async (...args: unknown[]) => void opened.push(args),
  } as unknown as CallMe;
  const b = new MqttBridge("mqtt://fake", { connect: () => fake }, callme, tv as TwoVoiceStation);
  return { b, opened };
}

test("publishes one button per relay and one doorbell per entrance, with stable ids", async () => {
  const fake = new FakeMqtt();
  const { b } = bridge(fake);
  await b.start(doors);
  const door = fake.config("button", "urmet_dev_1_7_door")!;
  assert.equal(door.name, "Main entrance door");
  assert.equal(door.command_topic, "urmet/callme/urmet_dev_1_7_door/set");
  assert.equal(door.payload_press, "OPEN");
  assert.equal(door.availability_topic, "urmet/callme/availability");
  assert.deepEqual(door.device, {
    identifiers: ["urmet_dev_1"],
    name: "Urmet Main entrance",
    manufacturer: "Urmet",
    model: "CallMe / Ipercom",
  });
  assert.ok(fake.config("button", "urmet_dev_1_7_gate"));
  assert.equal(fake.config("button", "urmet_dev_1_8_gate"), undefined); // no gate_name -> no gate
  const bell = fake.config("event", "urmet_dev_1_7_doorbell")!;
  assert.equal(bell.device_class, "doorbell");
  assert.deepEqual(bell.event_types, ["ring"]);
  assert.equal(bell.command_topic, undefined); // events are not commandable
  assert.deepEqual(
    fake.subscribed.sort(),
    [
      "urmet/callme/urmet_dev_1_7_door/set",
      "urmet/callme/urmet_dev_1_7_gate/set",
      "urmet/callme/urmet_dev_1_8_door/set",
    ].sort(),
  );
  // retained discovery + stale 1.0.0-era lock/binary_sensor configs cleared
  assert.ok(fake.published.every((p) => !p.topic.endsWith("/config") || p.retain));
  assert.ok(fake.published.some((p) => p.topic === "homeassistant/lock/urmet_dev_1_7_door/config" && p.payload === ""));
});

test("routes a press to the right relay and ignores unknown topics", async () => {
  const fake = new FakeMqtt();
  const { b, opened } = bridge(fake);
  await b.start(doors);
  fake.message("urmet/callme/urmet_dev_1_7_gate/set", "OPEN");
  fake.message("urmet/callme/nothing/set", "OPEN");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(opened, [[7, "gate", "dev-1"]]);
});

test("2Voice places get door, gate, ready buttons and a doorbell keyed on the station", async () => {
  const fake = new FakeMqtt();
  const calls: string[] = [];
  const tv = {
    open: async (placeId: string, kind: string) => void calls.push(`open ${placeId} ${kind}`),
    prewarm: (placeId: string) => (calls.push(`warm ${placeId}`), true),
  };
  const { b } = bridge(fake, tv);
  await b.start(
    [],
    [
      { placeId: "p2", name: "Garden", kind: "door" },
      { placeId: "p2", name: "Garden", kind: "gate" },
    ],
    [{ placeId: "p2", name: "Garden", station: "00_1E_E0_03_38_F8" }],
  );
  assert.equal(fake.config("button", "urmet_p2_2voice_door")!.name, "Garden door");
  assert.equal(fake.config("button", "urmet_p2_2voice_gate")!.name, "Garden gate");
  assert.equal(fake.config("button", "urmet_p2_2voice_prewarm")!.payload_press, "WARM");
  assert.equal((fake.config("button", "urmet_p2_2voice_door")!.device as any).model, "CallMe / 2Voice");
  assert.equal(fake.config("notify", "urmet_p2_2voice_announce"), undefined); // no announcer given
  fake.message("urmet/callme/urmet_p2_2voice_gate/set", "OPEN");
  fake.message("urmet/callme/urmet_p2_2voice_prewarm/set", "WARM");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, ["open p2 gate", "warm p2"]);
});

test("ringDoorbell fires the matching entrance, else every doorbell of the place", async () => {
  const fake = new FakeMqtt();
  const { b } = bridge(fake);
  await b.start(doors);
  // (the stale-discovery purge also publishes empty payloads to old */event topics; skip those)
  const events = () =>
    fake.published
      .filter((p) => p.topic.endsWith("/event") && p.payload)
      .map((p) => [p.topic, JSON.parse(p.payload)]);
  // The panel's From carries the topological code with `_` where the device list has `#`.
  b.ringDoorbell({ placeId: "dev-1", from: '"Panel" <sip:1.3_@sip.urmet.com>', caller: "Panel" });
  assert.deepEqual(events(), [
    [
      "urmet/callme/urmet_dev_1_8_doorbell/event",
      { event_type: "ring", caller: "Panel", topological_code: "1.3_", matched: true },
    ],
  ]);
  fake.published.length = 0;
  b.ringDoorbell({ placeId: "dev-1", from: "<sip:9.9@sip.urmet.com>", caller: "?" });
  assert.deepEqual(
    events().map((e) => e[0]).sort(),
    ["urmet/callme/urmet_dev_1_7_doorbell/event", "urmet/callme/urmet_dev_1_8_doorbell/event"],
  );
  assert.equal(events()[0][1].matched, false);
});

test("stop publishes a retained offline before disconnecting", async () => {
  const fake = new FakeMqtt();
  const { b } = bridge(fake);
  await b.start([]);
  await b.stop();
  const last = fake.published[fake.published.length - 1];
  assert.deepEqual(last, { topic: "urmet/callme/availability", payload: "offline", retain: true });
});
