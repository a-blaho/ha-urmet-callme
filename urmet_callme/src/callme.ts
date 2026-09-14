// High-level Urmet CallMe (Ipercom) client: login -> SIP account -> devices ->
// register -> resolve gateway -> list entrances -> open. All dynamic; nothing hardcoded.
import { Cloud, InstanceAccount, NO_ACCOUNT, PlaceData } from "./cloud.js";
import { logger, redact } from "./logger.js";
import { buildBody, randId } from "./query.js";
import { SipClient, callerName, uriUser } from "./sipClient.js";
import { loadStation, saveStation } from "./station.js";

const log = logger("callme");

// How long connect() waits for an introduction_resp before falling back to the SIP census. Short:
// the census/ring paths still cover a device that answers late (attachIntroduction stays hooked).
const INTRODUCE_WAIT_MS = 4000;

/** Device family, derived from the raw get_my_devices `uid_type` MODEL code. IPERCOM opens doors
 *  with a cloud open_door_req (pure-Node); 2Voice opens with an in-call DTMF tone (the liblinphone
 *  `opendoor` path). */
export type Family = "ipercom" | "twovoice" | "unknown";
export function familyOf(uidType: string): Family {
  const u = (uidType || "").toLowerCase().replace(/\s+/g, "");
  if (u === "1060") return "ipercom";
  if (u === "1083/83" || u.startsWith("1760/")) return "twovoice";
  // The 2Voice CallMe call-forwarding devices (1083/58A, 1722/58A, 9854/58). Matched on the model
  // prefix because the trailing letter varies between catalogue/firmware revisions.
  if (/^(1083\/58|1722\/58|9854\/58)/.test(u)) return "twovoice";
  return "unknown";
}

/** The entrances in a `configuration_read` / `residentDoors` reply. The inner `response` is a JSON
 *  STRING on real gateways (the app double-decodes it) but an object on some firmware, so both are
 *  accepted. An entry with neither door_name nor gate_name is still listed (it can still ring). */
export function parseDoors(reply: any, placeId: string): Door[] {
  const doors: Door[] = [];
  for (const item of reply?.data?.response ?? []) {
    if (item.type !== "residentDoors") continue;
    const inner =
      typeof item.response === "string"
        ? JSON.parse(item.response)
        : item.response;
    for (const d of inner ?? []) {
      doors.push({
        placeId,
        doorId: d.id,
        name: d.device_name,
        hasDoor: !!d.door_name,
        hasGate: !!d.gate_name,
        topology: d.device_topology || "",
      });
    }
  }
  return doors;
}

/** Options for a device (camera) call/cancel request. */
interface DeviceCallOpts {
  topologicalCode: string;
  vdsTypes?: string;
  displayName?: string;
  callType?: string;
  /** Route the panel's INVITE to a DIFFERENT account (the split-account trick) for this call
   *  only, without mutating this.responseUri (which door-open replies still need). */
  responseUri?: string;
}

export interface Door {
  placeId: string;
  doorId: number;
  name: string;
  hasDoor: boolean;
  hasGate: boolean;
  topology: string;
}

export interface AvailableDevice {
  name: string;
  callType: string; // "calling_station" = camera, "intercom", ...
  topologicalCode: string;
  vdsTypes: string;
  sipDestination: string;
}

