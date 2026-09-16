import { test } from "node:test";
import assert from "node:assert/strict";
import { STREAM_SCRIPT, go2rtcConfig, webrtcListen } from "./go2rtc.js";

const ports = { api: 1984, rtsp: 8554, webrtc: 8555 };

test("go2rtcConfig keeps the LAN hardening keys", () => {
  const cfg = go2rtcConfig(2, 45123, ports);
  // module allowlist: nothing that runs commands or edits config besides exec (pinned below)
  assert.match(cfg, /^app: \{ modules: \[.*"exec".*\] \}$/m);
  for (const bad of ["echo", "ffmpeg", "hass", "onvif", "homekit", "srtp"])
    assert.ok(!cfg.includes(`"${bad}"`), `module ${bad} must not be loaded`);
  // API allowlist: the card + stream pages only
  assert.match(cfg, /^api: \{ listen: ":1984", allow_paths: \[.*"\/api\/ws".*\] \}$/m);
  for (const bad of ["/api/config", "/api/log", "/api/restart", "/api/exit"])
    assert.ok(!cfg.includes(bad), `${bad} must not be registered`);
  // exec may run only the stream script
  assert.match(cfg, new RegExp(`^exec: \\{ allow_paths: \\["${STREAM_SCRIPT}"\\] \\}$`, "m"));
});

test("go2rtcConfig emits one on-demand stream per camera with the call port", () => {
  const cfg = go2rtcConfig(2, 45123, ports);
  assert.match(cfg, /^  urmet_cam_0: "exec:\/app\/stream\.sh 0 \{output\} 45123#starttimeout=60"$/m);
  assert.match(cfg, /^  urmet_cam_1: "exec:\/app\/stream\.sh 1 \{output\} 45123#starttimeout=60"$/m);
  assert.ok(!cfg.includes("urmet_cam_2"));
  assert.match(cfg, /^rtsp: \{ listen: ":8554" \}$/m);
  assert.ok(cfg.endsWith("\n"));
});

test("go2rtcConfig surfaces exec stderr only in debug", () => {
  assert.ok(!go2rtcConfig(1, 1, ports).includes("log:"));
  assert.match(go2rtcConfig(1, 1, ports, true), /^log: \{ exec: debug \}$/m);
});

test("webrtcListen adds a candidate only in bridge networking", () => {
  assert.equal(webrtcListen(ports), 'webrtc: { listen: ":8555" }');
  assert.equal(
    webrtcListen({ ...ports, candidateIp: "192.168.1.5" }),
    'webrtc: { listen: ":8555", candidates: [ "192.168.1.5:8555" ] }',
  );
});
