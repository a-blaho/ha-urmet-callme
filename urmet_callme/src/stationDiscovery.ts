// Phase-B 2Voice devices (the 1083/58A family) are not listed by the cloud: get_my_devices returns no
// place at all. The account still works - the call-forwarding device registers on the SAME shared SIP
// account as the phones - so a place is synthesized from the instance account, and its station
// (OUTGOING) account, the device's MAC written `00_1E_E0_03_38_F8`, is learned three ways, in order of
// preference: the device answers an `introduction_req` sent to our own account with its MAC and a
// human name (the app's discovery); the REGISTER census shows a non-phone binding whose RFC 5626
// instance UUID node is the MAC; a doorbell ring on the instance account carries the station in its
// From. The result is persisted (station.ts) so a restart needs no device online.
import { InstanceAccount, PlaceData } from "./cloud.js";
import { DoorbellRing } from "./doorbell.js";
import { logger } from "./logger.js";
import { macHeaderOf, Place } from "./place.js";
import { buildBody } from "./query.js";
import { callerName, SipClient, uriUser } from "./sipClient.js";
import { loadStation, saveStation } from "./station.js";

const log = logger("station");

// How long introduce() waits for an introduction_resp before falling back to the SIP census. Short:
// the census/ring paths still cover a device that answers late (the hook stays attached).
const INTRODUCE_WAIT_MS = 4000;

/** The SIP account an Urmet call-forwarding device registers as: the 12-hex node at the end of its
 *  RFC 5626 instance UUID (`…-001ee00338f8`) is the MAC, written `00_1E_E0_03_38_F8`. */
export function macUserOfInstance(instanceId: string): string {
  const node = /-([0-9a-f]{12})$/i.exec(instanceId)?.[1];
  return node ? node.toUpperCase().replace(/(..)(?=.)/g, "$1_") : "";
}

export class StationDiscovery {
  /** The synthesized place, once built. */
  place?: Place;
  /** Fires when the place's station account becomes known (introduction, census, disk, or a ring).
   *  The 2Voice helper needs that URI at spawn time. */
  onStationLearned?: (place: Place) => void;
  private onRing?: (r: DoorbellRing) => void;
  private introResolve?: () => void; // resolves the in-flight introduce() wait on the first response

  constructor(private instance: () => InstanceAccount) {}

  /** A place standing in for a device the cloud didn't list, driven by the instance SIP account.
   *  Channel 1 is unused (2Voice never builds a cloud request body). The station is restored from
   *  disk when a previous run already found it. Reused on reconnect (CallMe keeps the object). */
  synthesize(realm: string): Place {
    const inst = this.instance();
    const d: PlaceData = {
      channel_number: "1",
      channel_id: inst.username,
      credentials: inst.password,
      out_credentials_username: "",
      device_uid: "instance",
      device_name: "CallMe",
    };
    if (this.place) {
      this.place.incomingUser = inst.username;
      this.place.incomingPw = inst.password;
      return this.place;
    }
    const p = new Place(d, realm);
    p.familyOverride = "twovoice";
    p.synthesized = true;
    const saved = loadStation(p.id);
    if (saved) {
      p.outgoingUser = saved;
      log.info(`restored learned station ${saved} for place ${p.id}`);
    }
    this.place = p;
    return p;
  }

  /** Hook the instance account's SipClient: route `introduction_resp` MESSAGEs and (once
   *  listenRing() was called) inbound INVITEs to the synthesized place. Re-applied after every
   *  reconnect, which replaces the client. */
  attach(sip: SipClient): void {
    const place = this.place;
    if (!place) return;
    sip.onIntroduction = ({ mac, name }) => {
      log.info(`introduction_resp: mac=${mac || "(none)"} name=${name || "(none)"} (place ${place.id})`);
      // The station (OUTGOING) account is the MAC written with underscores, same value the door/video
      // paths key the `mac` header on.
      if (mac) this.setStation(place, mac.replace(/:/g, "_"), "introduction");
      if (name && name !== place.name) {
        log.info(`place ${place.id} name: "${place.name}" -> "${name}"`);
        place.name = name;
      }
      this.introResolve?.();
    };
    const onRing = this.onRing;
    if (onRing)
      sip.onInvite = ({ headers, callId }) => {
        const from = headers["from"] || "";
        const caller = callerName(from);
        log.info(`DOORBELL RING on the instance account (place ${place.id}): ${caller} (call ${callId})`);
        this.setStation(place, uriUser(from), "ring");
        try {
          onRing({ placeId: place.id, from, caller });
        } catch (e) {
          log.error(`doorbell handler error: ${(e as Error).message}`);
        }
      };
  }