export class Place {
  channel: number;
  incomingUser: string; // INCOMING/channel account username (doorbell calls arrive here)
  incomingPw: string; // token password / INCOMING credentials ("" when absent)
  outgoingUser: string; // gateway-query target (OUTGOING)
  outgoingPw: string; // OUTGOING account password ("" when absent; needed for the 2Voice path)
  id: string;
  name: string;
  uidType: string; // raw device model code from get_my_devices ("1060" = IPERCOM, "1760/16" = 2Voice)
  // Set when the family can't be read from uid_type - i.e. on the place synthesized from the
  // instance account, where the cloud described no device at all (see CallMe.instancePlace).
  familyOverride?: Family;
  // True for that synthesized place. Its station (OUTGOING) account is the device's MAC-shaped SIP
  // name, recovered from the registrar's binding census (or restored from disk).
  synthesized = false;
  constructor(
    d: PlaceData,
    public realm: string,
  ) {
    this.channel = parseInt(d.channel_number, 10);
    this.incomingUser = d.channel_id || "";
    // "*" is the cloud's "no account here" placeholder - treat it as absent, not a password.
    this.incomingPw =
      d.credentials && d.credentials !== NO_ACCOUNT ? d.credentials : "";
    this.outgoingUser = d.out_credentials_username || "";
    this.outgoingPw =
      d.out_credentials_password && d.out_credentials_password !== NO_ACCOUNT
        ? d.out_credentials_password
        : "";
    // Display name precedence: relation_name -> device_name -> "APT-<channel>".
    this.name = d.relation_name || d.device_name || `APT-${d.channel_number}`;
    this.uidType = d.uid_type || "";
    this.id = `${d.device_uid || d.Mac_Address}-${d.channel_number}`;
  }
  get outgoingUri() {
    return `sip:${this.outgoingUser}@${this.realm}`;
  }
  /** Device family (ipercom / twovoice / unknown), from uid_type. Selects the door-open path. */
  get family(): Family {
    return this.familyOverride ?? familyOf(this.uidType);
  }
}

export interface DoorbellRing {
  placeId: string;
  from: string; // raw From header of the panel's INVITE
  caller: string; // human-readable caller (name/uri)
}

/** The SIP account an Urmet call-forwarding device registers as: the 12-hex node at the end of its
 *  RFC 5626 instance UUID (`…-001ee00338f8`) is the MAC, written `00_1E_E0_03_38_F8`. */
function macUserOfInstance(instanceId: string): string {
  const node = /-([0-9a-f]{12})$/i.exec(instanceId)?.[1];
  return node ? node.toUpperCase().replace(/(..)(?=.)/g, "$1_") : "";
}

export class CallMe {
  instance!: InstanceAccount;
  realm!: string;
  places: Place[] = [];
  sip!: SipClient;
  responseUri!: string;
  private gateways = new Map<string, string>();
  private doorbellClients: { sip: SipClient; place: Place }[] = [];
  // Ring routing for the synthesized place, which has no channel account of its own and so listens
  // on this.sip. Kept because a reconnect builds a fresh SipClient that must be re-hooked.
  private instanceRing?: { place: Place; onRing: (r: DoorbellRing) => void };
  // The synthesized place we run introduction discovery for, re-hooked after each connectSip().
  private introPlace?: Place;
  private introResolve?: () => void; // resolves the in-flight introduce() wait on the first response

  /** Fires when a synthesized place's station account is known (from the SIP census, disk, or a
   *  later ring). The 2Voice helper needs that URI at spawn time. */
  onStationLearned?: (place: Place) => void;

  constructor(
    private email: string,
    private password: string,
  ) {}

  async connect(): Promise<this> {
    log.info(`connecting: cloud login as ${this.email}`);
    const cloud = new Cloud();
    // login + sipdata, with a retry for the transient post-(re)install 302 (see loginAndSipAccount).
    this.instance = await cloud.loginAndSipAccount(this.email, this.password);
    log.info("cloud login OK; SIP account fetched (sipdata)");
    this.realm = this.instance.realm;
    log.info(
      `SIP account = ${this.instance.username} (pw ${redact(this.instance.password)}) realm ${this.realm}`,
    );
    const data = await cloud.getMyDevices();
    if (data.length) {
      this.places = data.map((d) => new Place(d, this.realm));
    } else {
      // Phase-B CallMe devices (1083/58A family) are not listed by the cloud. The 2Voice door-open
      // path only needs this account plus the station URI, which comes from the SIP registration
      // census (or a previous run's store). Reuse the object on reconnect so the helper's Place
      // reference stays valid.
      const existing = this.places.find((p) => p.synthesized);
      if (existing) {
        existing.incomingUser = this.instance.username;
        existing.incomingPw = this.instance.password;
      } else {
        log.warn(
          "get_my_devices listed no devices; using a 2Voice place built from the instance SIP account",
        );
      }
      this.places = [existing ?? this.instancePlace()];
    }
    log.info(
      `get_my_devices: ${this.places.length} place(s): ${this.places.map((p) => `${p.id}(${p.name})`).join(", ")}`,
    );
    // Surface each device's model code. The raw uid_type is a numeric model (e.g. "1060",
    // "1760_16"), logged as-is rather than classified. For an unfamiliar model, set log_level:
    // debug and inspect the "device shape (redacted)" line above (secrets are masked) to assess
    // support.
    for (const p of this.places) {
      log.info(
        `device ${p.id} (${p.name || "?"}): uid_type=${p.uidType || "(none)"}`,
      );
    }
    await this.connectSip();
    const synthesized = this.places.find((p) => p.synthesized);
    if (synthesized) {
      // Primary discovery: ask the shared account "who's there?" (introduction_req) -- phase-B
      // devices answer with their MAC and a human name, exactly like the app. This gives both the
      // station account AND a real display name, more reliably than inferring the station from the
      // REGISTER binding census. The census (and a later ring) remain fallbacks.
      this.introPlace = synthesized;
      this.attachIntroduction();
      await this.introduce(synthesized);
      if (!synthesized.outgoingUser) this.applyStationFromBindings(synthesized);
    }
    return this;
  }

