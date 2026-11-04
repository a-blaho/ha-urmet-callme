// The line protocol between the Node control plane and the liblinphone helpers (video-recv/opendoor.c,
// video-recv/recv.c). Both helpers read single-letter commands from stdin, one per line, and answer on
// stdout with machine lines mixed into their human log lines. This module is the ONE place that spells
// the alphabet out; the C side documents the same letters in each helper's usage text.
//
// stdin commands (a line each):
//   1 / 2   door / gate tone on the station call (placed first if none is up)   -> RESULT 1|2 ok|fail
//   N       next camera (recv only; opendoor has no camera call to switch)      -> RESULT N ok|fail
//   A       open the station's audio before an announcement (recv only)         -> no reply
//   W       pre-warm: open the station call now, no tone (opendoor only)        -> no reply
//   H       release: hang up a held call now (opendoor only)                    -> no reply
//   T       announcement: place/hold a call for a clip (opendoor only)          -> no reply
//   V <h264 fifo> <pcm fifo>  show the held ring call on the camera (opendoor)  -> CAMERA ok|fail <why>
// stdout machine lines:
//   RESULT <1|2|N> ok|fail[ (reason)]   one per tone/switch command, in the order received
//   RING held | RING gone               opendoor holds / released a doorbell ring (OPENDOOR_ANSWER_RING)
//   CAMERA ok | CAMERA fail <why> | CAMERA end   reply to V, and the ring call's picture ending
// Everything else on stdout is a log line to forward.

export const HelperCommand = {
  DOOR: "1",
  GATE: "2",
  NEXT_CAMERA: "N",
  OPEN_AUDIO: "A",
  PREWARM: "W",
  RELEASE: "H",
  TALK: "T",
  CAMERA: "V",
} as const;

export type ToneDigit = "1" | "2" | "N";

/** The `V <h264> <pcm>` command line (without the trailing newline). */
export function cameraCommand(h264Fifo: string, pcmFifo: string): string {
  return `${HelperCommand.CAMERA} ${h264Fifo} ${pcmFifo}`;
}

/** The `RESULT <cmd> ok|fail` line the helpers print per command: door/gate tones '1'/'2' (opendoor
 *  always; recv when it takes tones on the live camera call) and camera switches 'N' (recv only). Every
 *  command recv answers must match, or its pending queue shifts onto the wrong press. Matched anywhere
 *  in the line: recv's lines carry a timestamp prefix, opendoor's a `[opendoor]` tag, and a fail may
 *  carry a reason. */
export function parseResult(line: string): { digit: ToneDigit; ok: boolean } | null {
  const m = /RESULT ([12N]) (ok|fail)/.exec(line);
  return m ? { digit: m[1] as ToneDigit, ok: m[2] === "ok" } : null;
}

export type HelperEvent =
  | { kind: "result"; digit: ToneDigit; ok: boolean }
  | { kind: "ring"; held: boolean }
  | { kind: "camera"; status: "ok" | "fail" | "end"; why: string }
  | { kind: "log" };

/** Classify one stdout line from a helper. Machine lines are exact (RING, CAMERA) or matched anywhere
 *  (RESULT, see parseResult); anything else is a log line. */
export function parseHelperLine(line: string): HelperEvent {
  if (line === "RING held" || line === "RING gone")
    return { kind: "ring", held: line === "RING held" };
  const cam = /^CAMERA (ok|fail|end)\b ?(.*)$/.exec(line);
  if (cam) return { kind: "camera", status: cam[1] as "ok" | "fail" | "end", why: cam[2] || "" };
  const r = parseResult(line);
  if (r) return { kind: "result", ...r };
  return { kind: "log" };
}
