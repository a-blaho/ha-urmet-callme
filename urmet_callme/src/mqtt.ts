// MQTT bridge: publishes Home Assistant MQTT-discovery `button` entities for each
// openable relay (door/gate of each entrance); a press pulses the door open. The strike
// is momentary with no state feedback, so a stateless button models it (no lock state).
import mqtt, { MqttClient } from "mqtt";
import { CallMe, Door, DoorbellRing } from "./callme.js";
import { TwoVoiceDoor, TwoVoiceService } from "./door2voice.js";
import { logger } from "./logger.js";
import { uriUser } from "./sipClient.js";
import { sanitize } from "./util.js";

const log = logger("mqtt");

// Topological codes use `#` wildcards in the device list but arrive as `_` in the same
// positions in the panel's SIP From. Canonicalize (# and _ → #) so they compare equal.
const canonTopo = (s: string) => (s || "").replace(/[_#]/g, "#");

interface Relay {
  uid: string;
  doorId: number;
  doorType: "door" | "gate";
  placeId: string;
  name: string;
}

// A 2Voice relay: opened via the liblinphone `opendoor` path (TwoVoiceService), keyed by place +
// kind (no doorId - 2Voice has no residentDoors list; the OUT account IS the door).
interface TvRelay {
  uid: string;
  placeId: string;
  kind: "door" | "gate";
  name: string;
}

interface Doorbell {
  uid: string;
  placeId: string;
  topologyCanon: string; // canonicalized topological code for ring matching
  name: string;
}

// A 2Voice place's doorbell descriptor. 2Voice has no residentDoors, so the ring can't be keyed by a
// door's topological code; the panel INVITE's From carries the calling-station (OUT) username, so we
// match on that instead. Built per 2Voice place independently of 2Voice door-open.
export interface TwoVoiceDoorbell {
  placeId: string;
  name: string;
  station: string; // the calling-station (OUT) username the ring's From carries
}

/** A place whose camera call the "hang up" button can end (published once video is up). */
export interface HangupPlace {
  placeId: string;
  name: string;
  model: string; // the place device's model string, so the entity joins the place's existing device
}

export class MqttBridge {
  private client!: MqttClient;
  private relays = new Map<string, Relay>(); // command_topic -> relay (IPERCOM open_door_req)
  private tvRelays = new Map<string, TvRelay>(); // command_topic -> 2Voice relay (opendoor/DTMF)
  private tvPrewarm = new Map<string, { placeId: string; name: string }>(); // command_topic -> place
  private hangups = new Map<string, HangupPlace>(); // command_topic -> place whose call to end
  private onHangup?: (placeId: string) => Promise<boolean>;
  private doorbells: Doorbell[] = [];
  private availTopic = "urmet/callme/availability";
  private prefix: string; // HA MQTT-discovery topic prefix (default "homeassistant")

  constructor(
    private url: string,
    private options: {
      username?: string;
      password?: string;
      discoveryPrefix?: string;
    },
    private callme: CallMe,
    private twoVoice?: TwoVoiceService, // present when 2Voice places are detected
  ) {
    this.prefix = options.discoveryPrefix || "homeassistant";
  }

  async start(
    doors: Door[],
    twoVoiceDoors: TwoVoiceDoor[] = [],
    twoVoiceDoorbells: TwoVoiceDoorbell[] = [],
  ) {
    this.client = mqtt.connect(this.url, {
      username: this.options.username,
      password: this.options.password,
      will: {
        topic: this.availTopic,
        payload: "offline",
        retain: true,
        qos: 1,
      },
    });
    // Re-assert availability on EVERY (re)connect. mqtt.js auto-reconnects after a network blip; the
    // broker fires our LWT "offline" on the drop, so without re-publishing "online" here the entities
    // would stay unavailable after any reconnect until an add-on restart.
    this.client.on("connect", () => {
      this.client.publish(this.availTopic, "online", { retain: true });
    });
    // Log (don't crash) on MQTT errors - mqtt.js keeps retrying; an unhandled 'error' would abort the
    // whole add-on and take every entity offline.
    this.client.on("error", (e) => log.error(`MQTT error: ${e.message}`));
    await new Promise<void>((res) => this.client.once("connect", () => res()));
    this.client.on("message", (t, p) => this.onCommand(t, p.toString()));
    this.clearStaleDiscovery(doors);
    this.publishDiscovery(doors);
    this.publishTwoVoice(twoVoiceDoors);
    this.publishDoorbells(doors);
    this.publishTwoVoiceDoorbells(twoVoiceDoorbells);
    log.info(
      `connected to broker; published ${this.relays.size} IPERCOM + ${this.tvRelays.size} 2Voice ` +
        `button entities, ${this.doorbells.length} doorbell(s)`,
    );
  }

  /** Remove entities from older builds so they don't linger in HA (MQTT discovery configs are
   *  retained). The relays used to be `lock` entities; the doorbell used to be a
   *  `binary_sensor`; missed-calls was a `sensor` then an `event` (now removed entirely).
   *  Publish an empty retained payload to each old config topic. */
  private clearStaleDiscovery(doors: Door[]) {
    const prefix = this.prefix;
    const del = (topic: string) =>
      this.client.publish(topic, "", { retain: true });
    for (const d of doors) {
      for (const type of ["door", "gate"]) {
        const uid = sanitize(`urmet_${d.placeId}_${d.doorId}_${type}`);
        del(`${prefix}/lock/${uid}/config`); // relays were `lock` entities
        del(`urmet/callme/${uid}/state`);
      }
      const uid = sanitize(`urmet_${d.placeId}_${d.doorId}_doorbell`);
      del(`${prefix}/binary_sensor/${uid}/config`);
      del(`urmet/callme/${uid}/state`);
      del(`urmet/callme/${uid}/state/attr`);
    }
    for (const place of this.callme.places) {
      const uid = sanitize(`urmet_${place.id}_missed_calls`);
      del(`${prefix}/sensor/${uid}/config`); // old missed-calls sensor
      del(`${prefix}/event/${uid}/config`); // removed missed-calls event
      del(`urmet/callme/${uid}/state`);
      del(`urmet/callme/${uid}/state/attr`);
      del(`urmet/callme/${uid}/event`);
    }
  }

  private deviceFor(placeId: string, name: string, model = "CallMe / Ipercom") {
    return {
      identifiers: [`urmet_${sanitize(placeId)}`],
      name: `Urmet ${name}`,
      manufacturer: "Urmet",
      model,
    };
  }

  /** One `button` per 2Voice place (Phase 1: door only). A press runs the liblinphone `opendoor`
   *  path (register the channel account -> auto_insertion call -> DTMF) via TwoVoiceService. */
  private publishTwoVoice(doors: TwoVoiceDoor[]) {
    for (const d of doors) {
      const uid = sanitize(`urmet_${d.placeId}_2voice_${d.kind}`);
      const cmd = `urmet/callme/${uid}/set`;
      this.tvRelays.set(cmd, {
        uid,
        placeId: d.placeId,
        kind: d.kind,
        name: `${d.name} ${d.kind}`,
      });
      const cfg = {
        name: `${d.name} ${d.kind}`,
        unique_id: uid,
        command_topic: cmd,
        payload_press: "OPEN",
        icon: d.kind === "gate" ? "mdi:door-sliding" : "mdi:door",
        availability_topic: this.availTopic,
        device: this.deviceFor(d.placeId, d.name, "CallMe / 2Voice"),
      };
      this.client.publish(
        `${this.prefix}/button/${uid}/config`,
        JSON.stringify(cfg),
        { retain: true },
      );
      this.client.subscribe(cmd);
    }
    this.publishTwoVoicePrewarm(doors);
  }

  /** One `button` per 2Voice place that PRE-WARMS the call (opens the auto_insertion call without a
   *  tone) so a following door/gate press is instant. This mirrors placing the call when the station
   *  is picked, a step before the unlock button. Users trigger it from any automation (e.g.
   *  doorbell ring -> press ready, or dashboard-open -> press ready). One per place, not per kind. */
  private publishTwoVoicePrewarm(doors: TwoVoiceDoor[]) {
    const seen = new Set<string>();
    for (const d of doors) {
      if (seen.has(d.placeId)) continue;
      seen.add(d.placeId);
      const uid = sanitize(`urmet_${d.placeId}_2voice_prewarm`);
      const cmd = `urmet/callme/${uid}/set`;
      this.tvPrewarm.set(cmd, { placeId: d.placeId, name: d.name });
      const cfg = {
        name: `${d.name} ready`,
        unique_id: uid,
        command_topic: cmd,
        payload_press: "WARM",
        icon: "mdi:phone-outgoing",
        availability_topic: this.availTopic,
        device: this.deviceFor(d.placeId, d.name, "CallMe / 2Voice"),
      };
      this.client.publish(
        `${this.prefix}/button/${uid}/config`,
        JSON.stringify(cfg),
        { retain: true },
      );
      this.client.subscribe(cmd);
    }
  }

  /** One "hang up" `button` per place with a camera, published once the video service is up (it
   *  starts after the bridge, and only with `video: true`). A press ends the place's live camera
   *  call at once instead of waiting for the reader-idle window; `handler` resolves whether a call
   *  was up. */
  publishHangup(places: HangupPlace[], handler: (placeId: string) => Promise<boolean>) {
    this.onHangup = handler;
    for (const p of places) {
      const uid = sanitize(`urmet_${p.placeId}_hangup`);
      const cmd = `urmet/callme/${uid}/set`;
      this.hangups.set(cmd, p);
      const cfg = {
        name: `${p.name} hang up`,
        unique_id: uid,
        command_topic: cmd,
        payload_press: "HANGUP",
        icon: "mdi:phone-hangup",
        availability_topic: this.availTopic,
        device: this.deviceFor(p.placeId, p.name, p.model),
      };
      this.client.publish(
        `${this.prefix}/button/${uid}/config`,
        JSON.stringify(cfg),
        { retain: true },
      );
      this.client.subscribe(cmd);
    }
    log.info(`published ${places.length} hang-up button(s)`);
  }

  /** One doorbell `event` entity per 2Voice place. The ring arrives on the channel account carrying
   *  the calling-station (OUT) username in its From, so we key the match on that. Pushed into the
   *  same `doorbells` list so `ringDoorbell` routes to it. Independent of 2Voice door-open - the ring
   *  works regardless of unlock (only `doorbell` gates the ring itself, via startDoorbell). */
  private publishTwoVoiceDoorbells(places: TwoVoiceDoorbell[]) {
    for (const p of places) {
      const uid = sanitize(`urmet_${p.placeId}_2voice_doorbell`);
      this.doorbells.push({
        uid,
        placeId: p.placeId,
        topologyCanon: canonTopo(p.station),
        name: `${p.name} doorbell`,
      });
      const cfg = {
        name: `${p.name} doorbell`,
        unique_id: uid,
        state_topic: `urmet/callme/${uid}/event`,
        event_types: ["ring"],
        device_class: "doorbell",
        availability_topic: this.availTopic,
        device: this.deviceFor(p.placeId, p.name, "CallMe / 2Voice"),
      };
      this.client.publish(
        `${this.prefix}/event/${uid}/config`,
        JSON.stringify(cfg),
        { retain: true },
      );
    }
  }

  /** One doorbell `event` entity (device_class doorbell) PER door/panel, keyed by
   *  topological code so a ring routes to the exact entrance. */
  private publishDoorbells(doors: Door[]) {
    for (const d of doors) {
      const uid = sanitize(`urmet_${d.placeId}_${d.doorId}_doorbell`);
      this.doorbells.push({
        uid,
        placeId: d.placeId,
        topologyCanon: canonTopo(d.topology),
        name: `${d.name} doorbell`,
      });
      const cfg = {
        name: `${d.name} doorbell`,
        unique_id: uid,
        state_topic: `urmet/callme/${uid}/event`,
        event_types: ["ring"],
        device_class: "doorbell",
        availability_topic: this.availTopic,
        device: this.deviceFor(d.placeId, d.name),
      };
      this.client.publish(
        `${this.prefix}/event/${uid}/config`,
        JSON.stringify(cfg),
        {
          retain: true,
        },
      );
    }
  }

  /** Fire a `ring` event on the ringing door's entity. Matches the panel's topological code
   *  (from the INVITE From) to a door; if none matches, fires on all doors in the place. */
  ringDoorbell(ring: DoorbellRing) {
    if (!this.client) return;
    const topo = uriUser(ring.from);
    const c = canonTopo(topo);
    const inPlace = this.doorbells.filter((db) => db.placeId === ring.placeId);
    const matched = inPlace.filter((db) => db.topologyCanon === c);
    const targets = matched.length ? matched : inPlace;
    const payload = JSON.stringify({
      event_type: "ring",
      caller: ring.caller,
      topological_code: topo,
      matched: matched.length > 0,
    });
    for (const t of targets)
      this.client.publish(`urmet/callme/${t.uid}/event`, payload);
    if (matched.length)
      log.info(
        `doorbell ring: ${matched.map((m) => m.name).join(", ")} (${topo})`,
      );
    else
      log.warn(
        `doorbell ring from ${topo} matched no door in place ${ring.placeId}; ` +
          `fired on all ${targets.length} door(s) there`,
      );
  }

  /** One `button` entity PER openable relay (door/gate). The relay is a momentary door
   *  strike with no state feedback, so a stateless button (press = open pulse) models it
   *  honestly - no fabricated locked/unlocked state. */
  private publishDiscovery(doors: Door[]) {
    for (const d of doors) {
      const relays: Array<"door" | "gate"> = [];
      if (d.hasDoor) relays.push("door");
      if (d.hasGate) relays.push("gate");
      for (const type of relays) {
        const uid = sanitize(`urmet_${d.placeId}_${d.doorId}_${type}`);
        const cmd = `urmet/callme/${uid}/set`;
        this.relays.set(cmd, {
          uid,
          doorId: d.doorId,
          doorType: type,
          placeId: d.placeId,
          name: `${d.name} ${type}`,
        });
        const cfg = {
          name: `${d.name} ${type}`,
          unique_id: uid,
          command_topic: cmd,
          payload_press: "OPEN",
          icon: type === "gate" ? "mdi:door-sliding" : "mdi:door",
          availability_topic: this.availTopic,
          device: this.deviceFor(d.placeId, d.name),
        };
        this.client.publish(
          `${this.prefix}/button/${uid}/config`,
          JSON.stringify(cfg),
          { retain: true },
        );
        this.client.subscribe(cmd);
      }
    }
  }

  /** A press on any relay's command topic pulses that door open. No state to track -
   *  the strike is momentary and gives no feedback; success/failure is logged only. */
  private async onCommand(topic: string, payload: string) {
    const relay = this.relays.get(topic);
    if (relay) {
      log.info(`press ${payload} for ${relay.name}`);
      try {
        await this.callme.open(relay.doorId, relay.doorType, relay.placeId);
        log.info(`open ${relay.name} (door_id=${relay.doorId}) OK`);
      } catch (e) {
        log.error(
          `open ${relay.name} (door_id=${relay.doorId}) FAILED:`,
          (e as Error).message,
        );
      }
      return;
    }
    const tv = this.tvRelays.get(topic);
    if (tv && this.twoVoice) {
      log.info(`press ${payload} for ${tv.name} (2Voice)`);
      try {
        await this.twoVoice.open(tv.placeId, tv.kind);
        log.info(`open ${tv.name} (2Voice) OK`);
      } catch (e) {
        log.error(`open ${tv.name} (2Voice) FAILED:`, (e as Error).message);
      }
      return;
    }
    const warm = this.tvPrewarm.get(topic);
    if (warm && this.twoVoice) {
      log.info(`pre-warm ${payload} for ${warm.name} (2Voice)`);
      this.twoVoice.prewarm(warm.placeId); // fire-and-forget: opens the call, no tone
      return;
    }
    const hang = this.hangups.get(topic);
    if (hang && this.onHangup) {
      log.info(`press ${payload} for ${hang.name} hang up`);
      try {
        const ended = await this.onHangup(hang.placeId);
        log.info(`hang up ${hang.name}: ${ended ? "call ended" : "no camera call was up"}`);
      } catch (e) {
        log.error(`hang up ${hang.name} FAILED:`, (e as Error).message);
      }
    }
  }

  /** Mark the entities unavailable and disconnect. AWAITED: the retained "offline" must be acked
   *  before the process exits, because a clean DISCONNECT discards the broker-side will -- exiting
   *  early used to leave every entity "available" after a stop until the next start. */
  async stop(): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.publishAsync(this.availTopic, "offline", {
        retain: true,
        qos: 1,
      });
      await this.client.endAsync();
    } catch (e) {
      log.warn(`MQTT shutdown: ${(e as Error).message}`);
    }
  }
}