  /** Route rings arriving on the INSTANCE account to the doorbell handler. This place IS the
   *  instance account, which the main client already registers: registering it a second time on its
   *  own connection would REPLACE that binding rather than add one (the +sip.instance id is derived
   *  from the username), so the existing client is tapped instead (attach). */
  listenRing(sip: SipClient, onRing: (r: DoorbellRing) => void): void {
    this.onRing = onRing;
    this.attach(sip);
    if (this.place)
      log.info(`doorbell listening on the instance account ${this.place.incomingUser} (place ${this.place.id})`);
  }

  /** Primary discovery: send an introduction_req to our OWN account (the registrar forks it to the
   *  devices) and wait briefly for one to answer with its MAC + name. Best-effort: on timeout the
   *  census is tried (applyStationFromBindings), and a later answer or ring still teaches it. */
  async introduce(sip: SipClient, responseUri: string): Promise<void> {
    const place = this.place;
    if (!place) return;
    const answered = new Promise<void>((resolve) => (this.introResolve = resolve));
    try {
      const body = buildBody({
        typeReq: "introduction_req",
        channel: place.channel,
        responseUri,
        tokenPassword: place.incomingPw,
      });
      await sip.sendCallme(responseUri, body, false);
      log.debug("sent introduction_req; waiting for a device to answer");
    } catch (e) {
      log.debug(`introduction_req send failed: ${(e as Error).message}`);
    }
    await Promise.race([answered, new Promise<void>((r) => setTimeout(r, INTRODUCE_WAIT_MS))]);
    this.introResolve = undefined;
    if (!place.outgoingUser) this.applyStationFromBindings(sip);
  }

  /** Device SIP names from the registrar's Contact census. Phones carry push parameters; the
   *  call-forwarding device does not, and its instance UUID node is its MAC / account name. */
  private deviceCandidates(sip: SipClient): string[] {
    const bindings = sip.bindings();
    // DIAGNOSTIC (58A support): dump the census so a tester's debug log shows whether the device even
    // appears, and what account name we derive from it. If the device is registered but this prints
    // 0 bindings, the registrar folded them onto one Contact line (parse gap); if it prints a binding
    // but "-> (no mac node)", the account name isn't the instance MAC.
    log.debug(`REGISTER census: ${bindings.length} other binding(s) on this account`);
    const users = new Set<string>();
    const me = this.instance().username;
    for (const b of bindings) {
      const user = macUserOfInstance(b.instanceId);
      log.debug(
        `  binding: push=${b.push} instance=${b.instanceId ? "yes" : "no"} -> ${b.push ? "(phone, skipped)" : user || "(no mac node)"}`,
      );
      if (b.push) continue;
      if (user && user !== me) users.add(user);
    }
    return [...users];
  }

  /** Set the station from the current SIP bindings. No-op when none are present (device offline);
   *  a later doorbell ring can still teach it via setStation. */
  private applyStationFromBindings(sip: SipClient): void {
    const place = this.place;
    if (!place) return;
    const users = this.deviceCandidates(sip);
    if (!users.length) {
      log.warn("no call-forwarding device in this account's SIP bindings; door-open waits until it registers");
      return;
    }
    if (users.length > 1) log.warn(`multiple device bindings (${users.join(", ")}); using ${users[0]}`);
    this.setStation(place, users[0], "census");
  }

  /** Record the station SIP user and persist it. `source` (introduction/census/ring) is logged so a
   *  tester's log shows WHERE a station came from and whether a later ring changes it. The
   *  `mac-shaped` flag matters because the 2Voice helper sends the `mac` header only for a MAC-shaped
   *  account (58A) and `auto_insertion` otherwise -- if a ring overwrites a MAC-shaped station with a
   *  differently-shaped one, the header choice flips. */
  private setStation(place: Place, user: string, source: string): void {
    if (!user || user === this.instance().username) return;
    if (place.outgoingUser === user) return;
    const previous = place.outgoingUser;
    place.outgoingUser = user;
    saveStation(place.id, user);
    const macShaped = macHeaderOf(user) !== "";
    log.info(
      `station ${user} (mac-shaped=${macShaped}) for place ${place.id} from ${source}` +
        (previous ? ` (was ${previous})` : ""),
    );
    try {
      this.onStationLearned?.(place);
    } catch (e) {
      log.error(`station handler error: ${(e as Error).message}`);
    }
  }
}
