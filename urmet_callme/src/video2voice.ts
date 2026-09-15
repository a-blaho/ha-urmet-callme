// 2Voice video (opt-in `video`). 2Voice has NO on-demand camera call (that's IPERCOM's split-account
// call_device_req). Instead the panel sends its H.264 on the `auto_insertion` call -- the SAME call
// opendoor places to unlock (that's why an audio-only offer got 403'd: it's a video entry call). So
// per 2Voice place we run `recv` in OUTGOING mode (RECV_CALL_URI = the OUT account): it registers the
// channel account, places an audio+video auto_insertion call, and taps the H.264/audio to go2rtc via
// the SAME stream.sh pipeline as the IPERCOM receiver.
//
// This is a slimmed video.ts: no shared account B (2Voice uses the channel account it already has), no
// call_device_req/gateway, no slot-switching (each place is independent, one recv per place, spawned
// on demand). The go2rtc + stream.sh + FIFO/keyframe machinery is shared with the IPERCOM path,
// reused as-is.
import { spawn, execFileSync, ChildProcess } from "node:child_process";
import { writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { createServer, Server } from "node:http";
import { Place } from "./callme.js";
import { macHeaderOf } from "./door2voice.js";
import { Go2rtcPorts, Go2rtcProcess, go2rtcConfig } from "./go2rtc.js";
import { isDebug, logger } from "./logger.js";
import { waitForExit } from "./proc.js";
import { deterministicUuid } from "./video.js";

const log = logger("video2v");
const RECV_IDLE_SECONDS = 10; // recv hangs up (and exits) after no FIFO reader for this long

interface Cam {
  place: Place;
  fifo: string; // per-camera Annex-B (H.264) FIFO
  afifo: string; // per-camera audio FIFO (raw PCM s16le 8k mono; recv forces G.711)
}

export class TwoVoiceVideoService {
  private go2rtc?: Go2rtcProcess;
  private cams: Cam[] = [];
  private recvs = new Map<number, ChildProcess>(); // camera idx -> its live recv (absent = idle)
  private server?: Server;
  private callPort = 0; // ephemeral control port (chosen at bind time; passed to stream.sh as argv $3)
  private stopping = false;

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
      go2rtcConfig(this.cams.length, this.callPort, this.ports),
    );
    this.go2rtc.start();
    log.info(
      `2Voice video ready: go2rtc api :${this.ports.api}, rtsp :${this.ports.rtsp}, webrtc :${this.ports.webrtc}; control :${this.callPort}; ${this.cams.length} camera(s)`,
    );
    return true;
  }

  // Spawn recv in OUTGOING mode for camera i: register the place's channel account and place the
  // auto_insertion audio+video call to its OUT account, tapping to this camera's FIFOs. recv exits on
  // its own when the call ends (viewer gone / idle), and we respawn on the next /call.
  private startRecv(i: number) {
    if (this.stopping || this.recvs.has(i)) return;
    const cam = this.cams[i];
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
        // No RECV_HANGUP_URL: there's no gateway cancel for 2Voice; recv just BYEs and exits.
        // log_level debug -> recv's own trace (SIP trace + per-5s audio RTP counters).
        ...(isDebug() ? { RECV_DEBUG: "1" } : {}),
      },
      stdio: "inherit",
    });
    recv.on("exit", (code) => {
      this.recvs.delete(i);
      if (!this.stopping)
        log.info(`2Voice recv [${i}] ${cam.place.name} exited (code ${code})`);
    });
    this.recvs.set(i, recv);
    log.info(`placed 2Voice video call [${i}] ${cam.place.name}`);
  }

  // End camera i's call: SIGUSR1 -> recv terminates the call (in-dialog BYE) and, in outgoing mode,
  // exits. SIGTERM is the backstop if it doesn't exit promptly.
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
        if (!r.killed) r.kill("SIGTERM");
      } catch {
        /* gone */
      }
    }, 2000);
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
    const live = [...this.recvs.values()];
    this.recvs.clear();
    for (const r of live) {
      r.removeAllListeners("exit");
      r.kill("SIGTERM");
    }
    await Promise.all(live.map((r) => waitForExit(r, 2500)));
  }
}
