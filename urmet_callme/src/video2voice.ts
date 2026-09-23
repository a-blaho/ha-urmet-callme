// 2Voice video (opt-in `video`). 2Voice has NO on-demand camera call (that's IPERCOM's split-account
// call_device_req). Instead the panel sends its H.264 on the `auto_insertion` call -- the SAME call
// opendoor places to unlock (that's why an audio-only offer got 403'd: it's a video entry call). So
// per 2Voice place we run `recv` in OUTGOING mode (RECV_CALL_URI = the OUT account): it registers the
// channel account, places an audio+video auto_insertion call, and taps the H.264/audio to go2rtc via
// the SAME stream.sh pipeline as the IPERCOM receiver.
//
// Because the camera call IS the door call, a door/gate press while the camera is being viewed is
// sent as a DTMF tone on recv's live call (sendTone; recv reads '1'/'2' on its stdin and answers
// `RESULT <d> ok|fail`), exactly as the app unlocks while viewing. A second call from opendoor would
// collide with ours at the station. TwoVoiceService routes presses here via its videoOpener hook.
//
// This is a slimmed video.ts: no shared account B (2Voice uses the channel account it already has), no
// call_device_req/gateway, no slot-switching (each place is independent, one recv per place, spawned
// on demand). The go2rtc + stream.sh + FIFO/keyframe machinery is shared with the IPERCOM path,
// reused as-is.
import { spawn, execFileSync, ChildProcess } from "node:child_process";
import { writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { createServer, Server } from "node:http";
import { Place } from "./callme.js";
import { macHeaderOf, NoLiveCallError } from "./door2voice.js";
import { Go2rtcPorts, Go2rtcProcess, go2rtcConfig } from "./go2rtc.js";
import { isDebug, logger } from "./logger.js";
import { isAlive, waitForExit } from "./proc.js";
import { parseResult } from "./util.js";
import { deterministicUuid } from "./video.js";

const log = logger("video2v");
const RECV_IDLE_SECONDS = 10; // recv hangs up (and exits) after no FIFO reader for this long
// How long a tone sent on the camera call may take to be confirmed. A tone on a running call is
// answered at once; one queued during call setup waits for the station's media (a few seconds).
const TONE_TIMEOUT_MS = 20000;

interface Cam {
  place: Place;
  fifo: string; // per-camera Annex-B (H.264) FIFO
  afifo: string; // per-camera audio FIFO (raw PCM s16le 8k mono; recv forces G.711)
}

interface PendingTone {
  resolve: () => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class TwoVoiceVideoService {
  private go2rtc?: Go2rtcProcess;
  private cams: Cam[] = [];
  private recvs = new Map<number, ChildProcess>(); // camera idx -> its live recv (absent = idle)
  private stdoutBuf = new Map<number, string>(); // camera idx -> recv stdout line-assembly buffer
  // Tones written to a recv and awaiting its RESULT line, FIFO per camera (recv answers in order).
  private pendingTones = new Map<number, PendingTone[]>();
  private server?: Server;
  private callPort = 0; // ephemeral control port (chosen at bind time; passed to stream.sh as argv $3)
  private stopping = false;
  /** Set by index.ts: called right before a camera call is placed, so the door helper can release a
   *  call it is holding to the same station (a pre-warm / keep-alive), which ours would collide with. */
  onBeforeCall?: (placeId: string) => void;

  constructor(
    private places: Place[],
    private realm: string,
    private ports: Go2rtcPorts,
  ) {}

  async start(): Promise<boolean> {
    const usable = this.places.filter(
      (p) => p.incomingUser && p.incomingPw && p.outgoingUser,
    );
    if (!usable.length) {
      log.warn("no 2Voice place with channel + OUT creds; 2Voice video not started");
      return false;
    }
    // FIFO names MUST match what stream.sh reads (`/tmp/urmet_cam_<i>.h264` / `.pcm`) -- stream.sh
    // hardcodes those. Only one video service runs at a time (index.ts), so reusing the names the
    // IPERCOM path uses is safe and is what wires recv's output to go2rtc.
    usable.forEach((p, i) =>
      this.cams.push({
        place: p,
        fifo: `/tmp/urmet_cam_${i}.h264`,
        afifo: `/tmp/urmet_cam_${i}.pcm`,
      }),
    );
    log.info(
      `2Voice cameras: ${this.cams.map((c, i) => `[${i}] ${c.place.name}`).join(", ")}`,
    );
    // Bind the control endpoint FIRST so we know its (ephemeral) port before writing the go2rtc
    // config -- stream.sh receives it as argv $3.
    await this.serveCallEndpoint();
    // go2rtc: one on-demand stream per camera, hardened config (see go2rtc.ts), auto-respawned.
    this.go2rtc = new Go2rtcProcess(() =>
      go2rtcConfig(this.cams.length, this.callPort, this.ports, isDebug()),
    );
    this.go2rtc.start();
    log.info(
      `2Voice video ready: go2rtc api :${this.ports.api}, rtsp :${this.ports.rtsp}, webrtc :${this.ports.webrtc}; control :${this.callPort}; ${this.cams.length} camera(s)`,
    );
    return true;
  }

  /** The places with a camera stream (one per usable 2Voice place). */
  placesServed(): string[] {
    return this.cams.map((c) => c.place.id);
  }

  private camIndex(placeId: string): number {
    return this.cams.findIndex((c) => c.place.id === placeId);
  }

  /** True while a camera call for the place is up (placed or streaming). */
  hasCall(placeId: string): boolean {
    return this.recvs.has(this.camIndex(placeId));
  }

  /** Send a door/gate tone ('1'/'2') on the place's live camera call. Undefined when no camera call
   *  is up (the caller then uses the door helper). Resolves once recv confirms the tone went out;
   *  rejects with NoLiveCallError if the call turned out to be gone (ended before its media, or recv
   *  exited meanwhile) so the caller can fall back, with a plain Error on timeout. */
  sendTone(placeId: string, digit: string): Promise<void> | undefined {
    const i = this.camIndex(placeId);
    const recv = this.recvs.get(i);
    if (!recv || !recv.stdin?.writable) return undefined;
    return new Promise<void>((resolve, reject) => {
      const q = this.pendingTones.get(i) ?? [];
      this.pendingTones.set(i, q);
      const entry: PendingTone = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const k = q.indexOf(entry);
          if (k >= 0) {
            q.splice(k, 1);
            reject(new Error("tone not confirmed by the camera call"));
          }
        }, TONE_TIMEOUT_MS),
      };
      q.push(entry);
      recv.stdin!.write(digit + "\n");
    });
  }

  private failPendingTones(i: number, why: string) {
    const q = this.pendingTones.get(i);
    if (!q) return;
    this.pendingTones.delete(i);
    for (const p of q) {
      clearTimeout(p.timer);
      p.reject(new NoLiveCallError(why));
    }
  }

  // recv's stdout is piped (to read its RESULT lines) and passed through VERBATIM: its lines carry
  // their own timestamps (recv.c rlog), so they must not go through the logger's prefixing.
  private onRecvStdout(i: number, data: string) {
    process.stdout.write(data);
    let buf = (this.stdoutBuf.get(i) ?? "") + data;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      const r = parseResult(line);
      const q = this.pendingTones.get(i);
      if (!r || !q?.length) continue;
      const { resolve, reject, timer } = q.shift()!; // recv answers tones in the order it got them
      clearTimeout(timer);
      if (r.ok) resolve();
      else reject(new NoLiveCallError("no call to send the tone on"));
    }
    this.stdoutBuf.set(i, buf);
  }

  // Spawn recv in OUTGOING mode for camera i: register the place's channel account and place the
  // auto_insertion audio+video call to its OUT account, tapping to this camera's FIFOs. recv exits on
  // its own when the call ends (viewer gone / idle), and we respawn on the next /call.
  private startRecv(i: number) {
    if (this.stopping || this.recvs.has(i)) return;
    const cam = this.cams[i];
    // A pre-warm / keep-alive call the door helper holds to this station would collide with ours.
    this.onBeforeCall?.(cam.place.id);
    for (const fifo of [cam.fifo, cam.afifo]) {
      try {
        unlinkSync(fifo);
      } catch {
        /* not there */
      }
      execFileSync("mkfifo", [fifo]);
    }
    const targetFile = `/tmp/recv2v_target_${i}`;
    writeFileSync(targetFile, `${cam.fifo}\n${cam.afifo}\n`);
    const dataDir = `/tmp/lp_2v_vid_${i}/`; // unique per camera (shared sqlite corrupts account state)
    mkdirSync(dataDir, { recursive: true });
    // The camera call's header follows the app's callCCTV, which differs from the door call: a
    // phase-B 58A station needs the `mac` header (it rejects auto_insertion with 486), while a
    // cloud-listed station gets NO header (recv omits it) -- auto_insertion is the door path only.
    // "" here (non-MAC account) -> no RECV_MAC -> recv sends no custom header.
    const mac = macHeaderOf(cam.place.outgoingUser);
    log.info(
      `2Voice video [${i}] ${cam.place.name}: call via ${mac ? `mac header ${mac}` : "no header (cloud-listed camera)"} to station ${cam.place.outgoingUser}`,
    );
    // stdin = door/gate tones for the live call; stdout = recv's log (passed through) + RESULT lines.
    const recv = spawn("recv", [cam.place.incomingUser, cam.place.incomingPw], {
      env: {
        ...process.env,
        RECV_CALL_URI: `sip:${cam.place.outgoingUser}@${this.realm}`, // OUTGOING auto_insertion target
        ...(mac ? { RECV_MAC: mac } : {}), // 58A: dial with `mac` instead of `auto_insertion`
        // Stable instance id, DISTINCT from opendoor's (which registers the same channel account for
        // door-open) so the two helpers hold separate bindings instead of replacing each other.
        RECV_UUID: deterministicUuid(`urmet-recv:${cam.place.incomingUser}:${cam.place.id}`),
        RECV_TARGET_FILE: targetFile, // line 0 = H.264 FIFO, line 1 = PCM FIFO
        RECV_DATA_DIR: dataDir,
        RECV_IDLE_SECONDS: String(RECV_IDLE_SECONDS),
        RECV_CONNECTED_URL: `http://127.0.0.1:${this.callPort}/connected?cam=${i}`,
        RECV_COMMANDS: "1", // take door/gate tones on stdin (see sendTone)
        // No RECV_HANGUP_URL: there's no gateway cancel for 2Voice; recv just BYEs and exits.
        // log_level debug -> recv's own trace (SIP trace + per-5s audio RTP counters).
        ...(isDebug() ? { RECV_DEBUG: "1" } : {}),
      },
      stdio: ["pipe", "pipe", "inherit"],
    });
    this.stdoutBuf.set(i, "");
    recv.stdout?.setEncoding("utf8");
    recv.stdout?.on("data", (d: string) => this.onRecvStdout(i, d));
    recv.on("error", (e) => log.error(`2Voice recv [${i}] spawn error: ${e.message}`));
    recv.on("exit", (code) => {
      this.recvs.delete(i);
      this.failPendingTones(i, "camera call ended");
      if (!this.stopping)
        log.info(`2Voice recv [${i}] ${cam.place.name} exited (code ${code})`);
    });
    this.recvs.set(i, recv);
    log.info(`placed 2Voice video call [${i}] ${cam.place.name}`);
  }

  // End camera i's call: SIGUSR1 -> recv terminates the call (in-dialog BYE) and, in outgoing mode,
  // exits. SIGTERM is the backstop if it doesn't exit promptly. (Checked with isAlive, not
  // ChildProcess.killed: Node sets that after ANY successful kill(), so the SIGUSR1 above would make
  // the backstop never fire -- see the same note in video.ts cancel().)
  private stopRecv(i: number) {
    const r = this.recvs.get(i);
    if (!r) return;
    this.recvs.delete(i);
    try {
      r.kill("SIGUSR1");
    } catch {
      /* already gone */
    }
    setTimeout(() => {
      try {
        if (isAlive(r)) r.kill("SIGTERM");
      } catch {
        /* gone */
      }
    }, 2000);
  }

  /** End the place's camera call now (the "hang up" button). True if a call was up. Note a dashboard
   *  card still showing the camera reconnects on its own and places a new call. */
  hangup(placeId: string): boolean {
    const i = this.camIndex(placeId);
    if (!this.recvs.has(i)) return false;
    log.info(`hanging up the camera call [${i}] ${this.cams[i].place.name}`);
    this.stopRecv(i);
    return true;
  }

  private serveCallEndpoint(): Promise<void> {
    this.server = createServer((req, res) => {
      const u = new URL(req.url || "/", "http://127.0.0.1");
      const i = parseInt(u.searchParams.get("cam") || "0", 10) || 0;
      if (!this.cams[i]) return void res.writeHead(400).end("no such camera");
      if (u.pathname === "/call") {
        this.startRecv(i); // idempotent: no-op if already streaming this camera
        return void res.writeHead(200).end("ok");
      }
      if (u.pathname === "/hangup") {
        this.stopRecv(i);
        return void res.writeHead(200).end("ok");
      }
      if (u.pathname === "/connected") {
        log.info(`2Voice camera [${i}] ${this.cams[i].place.name}: video established`);
        return void res.writeHead(200).end("ok");
      }
      res.writeHead(404).end();
    });
    this.server.on("error", (e) =>
      log.error(`2Voice call endpoint error: ${(e as Error).message}`),
    );
    // Ephemeral port (0): the OS picks a free one, so a host-network clash on a fixed port (8099 was
    // taken by Zigbee2MQTT on a real install) can't happen. The chosen port goes to stream.sh (argv $3).
    return new Promise<void>((resolve) => {
      this.server!.listen(0, "127.0.0.1", () => {
        const addr = this.server!.address();
        this.callPort = typeof addr === "object" && addr ? addr.port : 0;
        log.info(`2Voice control endpoint on 127.0.0.1:${this.callPort}`);
        resolve();
      });
    });
  }

  /** Stop go2rtc and every live recv; resolves once they exited (each BYEs its call on SIGTERM)
   *  or after a bounded wait, so the caller can exit the process without cutting a BYE short. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.server?.close();
    this.go2rtc?.stop();
    const live = [...this.recvs.entries()];
    this.recvs.clear();
    for (const [i, r] of live) {
      this.failPendingTones(i, "shutting down");
      r.removeAllListeners("exit");
      r.kill("SIGTERM");
    }
    await Promise.all(live.map(([, r]) => waitForExit(r, 2500)));
  }
}
