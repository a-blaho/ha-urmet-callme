// Video service (optional; enabled by the `video` add-on option). Wires the media path
// into the add-on. ONE SHARED account, ONE `recv`, ONE video call at a time (see the class header):
//   - one shared dedicated SIP account B and one `recv` (embedded liblinphone) for ALL cameras
//   - recv registers B, auto-answers the current camera's INVITE, and taps the received H.264
//     (no re-encode) to that camera's FIFO (it reads which FIFO from a control file per call)
//   - go2rtc serves one on-demand stream per camera, each reading its own FIFO
//   - GET /call?cam=<i> places the call (shared account A -> camera i, routed to account B via the
//     split-account trick), refusing/actively-switching if another camera holds the single slot;
//     /hangup?cam=<i> ends it (in-dialog SIP BYE from recv)
//
// The door station serves ~one video call at a time, so switching cameras BYEs the current call
// then re-calls on the same account. See ../video-recv/INTEGRATION.md.
import { ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, Server } from "node:http";
import { AvailableDevice, CallMe } from "./callme.js";
import { Cloud } from "./cloud.js";
import { logger } from "./logger.js";

const log = logger("video");
const GO2RTC_CFG = "/tmp/go2rtc.yaml";

/** A stable RFC 5626 `+sip.instance` UUID derived from `seed`, so a liblinphone helper keeps the
 *  SAME instance id across restarts (its `/tmp` config is wiped with the container). Without this a
 *  restart/recall ADDS a registrar binding instead of replacing ours, and the registrar forks calls
 *  to the stale ones until they expire (see recv.c / opendoor.c). Callers pass distinct seeds
 *  (`urmet-recv:...` vs `urmet-opendoor:...`) so co-registered helpers never collide. */
