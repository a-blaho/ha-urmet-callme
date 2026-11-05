// MQTT bridge: publishes Home Assistant MQTT-discovery entities and routes their command topics.
//   button  one per openable relay (door/gate of each IPERCOM entrance; door + gate per 2Voice place),
//           plus per place "ready" (2Voice pre-warm), "hang up" and "next camera" when video is on
//   event   one doorbell per entrance/panel (device_class doorbell), firing `ring`
//   notify  announcements: one per 2Voice place, and one per Ipercom camera when video is on
// The strike is momentary with no state feedback, so a stateless button models it (no lock state).
import mqtt, { IClientOptions, MqttClient } from "mqtt";
import { Announcer, type TalkTarget } from "./announce.js";
import { CallMe } from "./callme.js";
import { DoorbellRing } from "./doorbell.js";
import { Door } from "./ipercom.js";
import { logger } from "./logger.js";
import { uriUser } from "./sipClient.js";
import { TwoVoiceDoor, TwoVoiceStation } from "./twoVoiceStation.js";
import { canonTopo, sanitize } from "./util.js";

const log = logger("mqtt");

const MODEL_IPERCOM = "CallMe / Ipercom";
const MODEL_TWOVOICE = "CallMe / 2Voice";

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

/** An Ipercom camera's announcement entity (published once video is up). */
export interface IpercomAnnounceCam {
  placeId: string;
  topologicalCode: string; // with placeId, the entity's stable id
  name: string; // the camera (entrance panel)
  placeName: string; // the HA device it belongs to
  target: TalkTarget;
}

/** A place whose camera call the "hang up" / "next camera" buttons act on (published once video is up). */
export interface HangupPlace {
  placeId: string;
  name: string;
  model: string; // the place device's model string, so the entity joins the place's existing device
}

/** The subset of MqttClient the bridge uses; a test substitutes a fake through `options.connect`. */
export interface MqttLike {
  publish(topic: string, payload: string, opts?: { retain?: boolean; qos?: 0 | 1 | 2 }): unknown;
  publishAsync(topic: string, payload: string, opts?: { retain?: boolean; qos?: 0 | 1 | 2 }): Promise<unknown>;
  subscribe(topic: string): unknown;
  on(event: "connect", cb: () => void): unknown;
  on(event: "error", cb: (e: Error) => void): unknown;
  on(event: "message", cb: (topic: string, payload: Buffer) => void): unknown;
  once(event: "connect", cb: () => void): unknown;
  endAsync(): Promise<unknown>;
}

type CommandHandler = (payload: string) => void | Promise<void>;

export class MqttBridge {
  private client!: MqttLike;
  private handlers = new Map<string, CommandHandler>(); // command_topic -> what a message there does
  private doorbells: Doorbell[] = [];
  private counts = { relays: 0, tvRelays: 0 };
  private availTopic = "urmet/callme/availability";
  private prefix: string; // HA MQTT-discovery topic prefix (default "homeassistant")

  constructor(
    private url: string,
    private options: {
      username?: string;
      password?: string;
      discoveryPrefix?: string;
      /** Test seam: builds the client. Defaults to mqtt.connect. */
      connect?: (url: string, opts: IClientOptions) => MqttLike;
    },
    private callme: CallMe,
    private twoVoice?: TwoVoiceStation, // present when 2Voice places are detected
    private announcer?: Announcer, // announcements (the `notify` entities)
  ) {
    this.prefix = options.discoveryPrefix || "homeassistant";
  }

