// The line protocol between the Node control plane and the liblinphone helpers (video-recv/station.c,
// video-recv/recv.c). Both helpers read single-letter commands from stdin, one per line, and answer on
// stdout with machine lines mixed into their human log lines. This module is the ONE place that spells
// the alphabet out; the C side documents the same letters in each helper's usage text.
//
// stdin commands (a line each):
//   1 / 2   door / gate tone on the station call (placed first if none is up)   -> RESULT 1|2 ok|fail
//   N       next camera: '3' on the live call, or a re-dial when its audio is open   -> RESULT N ok|fail
//   A       open the station's audio ('4') once the call's media runs            -> no reply
//   W       pre-warm: open the station call now, no tone                        -> no reply
//   H       release: hang up the station call now (the camera stops with it)     -> no reply
//   T       announcement: place/hold a call for a clip from the talk FIFO        -> no reply
//   V <h264 fifo> <pcm fifo>  camera: tap the station call into those FIFOs  -> CAMERA ok|fail <why>
// stdout machine lines:
//   RESULT <1|2|N> ok|fail[ (reason)]   one per tone/switch command, in the order received
//   RING held | RING gone               the helper holds / released a doorbell ring (*_ANSWER_RING)
//   CAMERA ok | CAMERA fail <why>       reply to V
//   CAMERA live | CAMERA end            the picture's first keyframe arrived / the picture stopped
// Everything else on stdout is a log line to forward.
// The 2Voice helper is video-recv/station.c (every command); the Ipercom receiver recv.c takes only
// `T` (open the camera call's audio for a clip) and `R` (the same, answering the held doorbell ring),
// which it answers on RECV_TALK_DONE_URL, not stdout, and `E` (show the held ring on the camera without
// answering it: early media; no reply). It is otherwise driven by signals from video.ts.
// Its stdout has one machine line of its own: RECV RING held <panel> | RECV RING gone.

export const HelperCommand = {
  DOOR: "1",
  GATE: "2",
  NEXT_CAMERA: "N",
  OPEN_AUDIO: "A",
  PREWARM: "W",
  RELEASE: "H",
  TALK: "T",
  TALK_ON_RING: "R", // recv only
  RING_PICTURE: "E", // recv only
  CAMERA: "V",
} as const;

/** recv's ring lines: the doorbell ring it holds (and from which panel) or that none is held. */
export function parseRecvRing(line: string): { held: boolean; panel: string } | null {
  if (line === "RECV RING gone") return { held: false, panel: "" };
  const m = /^RECV RING held (\S+)$/.exec(line);
  return m ? { held: true, panel: m[1] } : null;
}

export type ToneDigit = "1" | "2" | "N";

/** The `V <h264> <pcm>` command line (without the trailing newline). */
export function cameraCommand(h264Fifo: string, pcmFifo: string): string {
  return `${HelperCommand.CAMERA} ${h264Fifo} ${pcmFifo}`;
}

/** The `RESULT <cmd> ok|fail` line the helpers print per command: door/gate tones '1'/'2' (the station helper
 *  always) and camera switches 'N'. Every
 *  command recv answers must match, or its pending queue shifts onto the wrong press. Matched anywhere
 *  in the line: the station's lines carry a `[station]` tag, recv's a timestamp prefix, and a fail may
 *  carry a reason. */
export function parseResult(line: string): { digit: ToneDigit; ok: boolean } | null {
  const m = /RESULT ([12N]) (ok|fail)/.exec(line);
  return m ? { digit: m[1] as ToneDigit, ok: m[2] === "ok" } : null;
}

export type HelperEvent =
  | { kind: "result"; digit: ToneDigit; ok: boolean }
  | { kind: "ring"; held: boolean }
  | { kind: "camera"; status: "ok" | "fail" | "live" | "end"; why: string }
  | { kind: "log" };

/** Classify one stdout line from a helper. Machine lines are exact (RING, CAMERA) or matched anywhere
 *  (RESULT, see parseResult); anything else is a log line. */
export function parseHelperLine(line: string): HelperEvent {
  if (line === "RING held" || line === "RING gone")
    return { kind: "ring", held: line === "RING held" };
  const cam = /^CAMERA (ok|fail|live|end)\b ?(.*)$/.exec(line);
  if (cam)
    return { kind: "camera", status: cam[1] as "ok" | "fail" | "live" | "end", why: cam[2] || "" };
  const r = parseResult(line);
  if (r) return { kind: "result", ...r };
  return { kind: "log" };
}