  /** Send an introduction_req to our OWN account and wait briefly for the device to answer with its
   *  MAC + name (see attachIntroduction / onIntroduction). Best-effort: on timeout the caller falls
   *  back to the SIP census. */
  private async introduce(place: Place): Promise<void> {
    const answered = new Promise<void>((resolve) => (this.introResolve = resolve));
    try {
      const body = buildBody({
        typeReq: "introduction_req",
        channel: place.channel,
        responseUri: this.responseUri,
        tokenPassword: place.incomingPw,
      });
      // Sent to the shared account itself (this.responseUri); the registrar forks it to the devices.
      await this.sip.sendCallme(this.responseUri, body, false);
      log.debug("sent introduction_req; waiting for a device to answer");
    } catch (e) {
      log.debug(`introduction_req send failed: ${(e as Error).message}`);
    }
    await Promise.race([
      answered,
      new Promise<void>((r) => setTimeout(r, INTRODUCE_WAIT_MS)),
    ]);
    this.introResolve = undefined;
  }

  /** Route an inbound introduction_resp to the synthesized place. Re-applied after every
   *  connectSip() (which replaces this.sip), so a device that announces itself later is still heard. */
  private attachIntroduction(): void {
    if (!this.introPlace || !this.sip) return;
    const place = this.introPlace;
    this.sip.onIntroduction = ({ mac, name }) => {
      log.info(
        `introduction_resp: mac=${mac || "(none)"} name=${name || "(none)"} (place ${place.id})`,
      );
      // The station (OUTGOING) account is the MAC written with underscores, same value the door/video
      // paths key the `mac` header on.
      if (mac) this.setStation(place, mac.replace(/:/g, "_"), "introduction");
      if (name && name !== place.name) {
        log.info(`place ${place.id} name: "${place.name}" -> "${name}"`);
        place.name = name;
      }
      this.introResolve?.();
    };
  }

  /** Device SIP names from the registrar's Contact census. Phones carry push parameters; the
   *  call-forwarding device does not, and its instance UUID node is its MAC / account name. */
  private deviceCandidates(): string[] {
    const bindings = this.sip.bindings();
    // DIAGNOSTIC (58A support): dump the census so a tester's debug log shows whether the
    // call-forwarding device even appears, and what account name we derive from it. If the device is
    // registered but this prints 0 bindings, the registrar folded them onto one Contact line (parse
    // gap); if it prints a binding but "-> (no mac node)", the account name isn't the instance MAC.
    log.debug(`REGISTER census: ${bindings.length} other binding(s) on this account`);
    const users = new Set<string>();
    for (const b of bindings) {
      const user = macUserOfInstance(b.instanceId);
      log.debug(
        `  binding: push=${b.push} instance=${b.instanceId ? "yes" : "no"} -> ${b.push ? "(phone, skipped)" : user || "(no mac node)"}`,
      );
      if (b.push) continue;
      if (user && user !== this.instance.username) users.add(user);
    }
    return [...users];
  }

