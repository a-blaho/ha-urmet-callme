// 2Voice control plane: ONE persistent `station` helper (video-recv/station.c) per 2Voice place, driven
// over stdin (src/helperProtocol.ts). 2Voice panels have NO cloud open_door_req (that's IPERCOM) and no
// on-demand camera call: the door is opened by placing a SIP call to the station and sending an in-call
// tone, and the camera is the H.264 the station sends on that same call. One call per station, so one
// process owns it and does both -- door/gate, pre-warm, announcements, the doorbell ring it holds, and,
// with `video: true`, the camera tapped into the FIFOs stream.sh's ffmpeg reads (the same go2rtc +
// stream.sh pipeline as the IPERCOM receiver; see cameraPipeline.ts).
//
// Why persistent: a cold SIP register per press cost ~2-3 s; the helper registers once at startup and
// each press pays only the call-setup time (or nothing, on a call already up: keep-alive, pre-warm, or
// the camera being viewed -- exactly how the app unlocks while viewing).
import { ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, unlinkSync } from "node:fs";
import type { Server } from "node:http";
import { macHeaderOf, Place } from "./place.js";
import { listenControl, makeFifos, type ControlHandler } from "./cameraPipeline.js";
import { Go2rtcPorts, Go2rtcProcess, go2rtcConfig } from "./go2rtc.js";
import { cameraCommand, HelperCommand, parseHelperLine } from "./helperProtocol.js";
import { isDebug, logger } from "./logger.js";
import { waitForExit } from "./proc.js";
import { camFifos, sanitize, stableUuid } from "./util.js";

const log = logger("2voice");

/** A stable RFC 5626 instance id for a place's station helper. liblinphone otherwise invents a random
 *  one per run (its config lives in a /tmp dir the container wipes), so each restart ADDED a binding to
 *  the shared account rather than replacing ours, and the registrar kept forking calls to the dead ones
 *  until they expired. Same trick as SipClient's instance(). The seed is the former opendoor helper's
 *  (pinned in util.test.ts) so an upgrade replaces its binding instead of adding one. */
const instanceUuid = (user: string, placeId: string) =>
  stableUuid(`urmet-opendoor:${user}:${placeId}`);

const DIGIT: Record<"door" | "gate", string> = {
  door: HelperCommand.DOOR,
  gate: HelperCommand.GATE,
};
// Per-open wait for the RESULT line. The helper's own worst case (no media) is 20 s; give more before
// giving up on the reply (the helper stays alive regardless -- no kill needed).
const OPEN_TIMEOUT_MS = 45000;
// A camera switch is one '3' on the live call, but with the audio open it is a BYE, a new call, then up
// to three '3's ~1.5 s apart, so its confirmation can take well past a door tone's.
const SWITCH_TIMEOUT_MS = 45000;
// How long the helper may take to answer a 'V' with CAMERA ok|fail (it reads stdin every 50 ms and
// answers at once, placing the call in the background).
const CAMERA_REPLY_MS = 3000;
const RESPAWN_MS = 3000; // auto-restart a helper that died (e.g. registration dropped)
const IDLE_SECONDS = 10; // camera off (and the call released after the keep-alive) with no reader this long

/** Announcements (announce.ts): the place's talk FIFO. PCM written here (s16le, 8 kHz mono) goes
 *  out on the station call as its audio (the helper reads it as STATION_AUDIO_IN, talkout.h). */
export const talkFifoOf = (placeId: string) => `/tmp/urmet_talk_${sanitize(placeId)}.pcm`;

/** An openable 2Voice relay (a door and a gate per place; see doors()). */
export interface TwoVoiceDoor {
  placeId: string;
  name: string;
  kind: "door" | "gate";
}

