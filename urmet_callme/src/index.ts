// Add-on entry point: load config, connect CallMe, bridge to MQTT (HA discovery),
// and keep the SIP registration alive.
import { readFileSync } from "node:fs";
import { CallMe, Door } from "./callme.js";
import { TwoVoiceDoor, TwoVoiceService } from "./door2voice.js";
import { Go2rtcPorts } from "./go2rtc.js";
import { startIngressServer } from "./ingress.js";
import { logger, setLevel } from "./logger.js";
import { MqttBridge } from "./mqtt.js";
import { VideoService } from "./video.js";
import { TwoVoiceVideoService } from "./video2voice.js";

const log = logger("main");

interface Config {
  email: string;
  password: string;
  mqttUrl?: string;
  mqttUser?: string;
  mqttPass?: string;
  logLevel: string;
  doorbell: boolean;
  video: boolean;
  door2voiceKeepaliveMs: number; // 2Voice: hold the call open this long for instant door-then-gate (0 = off)
  door2voicePrewarmHoldMs: number; // 2Voice: how long a "ready" (pre-warm) press keeps the call open
  go2rtcPorts: Go2rtcPorts; // embedded go2rtc bind ports (from the add-on Network config via run.sh)
}

async function supervisorMqtt(): Promise<{
  url: string;
  user?: string;
  pass?: string;
} | null> {
  const token = process.env.SUPERVISOR_TOKEN;
  if (!token) return null;
  try {
    const r = await fetch("http://supervisor/services/mqtt", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return null;
    const d = (await r.json()).data;
    const proto = d.ssl ? "mqtts" : "mqtt";
    return {
      url: `${proto}://${d.host}:${d.port}`,
      user: d.username,
      pass: d.password,
    };
  } catch {
    return null;
  }
}

async function loadConfig(): Promise<Config> {
  let o: any = {};
  try {
    o = JSON.parse(readFileSync("/data/options.json", "utf8"));
  } catch {
    /* dev mode */
  }
  // Missing email/password is a normal FIRST-RUN state, not a crash - main() handles it gracefully
  // (idles with a "configure me" status panel) instead of exiting with an "unknown error".
  const email = o.email || process.env.CALLME_EMAIL || "";
  const password = o.password || process.env.CALLME_PASSWORD || "";
  let mqttUrl = o.mqtt_url || process.env.MQTT_URL;
  let mqttUser = o.mqtt_username || process.env.MQTT_USERNAME;
  let mqttPass = o.mqtt_password || process.env.MQTT_PASSWORD;
  if (!mqttUrl) {
    const sup = await supervisorMqtt();
    if (sup) {
      mqttUrl = sup.url;
      mqttUser = sup.user;
      mqttPass = sup.pass;
    }
  }
  return {
    email,
    password,
    mqttUrl,
    mqttUser,
    mqttPass,
    logLevel: o.log_level || process.env.LOG_LEVEL || "info",
    doorbell: o.doorbell ?? process.env.CALLME_DOORBELL !== "false",
    video: o.video ?? process.env.CALLME_VIDEO === "true",
    door2voiceKeepaliveMs: Number(o.door_open_2voice_keepalive ?? 4) * 1000,
    door2voicePrewarmHoldMs:
      Number(o.door_open_2voice_prewarm_hold ?? 15) * 1000,
    // go2rtc bind ports. Under host networking these bind directly on the host; make them options
    // (not the Network tab, which can't remap ports under host networking) so they can be changed to
    // coexist with a user's own go2rtc add-on. candidateIp is an undocumented env escape hatch.
    go2rtcPorts: {
      api: Number(o.go2rtc_api_port ?? process.env.GO2RTC_API_PORT ?? 1984),
      rtsp: Number(o.go2rtc_rtsp_port ?? process.env.GO2RTC_RTSP_PORT ?? 8554),
      webrtc: Number(
        o.go2rtc_webrtc_port ?? process.env.GO2RTC_WEBRTC_PORT ?? 8555,
      ),
      candidateIp: (process.env.WEBRTC_IP || "").trim() || undefined,
    },
  };
}

async function main() {
  const cfg = await loadConfig();
  setLevel(cfg.logLevel);

  // First-run friendliness: with no credentials there's nothing to connect to. Rather than exit
  // (which HA surfaces as an "unknown error"), start the status panel telling the user to configure
  // the add-on, and idle. The listening server keeps the process alive; SIGTERM stops it.
  if (!cfg.email || !cfg.password) {
    log.warn(
      "Not configured yet: open the Configuration tab, enter your Urmet CallMe email and password, then Start again.",
    );
    // Nothing runs yet (no go2rtc), so keep the panel blank regardless of the video option; the
    // listening server just keeps the process alive until the user configures and restarts.
    startIngressServer(false, cfg.go2rtcPorts.api);
    return;
  }

  log.info(
    `starting: email=${cfg.email} mqtt=${cfg.mqttUrl ? "yes" : "no"} logLevel=${cfg.logLevel}`,
  );
  const callme = new CallMe(cfg.email, cfg.password);
  await callme.connect();

  // Split places by family: IPERCOM opens doors with the pure-Node open_door_req; 2Voice needs the
  // liblinphone DTMF path. Only IPERCOM places have a gateway/residentDoors, so resolve+list doors
  // for those alone - a 2Voice-only account would otherwise hang/fail on gateway resolve.
  const ipercomPlaces = callme.places.filter((p) => p.family === "ipercom");
  const twoVoicePlaces = callme.places.filter((p) => p.family === "twovoice");
  const unknownPlaces = callme.places.filter((p) => p.family === "unknown");
  if (unknownPlaces.length)
    log.warn(
      `unrecognized device model(s): ${unknownPlaces.map((p) => `${p.id}(uid_type=${p.uidType})`).join(", ")} - not exposed`,
    );

  // Entrances of EVERY IPERCOM place (an account can hold several: two apartments, a second
  // building). Each place resolves its own gateway; one unreachable place is logged and skipped
  // so the others still get their doors. If every place fails, keep the old behaviour and abort,
  // so the failure is visible as a stopped add-on rather than a silently door-less one.
  const doors: Door[] = [];
  let lastError: Error | undefined;
  for (const place of ipercomPlaces) {
    try {
      const found = await callme.listDoors(place.id);
      doors.push(...found);
      log.info(
        `discovered ${found.length} IPERCOM entrance(s) on place ${place.id} (${place.name}): ` +
          found
            .map((d) => `${d.doorId}:${d.name}(door=${d.hasDoor},gate=${d.hasGate})`)
            .join(", "),
      );
    } catch (e) {
      lastError = e as Error;
      log.error(
        `place ${place.id} (${place.name}): entrance discovery failed: ${lastError.message}`,
      );
    }
  }
  if (ipercomPlaces.length && !doors.length && lastError) throw lastError;

  // 2Voice doorbells: a doorbell `event` entity per 2Voice place (its ring arrives on the channel
  // account with the OUT/calling-station username in the From). Independent of 2Voice door-open.
  const twoVoiceDoorbells = twoVoicePlaces.map((p) => ({
    placeId: p.id,
    name: p.name,
    station: p.outgoingUser,
  }));

  // 2Voice door-open. Auto-enabled for any detected 2Voice place (like IPERCOM doors): each gets a
  // door + gate button, opened via the persistent opendoor helper.
  let twoVoice: TwoVoiceService | undefined;
  let twoVoiceDoors: TwoVoiceDoor[] = [];
  if (twoVoicePlaces.length) {
    twoVoice = new TwoVoiceService(
      twoVoicePlaces,
      cfg.door2voiceKeepaliveMs,
      cfg.door2voicePrewarmHoldMs,
    );
    twoVoiceDoors = twoVoice.doors();
    twoVoice.start(); // spawn a persistent, pre-registered opendoor per place (fast opens)
    callme.onStationLearned = (p) => twoVoice?.stationLearned(p.id);
    log.info(
      `2Voice door-open enabled for ${twoVoicePlaces.length} place(s), ${twoVoiceDoors.length} relay(s): ` +
        twoVoicePlaces.map((p) => `${p.id}(${p.name})`).join(", "),
    );
    const awaiting = twoVoicePlaces.filter((p) => !p.outgoingUser);
    if (awaiting.length)
      log.warn(
        `place(s) ${awaiting.map((p) => p.id).join(", ")} have no station yet ` +
          "(call-forwarding device not in the SIP census)",
      );
  }

  let bridge: MqttBridge | undefined;
  if (cfg.mqttUrl) {
    bridge = new MqttBridge(
      cfg.mqttUrl,
      {
        username: cfg.mqttUser,
        password: cfg.mqttPass,
      },
      callme,
      twoVoice,
    );
    await bridge.start(doors, twoVoiceDoors, twoVoiceDoorbells);
  } else {
    log.warn(
      "no MQTT configured; nothing to expose (set MQTT or run with the HA MQTT service)",
    );
  }

  // Doorbell: register each place's channel account and fire an MQTT `event` when the
  // entrance panel rings it. Only fires when the monitor is set to "remote" (that's when the
  // panel forwards the call). Harmless if MQTT is absent - it still logs the ring.
  if (cfg.doorbell) {
    try {
      await callme.startDoorbell((r) => bridge?.ringDoorbell(r));
    } catch (e) {
      log.warn(`doorbell setup failed: ${(e as Error).message}`);
    }
  }

  // Video (optional): embedded liblinphone receiver + go2rtc. IPERCOM uses the split-account
  // on-demand camera call (VideoService); 2Voice has no such call, so it taps the auto_insertion
  // call instead (TwoVoiceVideoService). They share go2rtc/ports, so only ONE runs - IPERCOM wins
  // when both families are present (a mixed account is rare; 2Voice-only accounts get 2Voice video).
  let video: VideoService | undefined;
  let video2v: TwoVoiceVideoService | undefined;
  if (cfg.video) {
    try {
      if (ipercomPlaces.length) {
        video = new VideoService(
          callme,
          ipercomPlaces.map((p) => p.id),
          cfg.email,
          cfg.password,
          cfg.go2rtcPorts,
        );
        await video.start();
      } else if (twoVoicePlaces.length) {
        video2v = new TwoVoiceVideoService(
          twoVoicePlaces,
          callme.realm,
          cfg.go2rtcPorts,
        );
        await video2v.start();
      }
    } catch (e) {
      log.warn(`video setup failed: ${(e as Error).message}`);
    }
  }

  // Ingress panel (served through HA's authenticated proxy): the go2rtc camera UI when video is on,
  // otherwise blank (the entities/log already report status).
  try {
    startIngressServer(cfg.video, cfg.go2rtcPorts.api);
  } catch (e) {
    log.warn(`ingress panel failed to start: ${(e as Error).message}`);
  }

  // Single shutdown path, ORDERED and AWAITED: the helpers get SIGTERM and a bounded moment to send
  // their in-dialog BYEs (a call left un-BYE'd stays busy on the panel until its session timer),
  // then MQTT publishes the retained "offline" and disconnects cleanly, then we exit. A hard
  // deadline keeps a stuck helper from holding the stop past the Supervisor's own timeout. One
  // set of handlers avoids the earlier bug where the MQTT handler's process.exit() pre-empted the
  // separately-registered video handler and left recv/go2rtc running.
  let stopping = false;
  const shutdown = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`shutdown (${sig})`);
    setTimeout(() => {
      log.warn("shutdown deadline reached; exiting");
      process.exit(0);
    }, 6000).unref();
    const results = await Promise.allSettled([
      video?.stop(),
      video2v?.stop(),
      twoVoice?.stop(),
    ]);
    for (const r of results)
      if (r.status === "rejected")
        log.warn(`shutdown: ${(r.reason as Error)?.message ?? r.reason}`);
    await bridge?.stop();
    log.info("shutdown complete");
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  // maintenance: keepalive + expiry-driven re-register (SIP + doorbell listeners). Each client
  // refreshes when half its REGISTRAR-GRANTED expiry has elapsed (sip.dueForReregister()), not on a
  // fixed timer - so a lifetime Flexisip caps below our assumption can't silently lapse.
  // `busy` guards against re-entrancy: setInterval doesn't await the callback, so a slow
  // reconnect (cloud latency / SIP stall during an outage - exactly when this fires) would
  // otherwise let the next 25s tick start a SECOND concurrent callme.connect(), racing two
  // SipClients onto this.sip. Skip the tick if the previous one is still running.
  let busy = false;
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      if (!callme.sip?.alive()) {
        await callme.connect();
      } else if (callme.sip.dueForReregister()) {
        await callme.sip.register();
      }
      if (cfg.doorbell) await callme.maintainDoorbell();
    } catch (e) {
      log.error(`maintenance: ${(e as Error).message}`);
    } finally {
      busy = false;
    }
  }, 25000);
}

main().catch((e) => {
  log.error("fatal:", e);
  process.exit(1);
});
