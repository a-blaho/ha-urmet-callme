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
import { Go2rtcPorts, Go2rtcProcess, go2rtcConfig } from "./go2rtc.js";
import { logger } from "./logger.js";

const log = logger("video");

/** A stable RFC 5626 `+sip.instance` UUID derived from `seed`, so a liblinphone helper keeps the
 *  SAME instance id across restarts (its `/tmp` config is wiped with the container). Without this a
 *  restart/recall ADDS a registrar binding instead of replacing ours, and the registrar forks calls
 *  to the stale ones until they expire (see recv.c / opendoor.c). Callers pass distinct seeds
 *  (`urmet-recv:...` vs `urmet-opendoor:...`) so co-registered helpers never collide. */
export function deterministicUuid(seed: string): string {
  const h = createHash("md5").update(seed).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
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
// Gap between the END of the previous call (recv's /ended ping: our BYE was answered) and the
// re-call on an active switch. The app sends its next call_device_req ~0.6s after the BYE's 200 OK.
const SWITCH_SETTLE_MS = 600;
// How long cancel() waits for recv to confirm the call is over before giving up and moving on. A
// BYE round-trip through the relay is a few hundred ms; anything longer means recv had no call.
const END_WAIT_MS = 2500;

/** A persisted SIP account B (shared across cameras - one video call at a time). */
interface StoredAccount {
  username: string;
  password: string;
  realm: string;
  email: string; // whose login created it - invalidate the cache if the configured email changes
  expiryMs: number; // ~180 days out (matches the expiry encoded in the cfwunique_ username)
}

interface Cam {
  placeId: string; // the IPERCOM place this camera belongs to (its gateway takes the call)
  dev: AvailableDevice;
  fifo: string; // per-camera Annex-B (H.264) FIFO
  afifo: string; // per-camera audio FIFO (raw PCM s16le 8k mono; recv forces G.711)
}

export class VideoService {
  private go2rtc?: Go2rtcProcess;
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
  // The camera whose call recv holds RIGHT NOW (set on /connected, cleared on /ended). This is the
  // ground truth for "is there a dialog to BYE / to reuse", independent of our own bookkeeping.
  private liveCall: number | null = null;
  private endWaiters: Array<() => void> = []; // cancel()s waiting for recv's /ended ping
  private placedAt = new Map<number, number>(); // camera -> epoch ms its call_device_req went out (timing)
  private busyTimers = new Map<number, ReturnType<typeof setTimeout>>(); // no-INVITE watchdogs
  private opChain: Promise<unknown> = Promise.resolve(); // serializes call/cancel (see serialize)
  private stopping = false;
  private server?: Server; // the /call + /hangup control endpoint (closed in stop())
  private callPort = 0; // ephemeral control port (avoids a fixed-8099 host-network clash, e.g. Zigbee2MQTT)

  constructor(
    private callme: CallMe,
    private placeIds: string[], // the IPERCOM places whose cameras to serve (never a 2Voice place)
    private email: string,
    private password: string,
    private ports: Go2rtcPorts,
  ) {}

  async start(): Promise<boolean> {
    const realm = this.callme.realm;
    // Cameras from EVERY IPERCOM place, each remembering its place: every call/cancel must name the
    // place explicitly so it goes to THAT place's gateway. (CallMe's place-less default is the
    // cloud's first place, which on a multi-place or mixed account is not necessarily an IPERCOM
    // one.) A place whose gateway is unreachable is skipped, not fatal for the others.
    const found: { placeId: string; dev: AvailableDevice }[] = [];
    for (const placeId of this.placeIds) {
      try {
        const devices = await this.callme.listDevices(placeId);
        for (const dev of devices)
          if (dev.callType === "calling_station") found.push({ placeId, dev });
      } catch (e) {
        log.warn(
          `place ${placeId}: camera discovery failed (${(e as Error).message}); skipping its cameras`,
        );
      }
    }
    if (!found.length) {
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

    for (let i = 0; i < found.length; i++) {
      this.cams.push({
        placeId: found[i].placeId,
        dev: found[i].dev,
        fifo: `/tmp/urmet_cam_${i}.h264`,
        afifo: `/tmp/urmet_cam_${i}.pcm`,
      });
    }
    log.info(
      `cameras: ${this.cams.map((c, i) => `[${i}] ${c.dev.name} (place ${c.placeId})`).join(", ")}`,
    );
    // Bind the control endpoint FIRST so its (ephemeral) port is known before recv/go2rtc use it.
    await this.serveCallEndpoint();
    this.spawnRecv(a.password);

    // go2rtc: one on-demand stream per camera, hardened config (see go2rtc.ts), auto-respawned.
    this.go2rtc = new Go2rtcProcess(() =>
      go2rtcConfig(this.cams.length, this.callPort, this.ports),
    );
    this.go2rtc.start();
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
        RECV_ENDED_URL: `http://127.0.0.1:${this.callPort}/ended`, // dialog over -> a switch may re-call
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

  // The call options for camera i; every call/cancel also passes this.cams[i].placeId so the
  // request goes to THAT place's gateway (see start()).
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
  // `keepSlot`: placeCall() re-calling the SAME camera must keep owning the slot across its own
  // teardown, or a concurrent /call for another camera sees a free slot and skips the switch path
  // (no BYE for this one -> two calls stacked on account B).
  private async cancel(i: number, keepSlot = false) {
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
    // Poke the shared recv: if it holds a call it sends the in-dialog BYE (the teardown); if not,
    // SIGUSR1 is a no-op. Send it EVERY time the process is alive. (Do NOT gate on
    // ChildProcess.killed: Node sets that after ANY successful kill(), so it went true on the first
    // SIGUSR1 ever sent and every later switch silently skipped the BYE -- the panel then kept the
    // old call, liblinphone PAUSED it when the next INVITE arrived, and that zombie on-hold call
    // blocked every following camera request for minutes. This was the "inconsistent switching".)
    const recvAlive =
      !!this.recv && this.recv.exitCode === null && this.recv.signalCode === null;
    // Wait for recv's /ended ping when it really holds a dialog: the next call_device_req must go
    // out AFTER the BYE is answered (the app's sequence), not race it.
    const ended = this.liveCall !== null ? this.waitForEnd() : null;
    if (recvAlive) {
      try {
        this.recv!.kill("SIGUSR1"); // -> recv.c on_sigusr1 -> linphone_call_terminate (in-dialog BYE)
      } catch (e) {
        log.warn(`recv BYE failed: ${(e as Error).message}`);
      }
    }
    if (ended) {
      const t0 = Date.now();
      const ok = await ended;
      log.info(
        `ended video call to [${i}] ${this.cams[i].dev.name} (recv BYE ${ok ? `answered in ${Date.now() - t0}ms` : `not confirmed within ${END_WAIT_MS}ms`})`,
      );
    } else if (wasConnected) {
      log.info(
        `ended video call to [${i}] ${this.cams[i].dev.name} (recv had no dialog)`,
      );
    } else {
      // Never connected: the panel may still be ringing the door station with no INVITE to our
      // recv (nothing to BYE) -> abort it at the gateway.
      try {
        await this.callme.cancelCall(this.optsFor(i), this.cams[i].placeId);
        log.info(
          `cancelled ringing video call to [${i}] ${this.cams[i].dev.name}`,
        );
      } catch (e) {
        log.warn(`cancel_call [${i}] failed: ${(e as Error).message}`);
      }
    }
    this.streaming.delete(i);
    if (this.slotHolder === i && !keepSlot) this.slotHolder = null; // free the single video slot
  }

  // Resolve true when recv pings /ended, false after END_WAIT_MS.
  private waitForEnd(): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.endWaiters = this.endWaiters.filter((w) => w !== done);
        resolve(false);
      }, END_WAIT_MS);
      const done = () => {
        clearTimeout(timer);
        resolve(true);
      };
      this.endWaiters.push(done);
    });
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
    // REUSE a live call: the viewer of THIS camera came back (or go2rtc restarted its producer)
    // while recv still holds the call -- within recv's reader-idle window. Nothing to BYE, nothing
    // to re-call: the new ffmpeg just reads the FIFO. Nudge one keyframe so it decodes at once
    // instead of at the panel's next periodic IDR. This is the instant flip-back.
    if (this.liveCall === idx && this.connected.has(idx)) {
      log.info(
        `reusing live video call to [${idx}] ${this.cams[idx].dev.name} (keyframe nudge)`,
      );
      try {
        this.recv?.kill("SIGUSR2");
      } catch {
        /* recv gone; its respawn path recovers */
      }
      return;
    }
    if (this.streaming.has(idx)) await this.cancel(idx, true); // stale prior call for THIS camera -> clean BYE, keep the slot
    this.writeTarget(idx); // point the shared recv at THIS camera's FIFOs before it answers
    this.placedAt.set(idx, Date.now());
    await this.callme.callDevice(this.optsFor(idx), this.cams[idx].placeId);
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
        this.liveCall = idx;
        this.clearBusyTimer(idx);
        const placed = this.placedAt.get(idx);
        log.info(
          `camera [${idx}] ${this.cams[idx].dev.name}: video established` +
            (placed ? ` (${Date.now() - placed}ms after the request)` : ""),
        );
        return void res.writeHead(200).end("ok");
      }
      if (u.pathname === "/ended") {
        // recv's dialog is over (our BYE answered, or the panel hung up). Release whoever waits in
        // cancel(); a call the PANEL ended on its own just drops out of the live bookkeeping.
        // (`connected` is left to cancel(): clearing it here would make the follow-up /hangup of a
        // normal idle teardown look like a never-connected call and send a needless gateway cancel.)
        const was = this.liveCall;
        this.liveCall = null;
        const waiters = this.endWaiters;
        this.endWaiters = [];
        for (const w of waiters) w();
        if (!waiters.length && was !== null)
          log.info(`video call to [${was}] ${this.cams[was].dev.name} ended (by the panel or recv idle)`);
        return void res.writeHead(200).end("ok");
      }
      if (u.pathname !== "/call") return void res.writeHead(404).end();

      // ONE VIDEO CALL AT A TIME, with an ACTIVE SWITCH. If another camera holds the slot, BYE the
      // current call, wait for recv to confirm the dialog is over (cancel() awaits /ended), settle
      // SWITCH_SETTLE_MS like the app, then re-call this camera on the same shared account.
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
        const t0 = now;
        this.serialize(async () => {
          await this.cancel(prev); // in-dialog BYE on the shared account, awaited to its end
          await new Promise((r) => setTimeout(r, SWITCH_SETTLE_MS)); // the app's post-BYE gap
          log.info(`switch: previous call down, re-calling after ${Date.now() - t0}ms`);
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
    this.go2rtc?.stop();
  }
}