interface Waiter {
  resolve: () => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Helper {
  place: Place;
  child?: ChildProcess;
  outUri?: string; // station URI the live child was spawned with (it takes it as argv)
  inUser?: string; // channel account the live child registers (argv too): a change needs a respawn
  inPw?: string;
  buf: string; // stdout line-assembly buffer
  // FIFOs of in-flight commands awaiting their reply, in order (the helper answers each class in the
  // order received): door/gate tones (RESULT 1|2), camera switches (RESULT N), camera requests (CAMERA
  // ok|fail). Queues, not single slots, so rapid consecutive presses all reach the helper.
  tones: Waiter[];
  switches: Waiter[];
  camWaiters: ((failure: string | undefined) => void)[];
  ringing: boolean; // the helper holds the place's doorbell ring call: "RING held/gone"
  camOn: boolean; // the camera is being fed (CAMERA ok seen, no CAMERA end yet)
}

export interface TwoVoiceStationOptions {
  keepaliveMs: number; // >0: hold the call open this long after the last activity; 0: per press
  prewarmHoldMs: number; // how long a prewarm() (ready button) keeps the call open
  talkDtmf: string; // announcements: the open-audio digit sent first ("" = none)
  audioAtStart: boolean; // `video_2voice_audio`: open the station's audio on every camera call
}

export class TwoVoiceStation {
  private helpers = new Map<string, Helper>(); // placeId -> its station helper
  private stopping = false;
  // Video (startVideo): one go2rtc stream per place with a station, fed by that place's helper.
  private cams: { place: Place; h264: string; pcm: string }[] = [];
  private go2rtc?: Go2rtcProcess;
  private server?: Server;
  private callPort = 0;

  constructor(
    private places: Place[],
    private realm: string,
    private opts: TwoVoiceStationOptions,
  ) {}

  /** The 2Voice places' openable relays: a DOOR (DTMF '1') and a GATE (DTMF '2') per place. 2Voice
   *  has no capability discovery for a gate - the app hardcodes GATE_DTMF='2' and offers both - so we
   *  expose both and the user uses whichever their installation has wired. */
  doors(): TwoVoiceDoor[] {
    return this.places.flatMap((p) => [
      { placeId: p.id, name: p.name, kind: "door" as const },
      { placeId: p.id, name: p.name, kind: "gate" as const },
    ]);
  }

  /** Spawn one persistent, pre-registered helper per 2Voice place. Call once at startup. */
  start(): void {
    for (const p of this.places) {
      if (!p.incomingUser || !p.incomingPw) {
        log.warn(`2Voice place ${p.id} has no channel account; door-open unavailable`);
        continue;
      }
      this.helpers.set(p.id, {
        place: p,
        buf: "",
        tones: [],
        switches: [],
        camWaiters: [],
        ringing: false,
        camOn: false,
      });
      try {
        unlinkSync(talkFifoOf(p.id));
      } catch {
        /* not there */
      }
      try {
        execFileSync("mkfifo", [talkFifoOf(p.id)]);
      } catch (e) {
        log.warn(`announcement FIFO for ${p.id} not created: ${(e as Error).message}`);
      }
      if (!p.outgoingUser) {
        log.warn(`2Voice place ${p.id} has no station account yet; waiting for the device to register`);
        continue;
      }
      this.spawn(p.id);
    }
  }

  /** Start (or restart) the helper now that the station URI is known. It fixes the URI at spawn. */
  stationLearned(placeId: string): void {
    if (this.stopping) return;
    const h = this.helpers.get(placeId);
    if (!h || !h.place.outgoingUser) return;
    if (h.child && h.outUri === this.stationUri(h.place)) return;
    this.restart(placeId, "its station changed");
  }

  /** After a reconnect re-read the places (callme.connect updates them in place): a helper took its
   *  channel account and station URI as argv at spawn, so one whose values changed is restarted with
   *  the current ones; the rest keep running. */
  placesRefreshed(): void {
    if (this.stopping) return;
    for (const [placeId, h] of this.helpers) {
      if (!h.child) continue;
      if (
        h.inUser !== h.place.incomingUser ||
        h.inPw !== h.place.incomingPw ||
        h.outUri !== this.stationUri(h.place)
      )
        this.restart(placeId, "its account or station changed");
    }
  }

