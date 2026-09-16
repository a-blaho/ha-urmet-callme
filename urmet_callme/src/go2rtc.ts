// The embedded go2rtc: its (hardened) config and a supervised process. Shared by the IPERCOM
// (video.ts) and 2Voice (video2voice.ts) video services, which only ever run one at a time.
//
// SECURITY. Under host networking go2rtc's API listens on the LAN (the WebRTC card needs it), with
// no authentication: browsers cannot carry HTTP basic-auth on the card's fetch/WebSocket, so
// `api.username/password` would break the documented dashboard setup. A bare go2rtc API is a remote
// shell (anyone on the LAN can add an `exec:`/`echo:` stream and run a command in the container,
// which holds the Urmet credentials). go2rtc's own hardening knobs close that without auth:
//   - app.modules:     load ONLY the modules the add-on uses. Drops echo/ffmpeg/hass/onvif/... so no
//                      other command-running or config-altering source exists at all.
//   - api.allow_paths: register ONLY the HTTP paths the card and the stream pages need. Every other
//                      endpoint is simply never registered: no /api/config (config editor), no
//                      /api/restart / /api/exit, no /api/log, no ffmpeg/onvif APIs.
//   - exec.allow_paths: the exec source may run ONLY /app/stream.sh (exact match on argv[0]).
// Residual exposure is view-level: /api/streams stays reachable because the go2rtc stream list and
// the card's stream pages need it, and it accepts PUT/DELETE, so a LAN client can add/remove streams
// (a stream it adds is limited to the sources above) and edit the streams: section of the config
// file. That is why the config is REWRITTEN from scratch on every (re)spawn (see Go2rtcProcess):
// a tampered file never survives a restart.
// These keys exist in go2rtc >= 1.9.x and unknown keys are silently ignored, so the Dockerfile pins
// the go2rtc version: an unpinned "latest" could rename a key and quietly drop the hardening.
import { ChildProcess, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { logger } from "./logger.js";

const log = logger("go2rtc");

export const GO2RTC_CFG = "/tmp/go2rtc.yaml";
/** The only binary go2rtc's exec source may run (the per-camera producer). Must match the path the
 *  Dockerfile copies stream.sh to. */
export const STREAM_SCRIPT = "/app/stream.sh";
const RESPAWN_MS = 3000;

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

// Modules the add-on needs, nothing else (see the header):
//   api + ws   the HTTP API and its WebSocket endpoint (the card signals over api/ws)
//   rtsp       the RTSP server: stream.sh's ffmpeg pushes each camera INTO go2rtc over it
//              ({output}), and users may pull rtsp://host:8554/urmet_cam_<i>
//   webrtc     what the card plays
//   mp4, mjpeg the MSE / snapshot players of go2rtc's own stream pages (ingress panel)
//   exec       the on-demand producer source (stream.sh)
const MODULES = ["api", "ws", "rtsp", "webrtc", "mp4", "mjpeg", "exec"];
// HTTP paths that get registered. "/" is go2rtc's static web UI (the ingress panel), "/api" its
// version/info line (the UI fetches it), "/api/streams" the stream list, "/api/ws" the card's
// signalling endpoint, "/api/webrtc" the plain WHEP-style offer/answer, "/api/frame.jpeg" a still.
const API_PATHS = [
  "/",
  "/api",
  "/api/streams",
  "/api/ws",
  "/api/webrtc",
  "/api/frame.jpeg",
];

const yamlList = (xs: string[]) => `[${xs.map((x) => JSON.stringify(x)).join(", ")}]`;

/** The full go2rtc config: one on-demand exec stream per camera (`urmet_cam_<i>`, so the dashboard
 *  setup is identical for both families) plus the hardening above.
 *  starttimeout: how long go2rtc waits for stream.sh's ffmpeg to connect back via RTSP before giving
 *  up with "exec: timeout" (default 30s). An active SWITCH to a second camera can exceed 30s (BYE +
 *  settle + the panel's slow post-teardown INVITE + keyframe warm-up), and the 2Voice path pays
 *  register + auto_insertion answer + warm-up, so 60s lets a slow start land instead of erroring. */
export function go2rtcConfig(
  cameras: number,
  callPort: number,
  ports: Go2rtcPorts,
  debug = false, // add-on log_level debug: also surface the producers' stderr (ffmpeg warnings)
): string {
  const streams: string[] = [];
  for (let i = 0; i < cameras; i++)
    streams.push(
      `  urmet_cam_${i}: "exec:${STREAM_SCRIPT} ${i} {output} ${callPort}#starttimeout=60"`,
    );
  return [
    `app: { modules: ${yamlList(MODULES)} }`,
    `api: { listen: ":${ports.api}", allow_paths: ${yamlList(API_PATHS)} }`,
    `exec: { allow_paths: ${yamlList([STREAM_SCRIPT])} }`,
    `rtsp: { listen: ":${ports.rtsp}" }`,
    webrtcListen(ports),
    // go2rtc forwards an exec producer's stderr to its log ONLY when the exec module logs at debug;
    // without this ffmpeg's own warnings (input EOF, encoder falling behind) are never seen.
    ...(debug ? ["log: { exec: debug }"] : []),
    "streams:",
    ...streams,
    "",
  ].join("\n");
}

/** The supervised go2rtc child: (re)writes the config and spawns; auto-respawns on exit (a crash
 *  would otherwise leave video dead until an add-on restart); stop() ends it without a respawn. */
export class Go2rtcProcess {
  private child?: ChildProcess;
  private stopping = false;

  constructor(private config: () => string) {}

  start(): void {
    this.spawn();
  }

  private spawn(): void {
    if (this.stopping) return;
    // Regenerate the config on EVERY spawn, not just the first: /api/streams can patch the streams:
    // section of the file, so a respawn must start from the add-on's own config, never the file's.
    writeFileSync(GO2RTC_CFG, this.config());
    this.child = spawn("go2rtc", ["-config", GO2RTC_CFG], { stdio: "inherit" });
    this.child.on("error", (e) => log.error(`go2rtc spawn error: ${e.message}`));
    this.child.on("exit", (code) => {
      if (this.stopping) return;
      log.warn(`go2rtc exited (code ${code}); respawning in ${RESPAWN_MS}ms`);
      setTimeout(() => this.spawn(), RESPAWN_MS);
    });
  }

  stop(): void {
    this.stopping = true;
    this.child?.removeAllListeners("exit"); // don't let the exit handler respawn during shutdown
    this.child?.kill("SIGTERM");
  }
}
