// 2Voice door-open control plane (auto-enabled for detected 2Voice places). 2Voice panels have NO cloud
// open_door_req (that's IPERCOM) -- the door is opened by placing a SIP call to the station and
// sending an in-call DTMF tone. That needs liblinphone, so we run the `opendoor` helper
// (video-recv/opendoor.c).
//
// PERSISTENT registration (latency): rather than spawn a fresh opendoor per press (a cold SIP
// register ~2-3s + call each time), we keep ONE opendoor per place registered on the channel account
// and drive it over stdin -- each press then pays only the call-setup time. opendoor registers once,
// reads digits ('1' door / '2' gate) from stdin, opens per line, and prints `RESULT <d> ok|fail`.
import { ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { Place } from "./callme.js";
import { logger } from "./logger.js";

const log = logger("door2voice");

/** A stable RFC 5626 instance id for a place's opendoor helper. liblinphone otherwise invents a
 *  random one per run (its config lives in a /tmp dir the container wipes), so each restart ADDED a
 *  binding to the shared account rather than replacing ours, and the registrar kept forking calls to
 *  the dead ones until they expired. Same trick as SipClient's instance(): derive it from the
 *  account so it survives restarts. */
function instanceUuid(user: string, placeId: string): string {
  const h = createHash("md5")
    .update(`urmet-opendoor:${user}:${placeId}`)
    .digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

const DIGIT: Record<"door" | "gate", string> = { door: "1", gate: "2" };
// Per-open wait for opendoor's RESULT line. opendoor's own worst case (no media) is ~40 s, so give a
// little more before we give up on the reply (the helper stays alive regardless -- no kill needed).
const OPEN_TIMEOUT_MS = 45000;
const RESPAWN_MS = 3000; // auto-restart a helper that died (e.g. registration dropped)

const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_]/g, "_");

/** The station's MAC in `mac`-header form (colons), when its account IS a MAC. Those are the "phase B"
 *  devices (the 1083/58A family): the cloud does not list them, the app builds their account from the
 *  MAC it learns at introduction, and it dials them with a `mac` header instead of `auto_insertion:
 *  true` - they answer 486 Busy to the latter. A cloud-listed station has a generated account name, no
 *  MAC shape, and keeps the auto_insertion header. Returns "" for a non-MAC account. Shared by the
 *  door-open (opendoor) and the 2Voice video (recv) paths so both dial a 58A the same way. */
export function macHeaderOf(user: string): string {
  return /^([0-9a-f]{2}_){5}[0-9a-f]{2}$/i.test(user)
    ? user.replace(/_/g, ":")
    : "";
}

/** An openable 2Voice relay (a door and a gate per place; see doors()). */
export interface TwoVoiceDoor {
  placeId: string;
  name: string;
  kind: "door" | "gate";
}

interface PendingOpen {
  resolve: () => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Helper {
  place: Place;
  child?: ChildProcess;
  outUri?: string; // station URI the live child was spawned with (opendoor takes it as argv)
  buf: string; // stdout line-assembly buffer
  // FIFO of in-flight opens awaiting their RESULT line. A queue (not a single slot) so rapid
  // consecutive presses all reach opendoor -- it queues the tones and sends them at StreamsRunning /
  // on the keep-alive call, and reports RESULT per command in order.
  pending: PendingOpen[];
}

export class TwoVoiceService {
  private helpers = new Map<string, Helper>(); // placeId -> its persistent opendoor
  private stopping = false;

  constructor(
    private places: Place[],
    private keepaliveMs = 0, // >0: hold the call open this long for instant door-then-gate; 0: per-press
    private prewarmHoldMs = 15000, // how long a prewarm() (ready button) keeps the call open
  ) {}

  /** The 2Voice places' openable relays: a DOOR (DTMF '1') and a GATE (DTMF '2') per place. 2Voice
   *  has no capability discovery for a gate - the protocol uses a fixed GATE_DTMF='2' and simply
   *  offers both, letting the panel act on the tone - so we expose both and the user uses whichever
   *  their installation has wired. */
  doors(): TwoVoiceDoor[] {
    return this.places.flatMap((p) => [
      { placeId: p.id, name: p.name, kind: "door" as const },
      { placeId: p.id, name: p.name, kind: "gate" as const },
    ]);
  }

  /** Spawn one persistent, pre-registered opendoor per 2Voice place. Call once at startup. */
  start(): void {
    for (const p of this.places) {
      if (!p.incomingUser || !p.incomingPw) {
        log.warn(
          `2Voice place ${p.id} has no channel account; door-open unavailable`,
        );
        continue;
      }
      this.helpers.set(p.id, { place: p, buf: "", pending: [] });
      if (!p.outgoingUser) {
        log.warn(
          `2Voice place ${p.id} has no station account yet; waiting for the device to register`,
        );
        continue;
      }
      this.spawn(p.id);
    }
  }