  /** Replace the place's helper (if one runs) with one spawned from the place's current values. */
  private restart(placeId: string, why: string): void {
    const h = this.helpers.get(placeId);
    if (!h) return;
    if (h.child) {
      log.info(`2Voice helper for ${placeId}: ${why}; restarting it`);
      h.child.removeAllListeners("exit");
      h.child.kill("SIGTERM");
      h.child = undefined;
      h.ringing = false;
      h.camOn = false;
    }
    this.spawn(placeId);
  }

  private stationUri(p: Place): string {
    return `sip:${p.outgoingUser}@${p.realm}`;
  }

  private spawn(placeId: string): void {
    if (this.stopping) return;
    const h = this.helpers.get(placeId);
    if (!h) return;
    const p = h.place;
    if (!p.outgoingUser) return; // station still unknown; stationLearned() spawns us later
    const outUri = this.stationUri(p);
    const mac = macHeaderOf(p.outgoingUser);
    // DIAGNOSTIC: log EXACTLY which door-open header this station will get. `mac` is the 58A path;
    // `auto_insertion` is cloud-listed 2Voice. If a 58A ends up on auto_insertion (because its
    // station account wasn't MAC-shaped), the station answers 486 and the door won't open -- pair
    // this line with the helper's own "outgoing header" + call-error-code lines to confirm.
    log.info(
      `2Voice place ${p.id} (${p.name}): door-open via ${mac ? `mac header ${mac}` : "auto_insertion"} to station ${p.outgoingUser}`,
    );
    const dataDir = `/tmp/lp_2v_${sanitize(p.id)}/`;
    try {
      mkdirSync(dataDir, { recursive: true });
    } catch {
      /* the helper falls back to a default dir */
    }
    // stdin = commands; stdout = RESULT/RING/CAMERA + [station] logs (we parse + forward); stderr -> log.
    const child = spawn("station", [p.incomingUser, p.incomingPw, outUri], {
      env: {
        ...process.env,
        SIP_REALM: this.realm,
        STATION_DATA_DIR: dataDir,
        STATION_KEEPALIVE_MS: String(this.opts.keepaliveMs),
        STATION_PREWARM_HOLD_MS: String(this.opts.prewarmHoldMs),
        STATION_IDLE_SECONDS: String(IDLE_SECONDS),
        STATION_UUID: instanceUuid(p.incomingUser, p.id),
        STATION_AUDIO_IN: talkFifoOf(p.id),
        STATION_TALK_DTMF: this.opts.talkDtmf,
        // Hold a doorbell ring so an announcement / door press during it can answer it (the station
        // refuses new calls while it rings) and the camera can show it. A pre-warm never answers it.
        STATION_ANSWER_RING: "1",
        ...(mac ? { STATION_MAC: mac } : {}),
        // The entrance sound on the camera stream; without it the audio stays closed like the app's,
        // so next camera is a live '3' instead of a new call.
        ...(this.opts.audioAtStart ? { STATION_OPEN_AUDIO_AT_START: "1" } : {}),
        ...(isDebug() ? { STATION_DEBUG: "1" } : {}),
      },
      stdio: ["pipe", "pipe", "inherit"],
    });
    h.child = child;
    h.outUri = outUri;
    h.inUser = p.incomingUser;
    h.inPw = p.incomingPw;
    h.buf = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => this.onStdout(placeId, d));
    child.on("error", (e) => log.error(`2Voice helper [${p.id}] spawn error: ${e.message}`));
    child.on("exit", (code) => {
      h.child = undefined;
      h.ringing = false;
      if (h.camOn) {
        h.camOn = false;
        log.info(`2Voice camera ${p.name}: the helper exited, the picture ends`);
      }
      for (const w of h.camWaiters.splice(0)) w("the station helper exited");
      for (const w of [...h.tones.splice(0), ...h.switches.splice(0)]) {
        clearTimeout(w.timer);
        w.reject(new Error(`station helper exited (code ${code ?? "killed"})`));
      }
      if (!this.stopping) {
        log.warn(`2Voice helper [${p.id}] exited (code ${code}); respawning in ${RESPAWN_MS}ms`);
        setTimeout(() => this.spawn(placeId), RESPAWN_MS);
      }
    });
    log.info(`2Voice station helper starting for ${p.id} (${p.name}) via ${p.outgoingUser}`);
  }

