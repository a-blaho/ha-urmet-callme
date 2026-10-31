// 2Voice announcements ("talk-out", issue #19): play a short clip out of the door station's speaker,
// one-way - "Leave the parcel at the door", "Be right down". Exposed as an MQTT `notify` entity per
// 2Voice place (mqtt.ts); the message is either text, spoken through one of Home Assistant's TTS
// engines, or an http(s) URL of an audio file, played as-is.
//
// How the audio gets there: every 2Voice place has a talk FIFO (talkFifoOf). ffmpeg decodes the
// source to raw s16le 8 kHz mono (G.711 is forced on the call) and writes it into the FIFO, and the
// helper that holds the call to the station reads it in real time in place of the silence it sends
// (video-recv/talkout.h): opendoor when nobody is watching the camera (TwoVoiceService.startTalk
// asks it to place/hold a call), or the camera's recv while the camera call is up. ffmpeg's open of
// the FIFO blocks until a call's audio graph opens it, so the first progress report from ffmpeg is
// also the moment the call started taking the clip.
//
// Logging: every announcement gets a number (#n) and logs each step with its time since the
// request: source resolved (TTS engine/URL), which call carries it, when the call took the audio,
// what ffmpeg found in the source, and a summary of what was written. The helpers log their side
// (call setup, open-audio digit, levels/dropouts per clip, RTP counters) with the same "announce" /
// "talk-out" wording, so one announcement can be followed through the whole log.
import { ChildProcess, spawn } from "node:child_process";
import { talkFifoOf, TwoVoiceService } from "./door2voice.js";
import { isDebug, logger } from "./logger.js";

const log = logger("announce");

// Silence ahead of the clip: the station may need a moment after the call comes up (and after the
// open-audio digit) before its speaker plays, which would otherwise eat the first syllable.
const LEAD_IN_MS = 400;
// No progress from ffmpeg within this long = no call took the clip (opendoor's own limits are 20 s
// to get media + 25 s for the clip to start; this is the backstop above both).
const START_TIMEOUT_MS = 50000;
const HA_TIMEOUT_MS = 20000; // a TTS engine renders the whole clip before answering

export interface AnnounceOptions {
  ttsEngine?: string; // TTS entity (tts.piper, tts.google_translate_en_com, ...); empty = first found
  ttsLanguage?: string;
  maxSeconds: number; // clips are cut at this length so a long file cannot hold the 2Voice line
}

/** An announcement source: an audio URL (played as-is) or text for TTS. */
export function classifyMessage(message: string): { kind: "url" | "tts"; value: string } {
  const m = message.trim();
  return /^https?:\/\/\S+$/i.test(m) ? { kind: "url", value: m } : { kind: "tts", value: m };
}

/** The ffmpeg command line that decodes `input` into the call's PCM format, written to `fifo`. */
export function ffmpegArgs(
  input: string,
  fifo: string,
  maxSeconds: number,
  authHeader?: string,
): string[] {
  return [
    "-hide_banner",
    "-nostdin",
    "-nostats",
    "-loglevel",
    "info",
    "-progress",
    "pipe:1",
    // Sources are URLs only: refuse file:, pipe: and friends whatever a message contains.
    "-protocol_whitelist",
    "http,https,tcp,tls",
    "-rw_timeout",
    "15000000", // 15 s network stall on the source = give up rather than hold the call
    ...(authHeader ? ["-headers", `Authorization: ${authHeader}\r\n`] : []),
    "-i",
    input,
    "-af",
    `adelay=${LEAD_IN_MS}:all=1`,
    "-t",
    String(maxSeconds),
    "-ac",
    "1",
    "-ar",
    "8000",
    "-f",
    "s16le",
    "-y",
    fifo,
  ];
}

/** ffmpeg's command line for the log: the Authorization header redacted. */
export function redactArgs(args: string[]): string {
  return args
    .map((a, i) => (args[i - 1] === "-headers" ? "<auth header>" : /\s/.test(a) ? `'${a}'` : a))
    .join(" ");
}

/** One `-progress` block (key=value lines up to `progress=...`) -> the fields we report. */
export function parseProgress(block: string): {
  totalSize?: number;
  outTimeMs?: number;
  end: boolean;
} {
  const kv = new Map<string, string>();
  for (const line of block.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) kv.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  const num = (k: string) => {
    const v = Number(kv.get(k));
    return Number.isFinite(v) ? v : undefined;
  };
  const us = num("out_time_us") ?? num("out_time_ms"); // both are microseconds in ffmpeg
  return {
    totalSize: num("total_size"),
    outTimeMs: us === undefined ? undefined : Math.round(us / 1000),
    end: kv.get("progress") === "end",
  };
}

interface Playing {
  id: number;
  ff: ChildProcess;
  replaced: boolean;
}

export class Announcer {
  private seq = 0;
  private playing = new Map<string, Playing>(); // placeId -> clip being written
  private engine?: string; // resolved TTS engine, cached after the first lookup
  private stopping = false;