  async start(
    doors: Door[],
    twoVoiceDoors: TwoVoiceDoor[] = [],
    twoVoiceDoorbells: TwoVoiceDoorbell[] = [],
  ) {
    const connect = this.options.connect ?? ((u, o) => mqtt.connect(u, o) as unknown as MqttClient);
    this.client = connect(this.url, {
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
    this.client.on("message", (t, p) => void this.onCommand(t, p.toString()));
    this.clearStaleDiscovery(doors);
    this.publishDoors(doors);
    this.publishTwoVoiceDoors(twoVoiceDoors);
    this.publishDoorbells(doors);
    this.publishTwoVoiceDoorbells(twoVoiceDoorbells);
    log.info(
      `connected to broker; published ${this.counts.relays} IPERCOM + ${this.counts.tvRelays} 2Voice ` +
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

  private deviceFor(placeId: string, name: string, model = MODEL_IPERCOM) {
    return {
      identifiers: [`urmet_${sanitize(placeId)}`],
      name: `Urmet ${name}`,
      manufacturer: "Urmet",
      model,
    };
  }

  /** Publish one discovery config (retained) and, for a commandable entity, subscribe its command
   *  topic and remember what a message there does. `uid` is the unique_id and names both topics, so
   *  the ids older builds published stay stable. */
  private publishEntity(
    component: "button" | "event" | "notify",
    uid: string,
    cfg: Record<string, unknown>,
    handler?: CommandHandler,
  ): void {
    const full: Record<string, unknown> = {
      ...cfg,
      unique_id: uid,
      availability_topic: this.availTopic,
    };
    if (handler) {
      const cmd = `urmet/callme/${uid}/set`;
      full.command_topic = cmd;
      this.handlers.set(cmd, handler);
      this.client.subscribe(cmd);
    }
    this.client.publish(`${this.prefix}/${component}/${uid}/config`, JSON.stringify(full), {
      retain: true,
    });
  }

  /** Run a press/command handler, logging the outcome in the entity's terms; never throws. */
  private async run(what: string, fn: () => void | Promise<void>, ok: string): Promise<void> {
    try {
      await fn();
      log.info(`${what}: ${ok}`);
    } catch (e) {
      log.error(`${what} FAILED:`, (e as Error).message);
    }
  }

  /** One `button` entity PER openable relay (door/gate) of an IPERCOM entrance. The relay is a
   *  momentary door strike with no state feedback, so a stateless button (press = open pulse)
   *  models it honestly - no fabricated locked/unlocked state. */
  private publishDoors(doors: Door[]) {
    for (const d of doors) {
      const relays: Array<"door" | "gate"> = [];
      if (d.hasDoor) relays.push("door");
      if (d.hasGate) relays.push("gate");
      for (const type of relays) {
        const name = `${d.name} ${type}`;
        this.counts.relays++;
        this.publishEntity(
          "button",
          sanitize(`urmet_${d.placeId}_${d.doorId}_${type}`),
          {
            name,
            payload_press: "OPEN",
            icon: type === "gate" ? "mdi:door-sliding" : "mdi:door",
            device: this.deviceFor(d.placeId, d.name),
          },
          (payload) => {
            log.info(`press ${payload} for ${name}`);
            return this.run(
              `open ${name} (door_id=${d.doorId})`,
              () => this.callme.open(d.doorId, type, d.placeId),
              "OK",
            );
          },
        );
      }
    }
  }

  /** Per 2Voice place: a door and a gate `button` (press -> the station helper sends the tone on its
   *  call, placing a silent auto_insertion call if none is up), a "ready" button that pre-warms that
   *  call, and a `notify` entity for announcements. */
  private publishTwoVoiceDoors(doors: TwoVoiceDoor[]) {
    const tv = this.twoVoice;
    if (!tv) return;
    const places = new Map<string, string>(); // placeId -> name (one ready/announce per place)
    for (const d of doors) {
      places.set(d.placeId, d.name);
      const name = `${d.name} ${d.kind}`;
      this.counts.tvRelays++;
      this.publishEntity(
        "button",
        sanitize(`urmet_${d.placeId}_2voice_${d.kind}`),
        {
          name,
          payload_press: "OPEN",
          icon: d.kind === "gate" ? "mdi:door-sliding" : "mdi:door",
          device: this.deviceFor(d.placeId, d.name, MODEL_TWOVOICE),
        },
        (payload) => {
          log.info(`press ${payload} for ${name} (2Voice)`);
          return this.run(`open ${name} (2Voice)`, () => tv.open(d.placeId, d.kind), "OK");
        },
      );
    }
    for (const [placeId, name] of places) {
      // Pre-warm: open the auto_insertion call NOW with no tone so a following door/gate press rides
      // an already-established call (instant). Mirrors placing the call when the station is picked, a
      // step before the unlock button. Fire-and-forget; the helper releases the bus on its own.
      this.publishEntity(
        "button",
        sanitize(`urmet_${placeId}_2voice_prewarm`),
        {
          name: `${name} ready`,
          payload_press: "WARM",
          icon: "mdi:phone-outgoing",
          device: this.deviceFor(placeId, name, MODEL_TWOVOICE),
        },
        (payload) => {
          log.info(`pre-warm ${payload} for ${name} (2Voice)`);
          tv.prewarm(placeId);
        },
      );
      // Announcements: `notify.send_message` with text speaks it through a Home Assistant TTS engine, an
      // http(s) URL of an audio file plays the file (announce.ts logs its own progress and outcome).
      const announcer = this.announcer;
      if (announcer)
        this.publishEntity(
          "notify",
          sanitize(`urmet_${placeId}_2voice_announce`),
          {
            name: `${name} announce`,
            icon: "mdi:bullhorn",
            device: this.deviceFor(placeId, name, MODEL_TWOVOICE),
          },
          (payload) => void announcer.announce(tv.talkTarget(placeId), payload),
        );
    }
  }

  /** One announcement `notify` entity per Ipercom camera (entrance panel), published once the video
   *  service is up: the clip plays on that camera's call (VideoService.startTalk). */
  publishIpercomAnnounce(cams: IpercomAnnounceCam[]) {
    const announcer = this.announcer;
    if (!announcer) return;
    for (const c of cams)
      this.publishEntity(
        "notify",
        sanitize(`urmet_${c.placeId}_${c.topologicalCode}_announce`),
        {
          name: `${c.name} announce`,
          icon: "mdi:bullhorn",
          device: this.deviceFor(c.placeId, c.placeName),
        },
        (payload) => void announcer.announce(c.target, payload),
      );
    log.info(`published ${cams.length} Ipercom announcement entit${cams.length === 1 ? "y" : "ies"}`);
  }

  /** One "hang up" `button` per place with a camera, published once the video service is up (it
   *  starts after the bridge, and only with `video: true`). A press ends the place's live camera
   *  call at once instead of waiting for the reader-idle window; `handler` resolves whether a call
   *  was up. */
  publishHangup(places: HangupPlace[], handler: (placeId: string) => Promise<boolean>) {
    for (const p of places) {
      const name = `${p.name} hang up`;
      this.publishEntity(
        "button",
        sanitize(`urmet_${p.placeId}_hangup`),
        {
          name,
          payload_press: "HANGUP",
          icon: "mdi:phone-hangup",
          device: this.deviceFor(p.placeId, p.name, p.model),
        },
        async (payload) => {
          log.info(`press ${payload} for ${name}`);
          try {
            const ended = await handler(p.placeId);
            log.info(`hang up ${p.name}: ${ended ? "call ended" : "no camera call was up"}`);
          } catch (e) {
            log.error(`hang up ${p.name} FAILED:`, (e as Error).message);
          }
        },
      );
    }
    log.info(`published ${places.length} hang-up button(s)`);
  }

  /** One "next camera" `button` per 2Voice place with video (issue #20). A station with several
   *  entrance panels shows one at a time on the camera call; a press moves that call to the next
   *  panel (TwoVoiceVideoService.nextCamera), and the door/gate buttons then open the panel being
   *  shown. `handler` resolves whether the switch went through. */
  publishNextCamera(places: HangupPlace[], handler: (placeId: string) => Promise<boolean>) {
    for (const p of places) {
      const name = `${p.name} next camera`;
      this.publishEntity(
        "button",
        sanitize(`urmet_${p.placeId}_next_camera`),
        {
          name,
          payload_press: "NEXT",
          icon: "mdi:camera-switch",
          device: this.deviceFor(p.placeId, p.name, p.model),
        },
        async (payload) => {
          log.info(`press ${payload} for ${name}`);
          try {
            const switched = await handler(p.placeId);
            log.info(
              `next camera ${p.name}: ${switched ? "switched" : "not switched (no camera call up, or the switch did not go out)"}`,
            );
          } catch (e) {
            log.error(`next camera ${p.name} FAILED:`, (e as Error).message);
          }
        },
      );
    }
    log.info(`published ${places.length} next-camera button(s)`);
  }

  private publishDoorbell(
    uid: string,
    placeId: string,
    placeName: string,
    topology: string,
    model?: string,
  ) {
    const name = `${placeName} doorbell`;
    this.doorbells.push({ uid, placeId, topologyCanon: canonTopo(topology), name });
    this.publishEntity("event", uid, {
      name,
      state_topic: `urmet/callme/${uid}/event`,
      event_types: ["ring"],
      device_class: "doorbell",
      device: this.deviceFor(placeId, placeName, model),
    });
  }

  /** One doorbell `event` entity (device_class doorbell) PER door/panel, keyed by
   *  topological code so a ring routes to the exact entrance. */
  private publishDoorbells(doors: Door[]) {
    for (const d of doors)
      this.publishDoorbell(
        sanitize(`urmet_${d.placeId}_${d.doorId}_doorbell`),
        d.placeId,
        d.name,
        d.topology,
      );
  }

  /** One doorbell `event` entity per 2Voice place. The ring arrives on the channel account carrying
   *  the calling-station (OUT) username in its From, so we key the match on that. Independent of 2Voice
   *  door-open - the ring works regardless of unlock (only `doorbell` gates the ring itself). */
  private publishTwoVoiceDoorbells(places: TwoVoiceDoorbell[]) {
    for (const p of places)
      this.publishDoorbell(
        sanitize(`urmet_${p.placeId}_2voice_doorbell`),
        p.placeId,
        p.name,
        p.station,
        MODEL_TWOVOICE,
      );
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

  /** A message on a command topic runs that entity's handler. Unknown topics are ignored. */
  private async onCommand(topic: string, payload: string) {
    const handler = this.handlers.get(topic);
    if (handler) await handler(payload);
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