  // Assemble the helper's stdout into lines: consume the machine lines, forward the rest to the log.
  private onStdout(placeId: string, data: string): void {
    const h = this.helpers.get(placeId);
    if (!h) return;
    h.buf += data;
    let nl: number;
    while ((nl = h.buf.indexOf("\n")) >= 0) {
      const line = h.buf.slice(0, nl).trimEnd();
      h.buf = h.buf.slice(nl + 1);
      if (!line) continue;
      const ev = parseHelperLine(line);
      if (ev.kind === "ring") {
        h.ringing = ev.held;
        log.debug(line);
        continue;
      }
      if (ev.kind === "camera") {
        log.debug(line);
        // One V is in flight at a time (camera() joins a pending one), so its reply answers every waiter.
        if (ev.status === "ok") {
          h.camOn = true;
          for (const w of h.camWaiters.splice(0)) w(undefined);
        } else if (ev.status === "fail") {
          for (const w of h.camWaiters.splice(0)) w(ev.why || "failed");
        } else if (ev.status === "live") {
          log.info(`2Voice camera ${h.place.name}: video established`);
        } else if (ev.status === "end") {
          if (h.camOn) log.info(`2Voice camera ${h.place.name}: the picture ended`);
          h.camOn = false;
        }
        continue;
      }
      log.info(line); // the helper's lines are already "[station] …"
      if (ev.kind === "result") {
        // The helper answers each class in the order it received the commands -> match FIFO.
        const q = ev.digit === "N" ? h.switches : h.tones;
        const w = q.shift();
        if (!w) continue;
        clearTimeout(w.timer);
        if (ev.ok) w.resolve();
        else
          w.reject(
            new Error(ev.digit === "N" ? "the switch did not go out" : "open failed (tone not delivered)"),
          );
      }
    }
  }

  private helperReady(placeId: string): Helper {
    const h = this.helpers.get(placeId);
    if (!h) throw new Error(`unknown 2Voice place ${placeId}`);
    if (!h.child || !h.child.stdin?.writable)
      throw new Error(
        h.place.outgoingUser
          ? `2Voice helper for ${placeId} not ready (registering?)`
          : `station for ${placeId} not known yet`,
      );
    return h;
  }