  constructor(
    private tv: TwoVoiceService,
    private opts: AnnounceOptions,
    private haBase = process.env.HA_URL || "http://supervisor/core",
    private haToken = process.env.HA_TOKEN || process.env.SUPERVISOR_TOKEN || "",
  ) {}

  /** Play `message` (text for TTS, or an http(s) audio URL) out of the place's door station.
   *  Resolves when the clip has been handed to the call (or failed); never throws. */
  async announce(placeId: string, message: string): Promise<boolean> {
    const id = ++this.seq;
    const t0 = Date.now();
    const at = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
    const name = this.tv.placeName(placeId) ?? placeId;
    const src = classifyMessage(message);
    if (!src.value) {
      log.warn(`#${id} ${name}: empty message, nothing to announce`);
      return false;
    }
    log.info(
      `#${id} ${name}: announcement requested (${src.kind === "url" ? "audio URL" : `TTS, ${src.value.length} chars`}): ` +
        `"${src.value.length > 80 ? src.value.slice(0, 77) + "..." : src.value}"`,
    );

    // 1. The source: a URL as-is, or a TTS clip rendered by Home Assistant.
    let input = src.value;
    let auth: string | undefined;
    if (src.kind === "tts") {
      try {
        const r = await this.renderTts(src.value, id);
        input = r.url;
        auth = r.auth;
        log.info(`#${id} ${at()} TTS rendered by ${r.engine}: ${r.display}`);
      } catch (e) {
        log.error(`#${id} ${at()} FAILED: TTS: ${(e as Error).message}`);
        return false;
      }
    }

    // 2. A call to carry it: the live camera call, or one the door helper places/holds.
    const route = this.tv.startTalk(placeId);
    if (!route) {
      log.error(`#${id} ${at()} FAILED: no call possible for ${name} (door helper not ready)`);
      return false;
    }
    log.info(
      `#${id} ${at()} route: ${route === "camera" ? "the live camera call" : "a call held by the door helper"}`,
    );

    // 3. Decode into the place's talk FIFO. One clip per place: a newer one replaces it.
    const prev = this.playing.get(placeId);
    if (prev) {
      log.info(`#${id} replacing announcement #${prev.id}, which is still playing`);
      prev.replaced = true;
      prev.ff.kill("SIGTERM");
    }
    const args = ffmpegArgs(input, talkFifoOf(placeId), this.opts.maxSeconds, auth);
    log.debug(`#${id} ffmpeg ${redactArgs(args)}`);
    const ff = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    const cur: Playing = { id, ff, replaced: false };
    this.playing.set(placeId, cur);

    return new Promise<boolean>((resolve) => {
      let took = 0; // ms since the request when the call took the audio
      let last = { totalSize: 0, outTimeMs: 0 };
      const errors: string[] = [];
      let out = "";
      let errBuf = "";
      let inOutput = false; // ffmpeg's stream dump: the source first, then what we write
      const startTimer = setTimeout(() => {
        if (took) return;
        log.error(
          `#${id} ${at()} FAILED: no call took the clip within ${START_TIMEOUT_MS / 1000}s ` +
            "(see the [opendoor]/[recv] lines above for why the call did not come up)",
        );
        ff.kill("SIGTERM");
      }, START_TIMEOUT_MS);

      ff.stdout!.setEncoding("utf8");
      ff.stdout!.on("data", (d: string) => {
        out += d;
        let k: number;
        while ((k = out.search(/progress=(continue|end)\n/)) >= 0) {
          const endIdx = out.indexOf("\n", k) + 1;
          const p = parseProgress(out.slice(0, endIdx));
          out = out.slice(endIdx);
          last = { totalSize: p.totalSize ?? last.totalSize, outTimeMs: p.outTimeMs ?? last.outTimeMs };
          if (!took) {
            took = Date.now() - t0;
            log.info(`#${id} ${at()} the call is taking the audio (playback started)`);
          }
          log.debug(`#${id} ${at()} written ${(last.outTimeMs / 1000).toFixed(1)}s, ${last.totalSize} B`);
        }
      });
      ff.stderr!.setEncoding("utf8");
      ff.stderr!.on("data", (d: string) => {
        errBuf += d;
        let nl: number;
        while ((nl = errBuf.indexOf("\n")) >= 0) {
          const line = errBuf.slice(0, nl).trimEnd();
          errBuf = errBuf.slice(nl + 1);
          if (!line) continue;
          if (/^Output #/.test(line)) inOutput = true;
          if (/^\s*(Input #|Duration:|Stream #\d+:\d+.*Audio)/.test(line) && !inOutput)
            log.info(`#${id} source: ${line.trim()}`);
          else if (/^\s*Stream #\d+:\d+.*Audio/.test(line))
            log.info(`#${id} output: ${line.trim()}`);
          else if (/error|invalid|failed|not found|denied|refused|broken pipe|unable/i.test(line)) {
            errors.push(line.trim());
            log.warn(`#${id} ffmpeg: ${line.trim()}`);
          } else if (isDebug()) log.debug(`#${id} ffmpeg: ${line.trim()}`);
        }
      });
      ff.on("error", (e) => {
        // Spawn failure: no "exit" follows, so settle here.
        clearTimeout(startTimer);
        if (this.playing.get(placeId) === cur) this.playing.delete(placeId);
        log.error(`#${id} FAILED: cannot run ffmpeg: ${e.message}`);
        resolve(false);
      });
      ff.on("exit", (code, signal) => {
        clearTimeout(startTimer);
        if (this.playing.get(placeId) === cur) this.playing.delete(placeId);
        const audio = `${(last.outTimeMs / 1000).toFixed(1)}s of audio (${last.totalSize} B, incl. ${LEAD_IN_MS} ms lead-in)`;
        if (cur.replaced) {
          log.info(`#${id} ${at()} stopped after ${audio}: replaced by a newer announcement`);
          return resolve(false);
        }
        if (code === 0) {
          // ffmpeg is done once the clip is in the FIFO, which buffers up to ~4 s: the call plays the
          // tail after this (the helper's "talk-out: clip ended" line marks the real end).
          const left = Math.max(0, last.outTimeMs - (Date.now() - t0 - took)) / 1000;
          log.info(
            `#${id} ${at()} done: ${audio} written; the call plays the rest over ~${left.toFixed(1)}s` +
              (last.outTimeMs >= this.opts.maxSeconds * 1000 ? ` (cut at the ${this.opts.maxSeconds}s limit)` : ""),
          );
          return resolve(true);
        }
        const why = errors.some((e) => /broken pipe/i.test(e))
          ? "the call ended mid-clip"
          : errors.length
            ? `source: ${errors[errors.length - 1]}` // e.g. a 404 URL: ffmpeg fails before the call matters
            : !took
              ? "the call never took the audio"
              : `ffmpeg exited ${signal ?? code}`;
        if (!this.stopping)
          log.error(`#${id} ${at()} FAILED after ${audio}: ${why}`);
        resolve(false);
      });
    });
  }

  /** Render `text` with a Home Assistant TTS engine. Returns a URL ffmpeg can fetch (through the
   *  Supervisor's Core proxy, hence the auth header) and what to log. */
  private async renderTts(
    text: string,
    id: number,
  ): Promise<{ url: string; auth?: string; engine: string; display: string }> {
    if (!this.haToken)
      throw new Error("no Home Assistant API access (SUPERVISOR_TOKEN missing; is homeassistant_api enabled?)");
    const engine = await this.ttsEngine(id);
    const body: Record<string, unknown> = { engine_id: engine, message: text, cache: true };
    if (this.opts.ttsLanguage) body.language = this.opts.ttsLanguage;
    const r = await this.ha("POST", "/api/tts_get_url", body);
    const d = (await r.json()) as { url?: string; path?: string };
    // Prefer the path through our own API base: HA's absolute `url` uses its configured internal or
    // external URL, which the add-on may not be able to reach.
    if (d.path) return { url: this.haBase + d.path, auth: `Bearer ${this.haToken}`, engine, display: d.path };
    if (d.url) return { url: d.url, engine, display: d.url };
    throw new Error(`tts_get_url returned no URL: ${JSON.stringify(d).slice(0, 200)}`);
  }

  /** The configured TTS engine, or the first `tts.*` entity Home Assistant has (logged once). */
  private async ttsEngine(id: number): Promise<string> {
    if (this.opts.ttsEngine) return this.opts.ttsEngine;
    if (this.engine) return this.engine;
    const r = await this.ha("GET", "/api/states");
    const states = (await r.json()) as { entity_id: string }[];
    const engines = states.map((s) => s.entity_id).filter((e) => e.startsWith("tts."));
    if (!engines.length)
      throw new Error("Home Assistant has no TTS engine; add one (e.g. Piper or Google Translate) or set announce_tts_engine");
    this.engine = engines[0];
    log.info(
      `#${id} TTS engines found: ${engines.join(", ")}; using ${this.engine} (set announce_tts_engine to pick another)`,
    );
    return this.engine;
  }

  private async ha(method: string, path: string, body?: unknown): Promise<Response> {
    const r = await fetch(this.haBase + path, {
      method,
      headers: {
        Authorization: `Bearer ${this.haToken}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(HA_TIMEOUT_MS),
    });
    if (!r.ok) {
      const text = (await r.text().catch(() => "")).slice(0, 200);
      throw new Error(`${method} ${path}: HTTP ${r.status} ${text}`);
    }
    return r;
  }

  /** Stop any clip being written (the helpers end their calls on their own shutdown). */
  stop(): void {
    this.stopping = true;
    for (const p of this.playing.values()) p.ff.kill("SIGTERM");
    this.playing.clear();
  }
}
