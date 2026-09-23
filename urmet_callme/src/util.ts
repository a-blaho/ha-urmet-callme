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

/** The `RESULT <digit> ok|fail` line the liblinphone helpers print per door/gate tone (opendoor
 *  always; recv when it takes tones on the live camera call). Matched anywhere in the line: recv's
 *  lines carry a timestamp prefix, opendoor's a `[opendoor]` tag, and a fail may carry a reason. */
export function parseResult(line: string): { digit: "1" | "2"; ok: boolean } | null {
  const m = /RESULT ([12]) (ok|fail)/.exec(line);
  return m ? { digit: m[1] as "1" | "2", ok: m[2] === "ok" } : null;
}