  /** Write a command and wait for its reply line (queued in `queue`), rejecting after `timeoutMs`. */
  private command(h: Helper, queue: Waiter[], cmd: string, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const entry: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const i = queue.indexOf(entry);
          if (i >= 0) {
            queue.splice(i, 1);
            reject(new Error("no reply from the station helper in time"));
          }
        }, timeoutMs),
      };
      queue.push(entry);
      h.child!.stdin!.write(cmd + "\n");
    });
  }

  /** Open a 2Voice door/gate: the tone goes on the station call that is up (the camera being viewed,
   *  a pre-warm, the keep-alive after a press) or on one the helper places for it. Resolves when the
   *  helper reports RESULT ok; rejects on fail/timeout/dead helper. */
  open(placeId: string, kind: "door" | "gate" = "door"): Promise<void> {
    const h = this.helperReady(placeId);
    log.info(`opening ${kind} on 2Voice place ${placeId} (${h.place.name})`);
    // No busy-reject: the helper queues tones received while the call is setting up and sends them at
    // StreamsRunning, so a rapid second press (door then gate) isn't lost.
    return this.command(h, h.tones, DIGIT[kind], OPEN_TIMEOUT_MS);
  }

  /** Pre-warm a place's call (the "ready" button): open the station call NOW, with no tone, so the
   *  unlock press moments later rides an already-established call (instant). Fire-and-forget; the
   *  helper releases the bus on its own if no press follows, and does nothing when a call is up. */
  prewarm(placeId: string): boolean {
    const h = this.helpers.get(placeId);
    if (!h || !h.child || !h.child.stdin?.writable) return false;
    log.info(`pre-warming 2Voice call for ${placeId} (${h.place.name})`);
    h.child.stdin.write(HelperCommand.PREWARM + "\n");
    return true;
  }

  /** Hang up the station call NOW (the "hang up" button) rather than on its own idle timer; the camera
   *  stops with it. Resolves true when a camera picture was up. A dashboard card still showing the
   *  camera reconnects on its own and asks for a new call. */
  hangup(placeId: string): boolean {
    const h = this.helpers.get(placeId);
    if (!h?.child?.stdin?.writable) return false;
    const wasOn = h.camOn;
    log.info(`hanging up the 2Voice call for ${placeId} (${h.place.name})`);
    h.child.stdin.write(HelperCommand.RELEASE + "\n");
    return wasOn;
  }

  /** True while the helper holds the place's doorbell ring call (still ringing, or answered for an
   *  announcement / door press). */
  ringing(placeId: string): boolean {
    return this.helpers.get(placeId)?.ringing ?? false;
  }

  /** The place's name, for logs. */
  placeName(placeId: string): string | undefined {
    return this.helpers.get(placeId)?.place.name;
  }

  /** Get a call ready to carry an announcement (announce.ts): the helper places or keeps one, sends
   *  the open-audio digit once its media runs, and holds it while the clip plays. True when asked. */
  startTalk(placeId: string): boolean {
    const h = this.helpers.get(placeId);
    if (!h?.child?.stdin?.writable) return false;
    h.child.stdin.write(HelperCommand.TALK + "\n");
    return true;
  }

  // ---- video (opt-in) ----

  /** Serve one go2rtc stream per place with a station: `urmet_cam_<i>` -> stream.sh -> `/call?cam=i`
   *  -> the place's helper taps its call into the camera FIFOs. False when no place can have one. */
  async startVideo(ports: Go2rtcPorts): Promise<boolean> {
    const usable = this.places.filter((p) => p.incomingUser && p.incomingPw && p.outgoingUser);
    if (!usable.length) {
      log.warn("no 2Voice place with channel + station account; 2Voice video not started");
      return false;
    }
    // Camera i gets the same FIFO pair and go2rtc stream name as on the IPERCOM path (only one video
    // service runs at a time, index.ts; util.camFifos; stream.sh gets the paths as arguments).
    usable.forEach((p, i) => {
      const f = camFifos(i);
      this.cams.push({ place: p, h264: f.h264, pcm: f.pcm });
      makeFifos(f.h264, f.pcm);
    });
    log.info(`2Voice cameras: ${this.cams.map((c, i) => `[${i}] ${c.place.name}`).join(", ")}`);
    const handler: ControlHandler = (req, res) => {
      const u = new URL(req.url || "/", "http://127.0.0.1");
      const i = parseInt(u.searchParams.get("cam") || "0", 10) || 0;
      const cam = this.cams[i];
      if (!cam) return void res.writeHead(400).end("no such camera");
      if (u.pathname === "/call") {
        // Answers once the helper took the request, so stream.sh opens the FIFOs only after the
        // picture is on its way; 503 -> curl -f fails -> go2rtc shows the stream unavailable.
        this.camera(i).then(
          () => res.writeHead(200).end("ok"),
          (e) => {
            log.warn(`2Voice camera [${i}] ${cam.place.name}: ${(e as Error).message}`);
            res.writeHead(503).end((e as Error).message);
          },
        );
        return;
      }
      if (u.pathname === "/hangup") {
        this.hangup(cam.place.id);
        return void res.writeHead(200).end("ok");
      }
      res.writeHead(404).end();
    };
    const { server, port } = await listenControl(handler, "2Voice control endpoint");
    this.server = server;
    this.callPort = port;
    // go2rtc: one on-demand stream per camera, hardened config (see go2rtc.ts), auto-respawned.
    this.go2rtc = new Go2rtcProcess(() =>
      go2rtcConfig(this.cams.length, this.callPort, ports, isDebug()),
    );
    this.go2rtc.start();
    log.info(
      `2Voice video ready: go2rtc api :${ports.api}, rtsp :${ports.rtsp}, webrtc :${ports.webrtc}; control :${this.callPort}; ${this.cams.length} camera(s)`,
    );
    return true;
  }

  /** The places with a camera stream (one per usable 2Voice place; empty without startVideo). */
  placesServed(): string[] {
    return this.cams.map((c) => c.place.id);
  }

  /** Ask the place's helper to feed camera i: the picture of the call it has (the held ring with early
   *  media, as the app's "view camera"; the call being viewed or held) or of a camera call it places.
   *  Idempotent while the picture is on. */
  private camera(i: number): Promise<void> {
    const cam = this.cams[i];
    const h = this.helperReady(cam.place.id);
    if (h.camOn) return Promise.resolve();
    // A request already in flight (two viewers racing, go2rtc restarting the producer) is joined, not
    // repeated: re-making the FIFOs now would pull them from under the helper as it opens them.
    const pending = h.camWaiters.length > 0;
    if (!pending) {
      // (Re)make the FIFOs before the helper opens them: a stale reader-less FIFO from the previous
      // viewer could otherwise hold the old pipe buffer.
      makeFifos(cam.h264, cam.pcm);
      log.info(`2Voice camera [${i}] ${cam.place.name}: requesting the picture`);
    }
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (failure: string | undefined) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (failure) reject(new Error(failure));
        else resolve();
      };
      const timer = setTimeout(() => {
        const k = h.camWaiters.indexOf(finish);
        if (k >= 0) h.camWaiters.splice(k, 1);
        finish("no reply from the station helper");
      }, CAMERA_REPLY_MS);
      h.camWaiters.push(finish);
      if (!pending) h.child!.stdin!.write(cameraCommand(cam.h264, cam.pcm) + "\n");
    });
  }

  /** True while the place's camera picture is being fed. */
  hasCall(placeId: string): boolean {
    return this.helpers.get(placeId)?.camOn ?? false;
  }

  /** Switch the place's live call to the station's next entrance panel (issue #20): the helper sends
   *  the '3' on the live call while its audio is closed (like the app), or re-dials when the audio is
   *  open. False when no call is up (a new call starts on the first panel anyway) or the switch did
   *  not go out. */
  async nextCamera(placeId: string): Promise<boolean> {
    const h = this.helpers.get(placeId);
    if (!h?.child?.stdin?.writable) return false;
    try {
      await this.command(h, h.switches, HelperCommand.NEXT_CAMERA, SWITCH_TIMEOUT_MS);
      return true;
    } catch (e) {
      log.info(`next camera on ${h.place.name}: ${(e as Error).message}`);
      return false;
    }
  }

  /** Stop go2rtc and every helper; resolves once they exited (each BYEs a held call on the way out) or
   *  after a bounded wait, so the caller can exit the process without cutting a BYE short. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.server?.close();
    this.go2rtc?.stop();
    const children: ChildProcess[] = [];
    for (const h of this.helpers.values()) {
      for (const w of [...h.tones, ...h.switches]) clearTimeout(w.timer);
      h.tones = [];
      h.switches = [];
      h.child?.removeAllListeners("exit");
      try {
        h.child?.stdin?.end(); // closes the helper's stdin -> it exits cleanly
      } catch {
        /* ignore */
      }
      h.child?.kill("SIGTERM");
      if (h.child) children.push(h.child);
    }
    this.helpers.clear();
    await Promise.all(children.map((c) => waitForExit(c, 2500)));
  }
}
