import { test } from "node:test";
import assert from "node:assert/strict";
import { cameraCommand, HelperCommand, parseHelperLine, parseResult } from "./helperProtocol.js";

// Both helpers' tone replies must parse, whatever surrounds the RESULT token.
test("parseResult reads the station's and recv's RESULT lines", () => {
  assert.deepEqual(parseResult("[station] RESULT 1 ok"), { digit: "1", ok: true });
  assert.deepEqual(parseResult("2026-09-23T10:00:00.123Z [recv] RESULT 2 ok"), {
    digit: "2",
    ok: true,
  });
  assert.deepEqual(parseResult("2026-09-23T10:00:00.123Z [recv] RESULT 1 fail (no call up)"), {
    digit: "1",
    ok: false,
  });
  // recv's camera switch must match too, or its pending queue shifts onto the next door press
  assert.deepEqual(parseResult("2026-11-03T10:00:00.123Z [recv] RESULT N fail (hung up)"), {
    digit: "N",
    ok: false,
  });
  assert.equal(parseResult("RESULT 3 ok"), null); // '3' is sent inside a switch, never answered
  assert.equal(parseResult("[station] sent DTMF '1' (status 0)"), null);
  assert.equal(parseResult("RESULT 4 ok"), null); // open-audio is never answered with a RESULT
});

test("parseHelperLine classifies the machine lines and leaves the rest as log", () => {
  assert.deepEqual(parseHelperLine("RING held"), { kind: "ring", held: true });
  assert.deepEqual(parseHelperLine("RING gone"), { kind: "ring", held: false });
  assert.deepEqual(parseHelperLine("CAMERA ok"), { kind: "camera", status: "ok", why: "" });
  assert.deepEqual(parseHelperLine("CAMERA fail no ring"), { kind: "camera", status: "fail", why: "no ring" });
  assert.deepEqual(parseHelperLine("CAMERA fail early media refused"), {
    kind: "camera",
    status: "fail",
    why: "early media refused",
  });
  assert.deepEqual(parseHelperLine("CAMERA end"), { kind: "camera", status: "end", why: "" });
  assert.deepEqual(parseHelperLine("CAMERA live"), { kind: "camera", status: "live", why: "" });
  assert.deepEqual(parseHelperLine("[station] RESULT 2 fail"), { kind: "result", digit: "2", ok: false });
  // Words that merely start with a machine token are log lines (the camera line is anchored).
  assert.deepEqual(parseHelperLine("[station] camera: no ring call to show"), { kind: "log" });
  assert.deepEqual(parseHelperLine("CAMERAS are great"), { kind: "log" });
  assert.deepEqual(parseHelperLine("RING held by someone"), { kind: "log" });
  assert.deepEqual(parseHelperLine("[station] registration: Ok ()"), { kind: "log" });
});

// The letters ARE the wire protocol with the C helpers (see their usage text); pin them.
test("the stdin command alphabet is pinned", () => {
  assert.deepEqual(HelperCommand, {
    DOOR: "1",
    GATE: "2",
    NEXT_CAMERA: "N",
    OPEN_AUDIO: "A",
    PREWARM: "W",
    RELEASE: "H",
    TALK: "T",
    CAMERA: "V",
  });
  assert.equal(cameraCommand("/tmp/a.h264", "/tmp/a.pcm"), "V /tmp/a.h264 /tmp/a.pcm");
});
