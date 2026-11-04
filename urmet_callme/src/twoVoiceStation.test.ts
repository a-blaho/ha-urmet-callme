import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { PlaceData } from "./cloud.js";
import { Place } from "./place.js";
import {
  HelperChild,
  HelperProcs,
  HelperTiming,
  talkFifoOf,
  TwoVoiceStation,
} from "./twoVoiceStation.js";

/** A stand-in for the station helper process: records what the service writes to its stdin and
 *  which signals it gets; the test feeds its stdout lines and decides when it exits. */
class FakeChild extends EventEmitter implements HelperChild {
  stdin = new PassThrough();
  stdout = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kills: NodeJS.Signals[] = [];
  cmds = ""; // everything written to stdin so far

  constructor(
    public args: string[],
    public env: NodeJS.ProcessEnv,
  ) {
    super();
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", (d: string) => (this.cmds += d));
    this.stdin.on("error", () => {});
  }
  kill(signal: NodeJS.Signals = "SIGTERM") {
    this.kills.push(signal);
    return true;
  }
  /** The process ends on its own (or after a SIGTERM). */
  exit(code = 0) {
    this.exitCode = code;
    this.emit("exit", code);
  }
  /** The process is killed by a signal. */
  die(signal: NodeJS.Signals) {
    this.signalCode = signal;
    this.emit("exit", null);
  }
  /** One stdout line from the helper. */
  say(line: string) {
    this.stdout.write(line + "\n");
  }
}

class FakeProcs implements HelperProcs {
  spawns: FakeChild[] = [];
  fifos: string[] = [];
  spawn(_command: string, args: string[], env: NodeJS.ProcessEnv): HelperChild {
    const c = new FakeChild(args, env);
    this.spawns.push(c);
    return c;
  }
  mkfifo(path: string): void {
    this.fifos.push(path);
  }
}

const REALM = "sip.urmet.com";
const STATION = "00_1E_E0_03_38_F8";
const OTHER_STATION = "00_1E_E0_AA_BB_CC";

function place(over: Partial<PlaceData> = {}): Place {
  return new Place(
    {
      channel_number: "1",
      channel_id: "chan1",
      credentials: "pw1",
      out_credentials_username: STATION,
      device_uid: "dev1",
      device_name: "Door",
      uid_type: "1083/58A",
      ...over,
    },
    REALM,
  );
}

function service(p: Place, timing: Partial<HelperTiming> = {}) {
  const procs = new FakeProcs();
  const svc = new TwoVoiceStation([p], REALM, {
    keepaliveMs: 4000,
    prewarmHoldMs: 15000,
    talkDtmf: "4",
    audioAtStart: false,
    timing: { respawnMs: 10, restartExitMs: 20, cameraReplyMs: 50, openTimeoutMs: 200, switchTimeoutMs: 200, ...timing },
    procs,
  });
  return { svc, procs };
}

/** Let stream events and awaited promises settle. */
async function flush(rounds = 6) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("start() spawns one helper per place with the channel account, the station URI and the mac header", () => {
  const p = place();
  const { svc, procs } = service(p);
  svc.start();
  assert.equal(procs.spawns.length, 1);
  const c = procs.spawns[0];
  assert.deepEqual(c.args, ["chan1", "pw1", `sip:${STATION}@${REALM}`]);
  assert.equal(c.env.STATION_MAC, "00:1E:E0:03:38:F8");
  assert.equal(c.env.STATION_AUDIO_IN, talkFifoOf(p.id));
  assert.ok(procs.fifos.includes(talkFifoOf(p.id)), "the announcement FIFO is (re)created");
});

test("a place without a station gets no helper until placesRefreshed() or stationLearned() sees one", () => {
  const p = place({ out_credentials_username: "" });
  const { svc, procs } = service(p);
  svc.start();
  assert.equal(procs.spawns.length, 0);
  svc.placesRefreshed();
  assert.equal(procs.spawns.length, 0, "still no station");
  p.outgoingUser = STATION;
  svc.placesRefreshed();
  assert.equal(procs.spawns.length, 1, "the station is known now");
  svc.stationLearned(p.id);
  assert.equal(procs.spawns.length, 1, "same station: no second helper");
});

test("a changed station restarts the helper, but only once the old one has exited", async () => {
  const p = place();
  const { svc, procs } = service(p);
  svc.start();
  svc.stationLearned(p.id);
  await flush();
  assert.equal(procs.spawns.length, 1, "unchanged station: nothing to do");

  p.outgoingUser = OTHER_STATION;
  svc.stationLearned(p.id);
  await flush();
  const old = procs.spawns[0];
  assert.deepEqual(old.kills, ["SIGTERM"]);
  assert.equal(old.stdin.writable, false, "its stdin is closed too");
  assert.equal(procs.spawns.length, 1, "no replacement while the old helper still runs");

  old.exit(0);
  await flush();
  assert.equal(procs.spawns.length, 2);
  assert.equal(procs.spawns[1].args[2], `sip:${OTHER_STATION}@${REALM}`);
});