  /** Start (or restart) the helper now that the station URI is known. opendoor fixes the URI at spawn. */
  stationLearned(placeId: string): void {
    if (this.stopping) return;
    const h = this.helpers.get(placeId);
    if (!h || !h.place.outgoingUser) return;
    if (h.child) {
      if (h.outUri === this.stationUri(h.place)) return;
      log.info(`2Voice station for ${placeId} changed; restarting its helper`);
      h.child.removeAllListeners("exit");
      h.child.kill("SIGTERM");
      h.child = undefined;
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
    // this line with opendoor's own "outgoing header" + call-error-code lines to confirm.
    log.info(
      `2Voice place ${p.id} (${p.name}): door-open via ${mac ? `mac header ${mac}` : "auto_insertion"} to station ${p.outgoingUser}`,
    );
    const dataDir = `/tmp/lp_2v_${sanitize(p.id)}/`;
    try {
      mkdirSync(dataDir, { recursive: true });
    } catch {
      /* opendoor falls back to a default dir */
    }
    // stdin = open commands; stdout = RESULT + [opendoor] logs (we parse + forward); stderr -> log.
    const child = spawn("opendoor", [p.incomingUser, p.incomingPw, outUri], {
      env: {
        ...process.env,
        OPENDOOR_PERSISTENT: "1",
        OPENDOOR_DATA_DIR: dataDir,
        OPENDOOR_KEEPALIVE_MS: String(this.keepaliveMs),
        OPENDOOR_PREWARM_HOLD_MS: String(this.prewarmHoldMs),
        OPENDOOR_UUID: instanceUuid(p.incomingUser, p.id),
        ...(mac ? { OPENDOOR_MAC: mac } : {}),
      },
      stdio: ["pipe", "pipe", "inherit"],
    });
    h.child = child;
    h.outUri = outUri;
    h.buf = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => this.onStdout(placeId, d));
    child.on("error", (e) =>
      log.error(`2Voice opendoor [${p.id}] spawn error: ${e.message}`),
    );
    child.on("exit", (code) => {
      h.child = undefined;
      for (const p of h.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`opendoor exited (code ${code ?? "killed"})`));
      }
      h.pending = [];
      if (!this.stopping) {
        log.warn(
          `2Voice opendoor [${p.id}] exited (code ${code}); respawning in ${RESPAWN_MS}ms`,
        );
        setTimeout(() => this.spawn(placeId), RESPAWN_MS);
      }
    });
    log.info(
      `2Voice door helper starting for ${p.id} (${p.name}) via ${p.outgoingUser}`,
    );
  }

  // Assemble opendoor's stdout into lines: forward each to the add-on log, and resolve the pending
  // open when its `RESULT <digit> ok|fail` arrives.
  private onStdout(placeId: string, data: string): void {
    const h = this.helpers.get(placeId);
    if (!h) return;
    h.buf += data;
    let nl: number;
    while ((nl = h.buf.indexOf("\n")) >= 0) {
      const line = h.buf.slice(0, nl).trimEnd();
      h.buf = h.buf.slice(nl + 1);
      if (!line) continue;
      log.info(line); // opendoor lines are already "[opendoor] …"
      const m = /RESULT ([12]) (ok|fail)/.exec(line);
      if (m && h.pending.length > 0) {
        // opendoor reports RESULT in the order it received the tones -> match FIFO.
        const { resolve, reject, timer } = h.pending.shift()!;
        clearTimeout(timer);
        if (m[2] === "ok") resolve();
        else reject(new Error("open failed (tone not delivered)"));
      }
    }
  }

  /** Open a 2Voice door/gate via the pre-registered helper: write the DTMF digit to its stdin and
   *  resolve when it reports RESULT ok (rejects on fail/timeout/dead helper). */
  open(placeId: string, kind: "door" | "gate" = "door"): Promise<void> {
    const h = this.helpers.get(placeId);
    if (!h) return Promise.reject(new Error(`unknown 2Voice place ${placeId}`));
    if (!h.child || !h.child.stdin?.writable)
      return Promise.reject(
        new Error(
          h.place.outgoingUser
            ? `2Voice helper for ${placeId} not ready (registering?)`
            : `station for ${placeId} not known yet`,
        ),
      );
    const digit = DIGIT[kind];
    log.info(`opening ${kind} on 2Voice place ${placeId} (${h.place.name})`);
    // No busy-reject: write the tone straight to opendoor's stdin and queue the resolver. opendoor
    // queues tones received while the call is setting up and sends them at StreamsRunning, so a rapid
    // second press (door then gate) isn't lost.
    return new Promise<void>((resolve, reject) => {
      const entry: PendingOpen = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const i = h.pending.indexOf(entry);
          if (i >= 0) {
            h.pending.splice(i, 1);
            reject(new Error("open timed out"));
          }
        }, OPEN_TIMEOUT_MS),
      };
      h.pending.push(entry);
      h.child!.stdin!.write(digit + "\n");
    });
  }

  /** Pre-warm a place's call (on a doorbell ring): tell the helper to open the auto_insertion call
   *  NOW, with no tone, so the unlock press moments later rides an already-established call (instant).
   *  Fire-and-forget - no RESULT is expected; the helper releases the bus on its
   *  own if no unlock follows. No-op if the helper isn't ready or the place isn't a 2Voice door. */
  prewarm(placeId: string): boolean {
    const h = this.helpers.get(placeId);
    if (!h || !h.child || !h.child.stdin?.writable) return false;
    log.info(
      `pre-warming 2Voice call for ${placeId} (${h.place.name}) on ring`,
    );
    h.child.stdin.write("W\n");
    return true;
  }

  stop(): void {
    this.stopping = true;
    for (const h of this.helpers.values()) {
      for (const p of h.pending) clearTimeout(p.timer);
      h.pending = [];
      h.child?.removeAllListeners("exit");
      try {
        h.child?.stdin?.end(); // closes opendoor's stdin -> it exits cleanly
      } catch {
        /* ignore */
      }
      h.child?.kill("SIGTERM");
    }
    this.helpers.clear();
  }
}
