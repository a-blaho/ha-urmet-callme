// Small pure helpers shared across modules. Keep this file dependency-free (node:crypto only) so it
// is trivially unit-testable and can never pull the media/MQTT stacks into a test.
import { createHash } from "node:crypto";

/** MQTT/HA-safe identifier: anything but [A-Za-z0-9_] becomes `_`. Used for entity unique_ids,
 *  device identifiers and per-place data directories. */
export const sanitize = (s: string): string => s.replace(/[^a-zA-Z0-9_]/g, "_");

/** A deterministic RFC 4122-shaped UUID from a seed string (md5, formatted 8-4-4-4-12). The SIP
 *  clients use it as their RFC 5626 `+sip.instance` id so a restart REPLACES the registrar binding
 *  instead of adding one. The seed is part of the wire identity: changing a caller's seed changes
 *  the binding it replaces, so seeds are pinned by the tests in util.test.ts. */
export function stableUuid(seed: string): string {
  const h = createHash("md5").update(seed).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** A SIP URI from an address the gateway/cloud supplied. Installations differ: some send the bare
 *  `user@host`, others the full `sip:user@host`. Prepending the scheme blindly turns the latter into
 *  `sip:sip:user@host`, which Flexisip answers with 404. */
export function sipUri(address: string): string {
  const a = address.trim();
  return /^sips?:/i.test(a) ? a : `sip:${a}`;
}

/** The SIP User-Agent every component presents: the official app's, which the 2Voice station may gate
 *  outgoing calls on. The C helpers carry the same literal (they cannot import this). */
export const SIP_USER_AGENT = "UrmetCallForwarding-Android";

/** The per-camera FIFO pair the media helper writes and stream.sh's ffmpeg reads: raw Annex-B H.264 and
 *  raw PCM (s16le 8 kHz mono, G.711 forced). Camera `i` is the go2rtc stream `urmet_cam_<i>`; the paths
 *  are passed to stream.sh as arguments. stream.sh re-checks them against this exact shape before
 *  handing them to ffmpeg (go2rtc's LAN API lets anyone choose the arguments), so keep the two in step. */
export function camFifos(i: number): { h264: string; pcm: string } {
  return { h264: `/tmp/urmet_cam_${i}.h264`, pcm: `/tmp/urmet_cam_${i}.pcm` };
}