  /** Set the station from the current SIP bindings. No-op when none are present (device offline);
   *  a later doorbell ring can still teach it via setStation. */
  private applyStationFromBindings(place: Place): void {
    const users = this.deviceCandidates();
    if (!users.length) {
      log.warn(
        "no call-forwarding device in this account's SIP bindings; door-open waits until it registers",
      );
      return;
    }
    if (users.length > 1)
      log.warn(
        `multiple device bindings (${users.join(", ")}); using ${users[0]}`,
      );
    this.setStation(place, users[0], "census");
  }

  /** A place standing in for a device the cloud didn't list, driven by the instance SIP account.
   *  Channel 1 is unused (2Voice never builds a cloud request body). The station is restored from
   *  disk when a previous run already found it. */
  private instancePlace(): Place {
    const p = new Place(
      {
        channel_number: "1",
        channel_id: this.instance.username,
        credentials: this.instance.password,
        out_credentials_username: "",
        device_uid: "instance",
        device_name: "CallMe",
      },
      this.realm,
    );
    p.familyOverride = "twovoice";
    p.synthesized = true;
    const saved = loadStation(p.id);
    if (saved) {
      p.outgoingUser = saved;
      log.info(`restored learned station ${saved} for place ${p.id}`);
    }
    return p;
  }

  /** Route rings arriving on the INSTANCE account to the doorbell handler. Re-applied after every
   *  connectSip(), which replaces this.sip. */
  private attachInstanceRing(): void {
    const ctx = this.instanceRing;
    if (!ctx || !this.sip) return;
    const { place, onRing } = ctx;
    this.sip.onInvite = ({ headers, callId }) => {
      const from = headers["from"] || "";
      const caller = callerName(from);
      log.info(
        `DOORBELL RING on the instance account (place ${place.id}): ${caller} (call ${callId})`,
      );
      this.setStation(place, uriUser(from), "ring");
      try {
        onRing({ placeId: place.id, from, caller });
      } catch (e) {
        log.error(`doorbell handler error: ${(e as Error).message}`);
      }
    };
  }