export function deterministicUuid(seed: string): string {
  const h = createHash("md5").update(seed).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** Ports the embedded go2rtc binds. Configurable so the add-on can coexist with a user's OWN go2rtc
 *  add-on (which typically owns 1984/8554/8555). Under host networking these bind directly on the
 *  host, so they must be free. The `api` port is the one the WebRTC card's `server:` points at. */
export interface Go2rtcPorts {
  api: number;
  rtsp: number;
  webrtc: number;
  // Optional LAN IP to advertise as the WebRTC ICE candidate. Needed only in bridge networking (no
  // host_network): go2rtc otherwise advertises its internal Docker IP, which the browser can't reach.
  // With host networking this is empty (go2rtc sees the real interface itself).
  candidateIp?: string;
}

/** The go2rtc `webrtc:` config line - adds an explicit ICE candidate when candidateIp is set
 *  (bridge networking), otherwise just listens (host networking, go2rtc gathers its own). */
export function webrtcListen(ports: Go2rtcPorts): string {
  return ports.candidateIp
    ? `webrtc: { listen: ":${ports.webrtc}", candidates: [ "${ports.candidateIp}:${ports.webrtc}" ] }`
    : `webrtc: { listen: ":${ports.webrtc}" }`;
}
// How long recv keeps a call alive after its FIFO stops being drained (viewer gone) before it
// hangs up. This clock only starts once streaming actually begins (recv.c starts it at the first
// keyframe, not at "streams running"), so it measures a genuine reader gap, not startup. Long
// enough to (a) let a viewer attach and start pulling after the keyframe, and (b) ride out a
// go2rtc/WebRTC reconnect blip. The call is freed promptly on close by /hangup anyway; this idle
// is just the backstop, so keep it conservative.
const RECV_IDLE_SECONDS = 10;
// The shared account B, persisted in HA's add-on storage so we reuse it across restarts instead
// of minting (and orphaning) a fresh cloud account every start. Delete it to force a fresh account.
const ACCOUNTS_FILE = "/data/video_accounts.json";
// The recv reads its per-call output FIFO paths from here (line 0 = H.264, line 1 = PCM). The
// control plane writes this BEFORE placing each call, so the single shared recv taps whichever
// camera is currently being viewed. See recv.c read_target_line().
const TARGET_FILE = "/tmp/recv_target";
// After an active switch displaces a camera, ignore that camera's own /call for this long, so two
// simultaneously-visible cards can't ping-pong the single slot back and forth.
const SWITCH_DEBOUNCE_MS = 4000;
// Gap between the BYE and the re-call on an active switch -- just enough for the BYE to reach the
// panel before the next INVITE.
const SWITCH_SETTLE_MS = 400;

/** A persisted SIP account B (shared across cameras - one video call at a time). */
interface StoredAccount {
  username: string;
  password: string;
  realm: string;
  email: string; // whose login created it - invalidate the cache if the configured email changes
  expiryMs: number; // ~180 days out (matches the expiry encoded in the cfwunique_ username)
}

interface Cam {
  dev: AvailableDevice;
  fifo: string; // per-camera Annex-B (H.264) FIFO
  afifo: string; // per-camera audio FIFO (raw PCM s16le 8k mono; recv forces G.711)
}

export class VideoService {
  private go2rtc?: ChildProcess;
  private cams: Cam[] = [];
  // SINGLE SHARED SIP account + SINGLE recv for ALL camera calls, ONE VIDEO CALL AT A TIME. One
  // account is used and cameras are switched with an in-dialog BYE + an immediate re-call on the
  // SAME account. With a SEPARATE account per camera, switching costs ~30-40s because the panel
  // keeps the other camera "busy" until the abandoned session times out; on ONE account the panel
  // frees instantly, so switching is fast. The panel also can't reliably serve two concurrent
  // streams anyway, so the /call endpoint REFUSES a second camera while one holds the slot (see
  // slotHolder). The recv taps whichever camera is currently called to that camera's FIFO -- it
  // reads the target FIFO from TARGET_FILE, which placeCall writes before each call.
  private sharedBUser = ""; // the one shared camera account (cfwunique_)
  private sharedBUri = ""; // sip:<sharedBUser>@realm - every call's uri_to_call / response_uri
  private recv?: ChildProcess; // the single media receiver, registered as the shared account
  private slotHolder: number | null = null; // the one camera allowed to stream now (null = free)
  private displacedAt = new Map<number, number>(); // camera -> epoch ms it was last switched away (debounce)
  private streaming = new Set<number>(); // cameras with a call currently placed (bookkeeping)
  private connected = new Set<number>(); // cameras whose recv reported media running
  private busyTimers = new Map<number, ReturnType<typeof setTimeout>>(); // no-INVITE watchdogs
  private opChain: Promise<unknown> = Promise.resolve(); // serializes call/cancel (see serialize)
  private stopping = false;
  private server?: Server; // the /call + /hangup control endpoint (closed in stop())
  private callPort = 0; // ephemeral control port (avoids a fixed-8099 host-network clash, e.g. Zigbee2MQTT)

  constructor(
    private callme: CallMe,
    private email: string,
    private password: string,
    private ports: Go2rtcPorts,
  ) {}

  async start(): Promise<boolean> {
    const realm = this.callme.realm;
    const devices = (await this.callme.listDevices()).filter(
      (d) => d.callType === "calling_station",
    );
    if (!devices.length) {
      log.warn("no camera devices (calling_station) found; video not started");
      return false;
    }

    // ONE shared cfwunique_ account for ALL camera calls (one video call at a time; see the class
    // header). Persisted + reused across restarts (keyed "shared") so we don't mint/orphan an
    // account each start. Recreate only when missing/expiring; the cloud login is lazy, so a cache
    // hit places no cloud calls. (Old builds stored a per-camera account keyed by topologicalCode;
    // those keys are simply ignored now and expire on the cloud in ~180 days.)
    const store = this.loadAccounts();
    const WEEK = 7 * 24 * 3600 * 1000;
    const cached = store["shared"];
    const reuse =
      !!cached &&
      cached.email === this.email &&
      cached.realm === realm &&
      cached.expiryMs - Date.now() > WEEK;
    let account = cached;
    if (!reuse) {
      const cloud = new Cloud();
      await cloud.login(this.email, this.password);
      const b = await cloud.createUniqueSipAccount(this.email, realm);
      account = {
        username: b.username,
        password: b.password,
        realm,
        email: this.email,
        expiryMs: Date.now() + 180 * 24 * 3600 * 1000,
      };
      store["shared"] = account;
      this.saveAccounts(store);
    }
    const a = account!; // defined: reused cache hit, or freshly created just above
    this.sharedBUser = a.username;
    this.sharedBUri = `sip:${a.username}@${realm}`;
    log.info(`shared camera account B: ${reuse ? "reused" : "created"}`);

    for (let i = 0; i < devices.length; i++) {
      this.cams.push({
        dev: devices[i],
        fifo: `/tmp/urmet_cam_${i}.h264`,
        afifo: `/tmp/urmet_cam_${i}.pcm`,
      });
    }
    log.info(
      `cameras: ${this.cams.map((c, i) => `[${i}] ${c.dev.name}`).join(", ")}`,
    );
    // Bind the control endpoint FIRST so its (ephemeral) port is known before recv/go2rtc use it.
    await this.serveCallEndpoint();
    this.spawnRecv(a.password);

    writeFileSync(GO2RTC_CFG, this.go2rtcConfig());
    this.spawnGo2rtc();
    log.info(
      `video ready: go2rtc api :${this.ports.api}, rtsp :${this.ports.rtsp}, webrtc :${this.ports.webrtc}; control :${this.callPort}; ${this.cams.length} camera(s)`,
    );
    return true;
  }

  private loadAccounts(): Record<string, StoredAccount> {
    try {
      return JSON.parse(readFileSync(ACCOUNTS_FILE, "utf8"));
    } catch {
      return {}; // first run (no file) or dev mode without a writable /data
    }
  }

  private saveAccounts(store: Record<string, StoredAccount>) {
    try {
      writeFileSync(ACCOUNTS_FILE, JSON.stringify(store, null, 2));
    } catch (e) {
      log.warn(
        `could not persist video accounts (${(e as Error).message}); will re-create next start`,
      );
    }
  }

  // go2rtc, auto-respawned like recv (a crash otherwise leaves video dead until add-on restart).
  private spawnGo2rtc() {
    if (this.stopping) return;
    this.go2rtc = spawn("go2rtc", ["-config", GO2RTC_CFG], {
      stdio: "inherit",
    });
    this.go2rtc.on("exit", (c) => {
      if (this.stopping) return;
      log.warn(`go2rtc exited (code ${c}); respawning in 3s`);
      setTimeout(() => this.spawnGo2rtc(), 3000);
    });
  }

  // The SINGLE media receiver, registered as the shared account. It answers whatever camera call the
  // control plane places and taps it to the FIFO pair named in TARGET_FILE (set by placeCall before
  // each call). recv's /hangup and /connected pings carry no cam index -> the handler resolves them
  // to the current slotHolder.
  private spawnRecv(pass: string) {
    if (this.stopping) return; // don't resurrect while shutting down
    // (Re)create every camera's FIFO pair as real FIFOs (recv opens O_RDWR|O_CREAT; without a real
    // FIFO here O_CREAT would make a plain file). Only the currently-targeted pair is written to.
    for (const cam of this.cams) {
      for (const fifo of [cam.fifo, cam.afifo]) {
        try {
          unlinkSync(fifo);
        } catch {
          /* not there */
        }
        execFileSync("mkfifo", [fifo]);
      }
    }
    this.writeTarget(0); // default target before the first placeCall
    const dataDir = `/tmp/lp_shared/`; // trailing slash: liblinphone appends the db filename
    mkdirSync(dataDir, { recursive: true });
    this.recv = spawn("recv", [this.sharedBUser, pass], {
      env: {
        ...process.env,
        RECV_TARGET_FILE: TARGET_FILE, // per-call output FIFOs (line 0 = H.264, line 1 = PCM)
        RECV_DATA_DIR: dataDir,
        // Stable instance id: this single recv registers account B across respawns/camera switches;
        // without it each restart would leave a stale binding on B (see deterministicUuid).
        RECV_UUID: deterministicUuid(`urmet-recv:${this.sharedBUser}`),
        // No cam index: there's one call at a time; the handler maps these to the current slotHolder.
        RECV_HANGUP_URL: `http://127.0.0.1:${this.callPort}/hangup`,
        RECV_CONNECTED_URL: `http://127.0.0.1:${this.callPort}/connected`,
        RECV_IDLE_SECONDS: String(RECV_IDLE_SECONDS),
      },
      stdio: "inherit",
    });
    this.recv.on("exit", (code) => {
      if (this.stopping) return;
      log.warn(`recv exited (code ${code}); respawning in 3s`);
      setTimeout(() => this.spawnRecv(pass), 3000);
    });
  }

  // Point recv at camera i's FIFOs for its NEXT answered call. recv re-reads this when it builds the
  // per-call tap, so writing it before placeCall routes the shared receiver to the right stream.
  private writeTarget(i: number) {
    try {
      writeFileSync(
        TARGET_FILE,
        `${this.cams[i].fifo}\n${this.cams[i].afifo}\n`,
      );
    } catch (e) {
      log.warn(`could not write recv target (${(e as Error).message})`);
    }
  }

  private go2rtcConfig(): string {
    // One stream per camera. stream.sh emits H.264 + BOTH AAC and Opus audio tracks, so go2rtc
    // serves the right codec per consumer from this single stream -- AAC to HA's Generic Camera /
    // HLS, Opus to WebRTC (iframe / go2rtc UI / WebRTC cards). No separate `_webrtc` stream and no
    // `ffmpeg:<stream>` transcode chain (that raced the on-demand exec producer and 404'd). All
    // viewers point at `urmet_cam_<i>`.
    // starttimeout: how long go2rtc waits for stream.sh's ffmpeg to connect back via RTSP before
    // giving up with "exec: timeout" (default 30s, RTSP mode, added go2rtc v1.9.14). An active
    // SWITCH to a second camera can exceed 30s: BYE the current call + settle + the panel's slow,
    // variable post-teardown INVITE (~5-35s) + the camera's keyframe/black warm-up. Raise it to 60s
    // so a slow switch still lands instead of erroring the consumer out.
    const streams = this.cams
      .map(
        (_, i) =>
          `  urmet_cam_${i}: "exec:/app/stream.sh ${i} {output} ${this.callPort}#starttimeout=60"`,
      )
      .join("\n");
    return [
      "streams:",
      streams,
      `api: { listen: ":${this.ports.api}" }`,
      `rtsp: { listen: ":${this.ports.rtsp}" }`,
      webrtcListen(this.ports),
      "",
    ].join("\n");
  }

  private optsFor(i: number) {
    const cam = this.cams[i];
    return {
      topologicalCode: cam.dev.topologicalCode,
      vdsTypes: cam.dev.vdsTypes,
      displayName: cam.dev.name,
      responseUri: this.sharedBUri, // route the panel INVITE to the ONE shared account (recv)
    };
  }

  // Arm/cancel the "no INVITE arrived" watchdog for a camera. If recv never reports media (no
  // /connected) within the window, the panel silently withheld the INVITE -- which is how a busy
  // camera (or a monitor not set to "remote") manifests; there's no error message from the panel.
  private armBusyTimer(i: number) {
    this.clearBusyTimer(i);
    this.busyTimers.set(
      i,
      setTimeout(() => {
        this.busyTimers.delete(i);
        log.warn(
          `camera [${i}] ${this.cams[i]?.dev.name}: no video after 10s - the panel didn't send ` +
            `the call. Likely BUSY (the Urmet app or another viewer has THIS camera) or the ` +
            `indoor monitor isn't set to "remote".`,
        );
        // This camera claimed the single slot but never streamed (dead/busy) - free it so another
        // camera can be viewed instead of being blocked behind a camera that isn't working.
        if (this.slotHolder === i && !this.connected.has(i))
          this.slotHolder = null;
      }, 10000),
    );
  }

  private clearBusyTimer(i: number) {
    const t = this.busyTimers.get(i);
    if (t) {
      clearTimeout(t);
      this.busyTimers.delete(i);
    }
  }

  // End the current call for camera i with a clean IN-DIALOG SIP
  // BYE from the shared account (our recv) to the door station. There is only ONE call at a time, so
  // this is a no-op unless i is the current camera. On the SAME shared account the panel frees the
  // channel instantly, so the next camera's call connects fast (this is the whole point of the
  // single-account model -- with separate accounts the switch cost ~30-40s of "busy").
  private async cancel(i: number) {
    if (!this.cams[i]) return;
    // Ignore a stale hangup for a camera that isn't the current one (there's only one live call).
    if (
      this.slotHolder !== null &&
      this.slotHolder !== i &&
      !this.streaming.has(i)
    )
      return;
    const wasConnected = this.connected.has(i);
    this.clearBusyTimer(i);
    this.connected.delete(i);
    // Poke the shared recv: if it holds a call it sends the in-dialog BYE (the teardown);
    // if not, SIGUSR1 is a no-op. Covers the race where the dialog is up but /connected hasn't landed.
    if (this.recv && !this.recv.killed) {
      try {
        this.recv.kill("SIGUSR1"); // -> recv.c on_sigusr1 -> linphone_call_terminate (in-dialog BYE)
      } catch (e) {
        log.warn(`recv BYE failed: ${(e as Error).message}`);
      }
    }
    if (wasConnected) {
      log.info(
        `ended video call to [${i}] ${this.cams[i].dev.name} (recv BYE)`,
      );
    } else {
      // Never connected: the panel may still be ringing the door station with no INVITE to our
      // recv (nothing to BYE) -> abort it at the gateway.
      try {
        await this.callme.cancelCall(this.optsFor(i));
        log.info(
          `cancelled ringing video call to [${i}] ${this.cams[i].dev.name}`,
        );
      } catch (e) {
        log.warn(`cancel_call [${i}] failed: ${(e as Error).message}`);
      }
    }
    this.streaming.delete(i);
    if (this.slotHolder === i) this.slotHolder = null; // free the single video slot for the next camera
  }

  // Run call-control ops ONE AT A TIME, in arrival order, so a camera's own /call and /hangup
  // (which go2rtc can fire close together on a producer restart) can't interleave their place and
  // cancel out of order. This is just ordering; the one-at-a-time arbitration is in the /call handler.
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.opChain.then(fn, fn); // run after the previous op, whatever its outcome
    this.opChain = run.catch(() => {}); // keep the chain alive if this op throws
    return run;
  }

  // Place the call for camera idx. The one-at-a-time arbitration is done in the /call handler (it
  // refuses a second camera while one holds the slot), so here we just place idx -- BYEing any stale
  // call of its OWN first so we don't stack a duplicate on the same account B. Serialized via
  // serialize(); never call directly.
  private async placeCall(idx: number) {
    if (this.streaming.has(idx)) await this.cancel(idx); // stale prior call for THIS camera -> clean BYE
    this.writeTarget(idx); // point the shared recv at THIS camera's FIFOs before it answers
    await this.callme.callDevice(this.optsFor(idx));
    this.streaming.add(idx);
    log.info(`placed video call to [${idx}] ${this.cams[idx].dev.name}`);
    // Watchdog: if recv doesn't report media within a few seconds, the panel never sent the
    // INVITE - surface WHY the camera is black (busy / not in remote mode). Skip if already up.
    if (!this.connected.has(idx)) this.armBusyTimer(idx);
  }

  // go2rtc's stream.sh calls /call?cam=<i> (on view) and /hangup?cam=<i> (viewer left). The shared
  // recv also calls /hangup and /connected with NO cam index -> those resolve to the current
  // slotHolder (there's only one live call).
  private serveCallEndpoint(): Promise<void> {
    this.server = createServer(async (req, res) => {
      const u = new URL(req.url || "/", "http://127.0.0.1");
      const camParam = u.searchParams.get("cam");
      // No cam index (recv's pings) -> the current camera. With one, fall back to 0.
      const idx =
        camParam !== null
          ? parseInt(camParam, 10) || 0
          : (this.slotHolder ?? 0);
      if (!this.cams[idx]) return void res.writeHead(400).end("no such camera");

      if (u.pathname === "/hangup") {
        await this.serialize(() => this.cancel(idx));
        return void res.writeHead(200).end("ok");
      }
      if (u.pathname === "/connected") {
        // recv reported media running -> the call really connected; cancel the busy watchdog.
        this.connected.add(idx);
        this.clearBusyTimer(idx);
        log.info(
          `camera [${idx}] ${this.cams[idx].dev.name}: video established`,
        );
        return void res.writeHead(200).end("ok");
      }
      if (u.pathname !== "/call") return void res.writeHead(404).end();

      // ONE VIDEO CALL AT A TIME, with an ACTIVE SWITCH. If another camera holds the slot, BYE the
      // current call, let the BYE reach the panel (SWITCH_SETTLE_MS), then re-call this camera on
      // the same shared account. NOTE: switching cameras is slow/variable (~5-35s) regardless of
      // this settle -- after a teardown the panel enters a variable "busy" window before it will
      // serve the next camera. This is not a proven hard limit (the panel is capable of a
      // consistent ~9s switch); the variance is an open item, not something the settle fixes.
      // Debounce the just-displaced camera briefly so two overlapping viewers can't ping-pong the
      // slot back and forth (only relevant if both cards are visible at once; with cameras on
      // separate views this never triggers). Claim the slot synchronously so concurrent /call
      // requests serialize correctly.
      const now = Date.now();
      if (this.slotHolder !== null && this.slotHolder !== idx) {
        if (now - (this.displacedAt.get(idx) ?? 0) < SWITCH_DEBOUNCE_MS) {
          return void res.writeHead(503).end("switch debounced"); // avoid ping-pong
        }
        const prev = this.slotHolder;
        this.displacedAt.set(prev, now);
        this.slotHolder = idx;
        res.writeHead(200).end("ok");
        log.info(
          `switching video: [${prev}] ${this.cams[prev].dev.name} -> [${idx}] ${this.cams[idx].dev.name}`,
        );
        this.serialize(async () => {
          await this.cancel(prev); // in-dialog BYE on the shared account
          await new Promise((r) => setTimeout(r, SWITCH_SETTLE_MS)); // let the BYE reach the panel
          await this.placeCall(idx); // fresh call on the SAME account after the panel has released
        }).catch((e) =>
          log.error(`video switch [${idx}] failed: ${(e as Error).message}`),
        );
        return;
      }
      this.slotHolder = idx;
      res.writeHead(200).end("ok"); // ack instantly; place the call in the background
      this.serialize(() => this.placeCall(idx)).catch((e) =>
        log.error(`video call [${idx}] failed: ${(e as Error).message}`),
      );
    });
    // Without an 'error' handler an EADDRINUSE (e.g. a respawn race) is an unhandled 'error'
    // event that crashes the process.
    this.server.on("error", (e) =>
      log.error(`call endpoint error: ${(e as Error).message}`),
    );
    // Ephemeral port (0): the OS picks a free one, so a fixed-port host-network clash can't happen.
    // The chosen port is handed to recv (RECV_*_URL) and stream.sh (argv $3).
    return new Promise<void>((resolve) => {
      this.server!.listen(0, "127.0.0.1", () => {
        const addr = this.server!.address();
        this.callPort = typeof addr === "object" && addr ? addr.port : 0;
        log.info(`control endpoint on 127.0.0.1:${this.callPort}`);
        resolve();
      });
    });
  }

  stop() {
    this.stopping = true;
    for (const t of this.busyTimers.values()) clearTimeout(t);
    this.busyTimers.clear();
    this.server?.close();
    this.recv?.removeAllListeners("exit");
    this.recv?.kill("SIGTERM");
    this.go2rtc?.removeAllListeners("exit"); // don't let the exit handler respawn during shutdown
    this.go2rtc?.kill("SIGTERM");
  }
}