test("changed channel credentials restart the helper; one that ignores SIGTERM is killed first", async () => {
  const p = place();
  const { svc, procs } = service(p, { restartExitMs: 20 });
  svc.start();
  const old = procs.spawns[0];

  svc.placesRefreshed();
  await flush();
  assert.deepEqual(old.kills, [], "same account and station: untouched");

  p.incomingPw = "pw2";
  svc.placesRefreshed();
  await flush();
  assert.deepEqual(old.kills, ["SIGTERM"]);
  await sleep(40); // past restartExitMs with no exit
  assert.deepEqual(old.kills, ["SIGTERM", "SIGKILL"]);
  assert.equal(procs.spawns.length, 1, "still waiting for the kill to land");

  old.die("SIGKILL");
  await flush();
  assert.equal(procs.spawns.length, 2);
  assert.equal(procs.spawns[1].args[1], "pw2");
});

test("the delayed respawn after an exit never adds a second helper", async () => {
  const p = place();
  const { svc, procs } = service(p, { respawnMs: 10 });
  svc.start();
  procs.spawns[0].exit(1); // the helper died: a respawn is due in 10 ms
  await flush();
  p.outgoingUser = OTHER_STATION;
  svc.stationLearned(p.id); // no child right now -> spawns at once
  await flush();
  assert.equal(procs.spawns.length, 2);
  await sleep(30); // the respawn timer fires into a place that already has its helper
  assert.equal(procs.spawns.length, 2, "the timer's spawn is a no-op");
  assert.equal(procs.spawns[1].exitCode, null);
});

test("a dead helper is respawned after the respawn delay when nothing else did", async () => {
  const p = place();
  const { svc, procs } = service(p, { respawnMs: 10 });
  svc.start();
  procs.spawns[0].exit(1);
  await flush();
  assert.equal(procs.spawns.length, 1);
  await sleep(30);
  assert.equal(procs.spawns.length, 2);
});

test("replies from a retired helper never answer the replacement's commands", async () => {
  const p = place();
  const { svc, procs } = service(p);
  svc.start();
  const old = procs.spawns[0];
  p.incomingPw = "pw2";
  svc.placesRefreshed();
  await flush();
  old.exit(0);
  await flush();
  const fresh = procs.spawns[1];

  let outcome: string | undefined;
  const opened = svc.open(p.id, "door").then(
    () => (outcome = "ok"),
    (e: Error) => (outcome = e.message),
  );
  await flush();
  assert.equal(fresh.cmds, "1\n", "the tone went to the new helper");

  old.say("RESULT 1 ok"); // a buffered line from the retired process
  await flush();
  assert.equal(outcome, undefined, "a stale reply must not resolve the new helper's command");

  fresh.say("RESULT 1 ok");
  await opened;
  assert.equal(outcome, "ok");
});

test("a restart fails the commands queued on the old helper instead of leaving them hanging", async () => {
  const p = place();
  const { svc, procs } = service(p);
  svc.start();
  const pending = svc.open(p.id, "gate");
  await flush();
  p.outgoingUser = OTHER_STATION;
  svc.stationLearned(p.id);
  await assert.rejects(pending, /restarting/);
});

test("CAMERA lines drive the camera flag; next camera is a no-op without a picture", async () => {
  const p = place();
  const { svc, procs } = service(p);
  svc.start();
  const c = procs.spawns[0];

  assert.equal(await svc.nextCamera(p.id), false);
  assert.equal(c.cmds, "", "no 'N' goes out while nothing is being watched");
  assert.equal(svc.hangup(p.id), false, "hang-up reports no picture was up");
  assert.equal(c.cmds, "H\n");

  c.say("CAMERA ok");
  await flush();
  assert.equal(svc.hasCall(p.id), true);
  const switched = svc.nextCamera(p.id);
  await flush();
  assert.equal(c.cmds, "H\nN\n");
  c.say("RESULT N ok");
  assert.equal(await switched, true);

  c.say("CAMERA fail the station call could not be placed");
  await flush();
  assert.equal(svc.hasCall(p.id), false, "a fail after ok ends the picture");

  c.say("CAMERA ok");
  await flush();
  c.say("CAMERA end");
  await flush();
  assert.equal(svc.hasCall(p.id), false);
});

test("RING lines track the held doorbell ring; a tone's failure is reported", async () => {
  const p = place();
  const { svc, procs } = service(p);
  svc.start();
  const c = procs.spawns[0];
  c.say("RING held");
  await flush();
  assert.equal(svc.ringing(p.id), true);
  c.say("RING gone");
  await flush();
  assert.equal(svc.ringing(p.id), false);

  const opened = svc.open(p.id, "door");
  await flush();
  c.say("[station] sent DTMF '1' (status -1)");
  c.say("RESULT 1 fail");
  await assert.rejects(opened, /tone not delivered/);
});

test("a tone with no reply in time rejects and frees its queue slot", async () => {
  const p = place();
  const { svc, procs } = service(p, { openTimeoutMs: 20 });
  svc.start();
  const c = procs.spawns[0];
  await assert.rejects(svc.open(p.id, "door"), /no reply/);
  // The next press gets its own reply, not the late one meant for the first.
  const second = svc.open(p.id, "gate");
  await flush();
  c.say("RESULT 2 ok");
  await second;
});

test("stop() terminates every helper and resolves once they have exited", async () => {
  const p = place();
  const { svc, procs } = service(p);
  svc.start();
  const c = procs.spawns[0];
  const stopped = svc.stop();
  await flush();
  assert.deepEqual(c.kills, ["SIGTERM"]);
  c.exit(0);
  await stopped;
  assert.equal(svc.hasCall(p.id), false);
});