  /** Record the station SIP user and persist it. `source` (census/ring/disk) is logged so we can
   *  see, from a tester's log, WHERE a station came from and whether a later ring changes it. The
   *  `mac-shaped` flag matters because door2voice sends the `mac` header only for a MAC-shaped
   *  account (58A) and `auto_insertion` otherwise -- if a ring overwrites a MAC-shaped station with
   *  a differently-shaped one, the header choice flips (a suspected failure mode we're verifying). */
  private setStation(place: Place, user: string, source: string): void {
    if (!user || user === this.instance.username) return;
    if (place.outgoingUser === user) return;
    const previous = place.outgoingUser;
    place.outgoingUser = user;
    saveStation(place.id, user);
    const macShaped = /^([0-9a-f]{2}_){5}[0-9a-f]{2}$/i.test(user);
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

  /** SIP register. */
  async connectSip(): Promise<void> {
    this.responseUri = `sip:${this.instance.username}@${this.realm}`;
    // On a reconnect this replaces this.sip; close the old socket first so a half-open
    // connection from a prior drop isn't leaked.
    this.sip?.close();
    this.sip = new SipClient(
      this.realm,
      5061,
      this.instance.username,
      this.instance.password,
      this.realm,
      "tls",
    );
    await this.sip.connect();
    const st = await this.sip.register();
    if (st !== 200) throw new Error(`SIP registration failed (${st})`);
    log.info(`SIP registered as ${this.instance.username} (200 OK)`);
    this.attachInstanceRing();
    this.attachIntroduction();
  }

  close() {
    this.sip?.close();
    for (const c of this.doorbellClients) c.sip.close();
  }

  /** Register the INCOMING/channel account of each place on its own connection and fire
   *  `onRing` when the entrance panel calls it (a doorbell ring). Only fires when the
   *  monitor is set to "remote" - that's when the panel forwards the call to the account.
   *  We ring but never answer (no media) and never decline, so the phone is undisturbed. */
  async startDoorbell(onRing: (r: DoorbellRing) => void): Promise<void> {
    for (const place of this.places) {
      if (place.synthesized) {
        // This place IS the instance account, which this.sip already registers. Registering it a
        // second time on its own connection would REPLACE that binding rather than add one (the
        // +sip.instance id is derived from the username), so tap the existing client instead.
        this.instanceRing = { place, onRing };
        this.attachInstanceRing();
        log.info(
          `doorbell listening on the instance account ${place.incomingUser} (place ${place.id})`,
        );
        continue;
      }
      if (!place.incomingUser || !place.incomingPw) {
        log.warn(
          `place ${place.id} has no channel account; doorbell unavailable`,
        );
        continue;
      }
      const sip = new SipClient(
        this.realm,
        5061,
        place.incomingUser,
        place.incomingPw,
        this.realm,
        "tls",
      );
      sip.onInvite = ({ headers, callId }) => {
        const from = headers["from"] || "";
        const caller = callerName(from);
        log.info(
          `DOORBELL RING on place ${place.id}: ${caller} (call ${callId})`,
        );
        try {
          onRing({ placeId: place.id, from, caller });
        } catch (e) {
          log.error(`doorbell handler error: ${(e as Error).message}`);
        }
      };
      try {
        await sip.connect();
        const st = await sip.register();
        if (st !== 200) {
          log.warn(
            `doorbell listener register failed for ${place.incomingUser} (${st})`,
          );
          sip.close();
          continue;
        }
        log.info(
          `doorbell listener registered as ${place.incomingUser} (place ${place.id})`,
        );
        this.doorbellClients.push({ sip, place });
      } catch (e) {
        log.warn(
          `doorbell listener setup failed for place ${place.id}: ${(e as Error).message}`,
        );
      }
    }
  }

  /** Keepalive / re-register the doorbell listeners; call from the maintenance loop. Each listener
   *  refreshes on its OWN granted expiry (dueForReregister), so a capped lifetime can't lapse it. */
  async maintainDoorbell(): Promise<void> {
    for (const { sip } of this.doorbellClients) {
      try {
        if (!sip.alive()) {
          await sip.connect();
          await sip.register();
        } else if (sip.dueForReregister()) {
          await sip.register();
        }
      } catch {
        /* retry next tick */
      }
    }
  }

  private place(id?: string): Place {
    if (!id) {
      // Guard the default: with no places at all, every caller below would otherwise fail on a
      // property of undefined rather than saying what's wrong.
      if (!this.places.length) throw new Error("no places on this account");
      return this.places[0];
    }
    const p = this.places.find((x) => x.id === id);
    if (!p) throw new Error(`unknown place ${id}`);
    return p;
  }

  private async query(
    destUri: string,
    typeReq: string,
    place: Place,
    extra?: Record<string, unknown>,
    timeoutMs = 15000,
  ): Promise<any> {
    const body = buildBody({
      typeReq,
      channel: place.channel,
      responseUri: this.responseUri,
      tokenPassword: place.incomingPw,
      extra,
    });
    const { status, reply } = await this.sip.sendCallme(
      destUri,
      body,
      true,
      timeoutMs,
    );
    if (status < 200 || status >= 300)
      throw new Error(`${typeReq}: SIP send status ${status}`);
    return reply;
  }

  async resolveGateway(placeId?: string, force = false): Promise<string> {
    const place = this.place(placeId);
    if (!force && this.gateways.has(place.id))
      return this.gateways.get(place.id)!;
    const reply = await this.query(
      place.outgoingUri,
      "get_gateway_sip_address_req",
      place,
    );
    if (!reply?.sip_address)
      throw new Error(`gateway resolution failed: ${JSON.stringify(reply)}`);
    const gw = "sip:" + reply.sip_address;
    this.gateways.set(place.id, gw);
    // `alive` (defaults true when absent) is the panel's own reachability flag; false normally
    // means the place is unreachable. We still try (the flag is occasionally stale and a real open
    // may succeed) but warn loudly so a black/timed-out open has an explanation.
    if (reply.alive === false)
      log.warn(
        `gateway(${place.id}) reports alive=false - the entrance panel may be offline; open may fail`,
      );
    log.info(
      `gateway(${place.id}) resolved = ${reply.sip_address} (alive=${reply.alive})`,
    );
    return gw;
  }

  async listDoors(placeId?: string): Promise<Door[]> {
    const place = this.place(placeId);
    const gw = await this.resolveGateway(placeId);
    const reply = await this.query(gw, "configuration_read_req", place, {
      data: { request: [{ id: randId(), type: "residentDoors" }] },
    });
    if (reply?.result !== 0)
      throw new Error(`list_doors failed: ${JSON.stringify(reply)}`);
    return parseDoors(reply, place.id);
  }

  /** List the place's callable devices (cameras, intercoms) via get_available_devices_req.
   *  Cameras have call_type "calling_station" and carry the vds_types that call_device_req
   *  needs to make the panel actually stream video. */
  async listDevices(placeId?: string): Promise<AvailableDevice[]> {
    const place = this.place(placeId);
    const gw = await this.resolveGateway(placeId);
    const reply = await this.query(gw, "get_available_devices_req", place);
    const raw: any[] = reply?.devices ?? [];
    return raw.map((d) => ({
      name: d.name ?? "",
      callType: d.call_type ?? "",
      topologicalCode: d.topological_code ?? "",
      vdsTypes: d.vds_types ?? "",
      sipDestination: d.sip_destination ?? "",
    }));
  }

  /** Ask an entrance panel to call us back for monitoring. The panel then sends an INVITE
   *  to our INSTANCE URI whose SDP offer carries the cloud RTP relay. To get VIDEO (not just
   *  audio) the request must carry the camera's vds_types + topological_code.
   *  Signaling only - media is handled by MediaRelay. Returns the MESSAGE send status. */
  async callDevice(opts: DeviceCallOpts, placeId?: string): Promise<number> {
    return this.deviceCall("call_device_req", opts, placeId);
  }

  /** End a monitoring call via a gateway `cancel_call_req` whose body is IDENTICAL to the
   *  `call_device_req` that started the call (same call_type/topological_code/vds_types/uri_to_call),
   *  only the type differs. Used as a fallback for a call that never established a SIP dialog to BYE;
   *  without a teardown the door station can hold that camera's channel "busy" until its own session
   *  timer, which makes rapid re-views fail. */
  async cancelCall(opts: DeviceCallOpts, placeId?: string): Promise<number> {
    return this.deviceCall("cancel_call_req", opts, placeId);
  }

  private async deviceCall(
    typeReq: "call_device_req" | "cancel_call_req",
    opts: DeviceCallOpts,
    placeId?: string,
  ): Promise<number> {
    const place = this.place(placeId);
    const gw = await this.resolveGateway(placeId);
    const target = opts.responseUri ?? this.responseUri;
    const body = buildBody({
      typeReq,
      channel: place.channel,
      responseUri: target,
      tokenPassword: place.incomingPw,
      extra: {
        call_type: opts.callType ?? "calling_station",
        display_name: opts.displayName ?? "HomeAssistant",
        topological_code: opts.topologicalCode,
        uri_to_call: target,
        vds_types: opts.vdsTypes ?? "",
      },
    });
    log.info(`${typeReq} -> ${gw}`);
    log.debug(`${typeReq} body: ${JSON.stringify(body)}`);
    // Reply (for call_device_req) is the panel's INVITE, not a correlated MESSAGE, so don't
    // wait for one - just confirm the send.
    const { status } = await this.sip.sendCallme(gw, body, false);
    if (status < 200 || status >= 300)
      throw new Error(`${typeReq}: SIP send status ${status}`);
    return status;
  }

  /** Open a door/gate. doorType: 'door' | 'gate'. Retries once with a fresh gateway. */
  async open(
    doorId: number,
    doorType: "door" | "gate" = "door",
    placeId?: string,
    retry = true,
  ): Promise<any> {
    const place = this.place(placeId);
    let gw = await this.resolveGateway(placeId);
    let reply: any;
    try {
      reply = await this.query(gw, "open_door_req", place, {
        door_id: doorId,
        door_type: doorType,
      });
    } catch (e) {
      if (!retry) throw e;
      gw = await this.resolveGateway(placeId, true);
      reply = await this.query(gw, "open_door_req", place, {
        door_id: doorId,
        door_type: doorType,
      });
    }
    if (reply?.result !== 0) {
      if (retry) {
        await this.resolveGateway(placeId, true);
        return this.open(doorId, doorType, placeId, false);
      }
      throw new Error(`open failed: ${JSON.stringify(reply)}`);
    }
    log.info(
      `opened ${doorType} door_id=${doorId} on place ${place.id}: result=${reply.result}`,
    );
    return reply;
  }
}
