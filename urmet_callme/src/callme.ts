// The CallMe session: cloud login -> instance SIP account -> places -> SIP registration, plus the
// parts that hang off it (ipercom.ts for the gateway protocol, doorbell.ts for the per-place ring
// listeners, stationDiscovery.ts for the phase-B place the cloud does not list). index.ts talks to
// this one object; the modules behind it never see each other.
import { Cloud, InstanceAccount, isPowerDown } from "./cloud.js";
import { DoorbellListeners, DoorbellRing } from "./doorbell.js";
import { AvailableDevice, DeviceCallOpts, Door, IpercomGateway } from "./ipercom.js";
import { logger, redact } from "./logger.js";
import { Place } from "./place.js";
import { SipClient } from "./sipClient.js";
import { StationDiscovery } from "./stationDiscovery.js";

const log = logger("callme");

export class CallMe {
  instance!: InstanceAccount;
  realm!: string;
  places: Place[] = [];
  sip!: SipClient;
  responseUri!: string;
  /** The one cloud HTTP session (cookie jar); re-logged-in on every connect(). Shared with the video
   *  service, which mints its camera account through it instead of logging in a second time. */
  readonly cloud = new Cloud();
  readonly gateway = new IpercomGateway(
    () => this.sip,
    () => this.responseUri,
  );
  private doorbell?: DoorbellListeners;
  private stations = new StationDiscovery(() => this.instance);

  constructor(
    private email: string,
    private password: string,
  ) {}

  /** Fires when a synthesized place's station account is known (introduction, census, disk, or a
   *  later ring). The 2Voice helper needs that URI at spawn time. */
  get onStationLearned(): ((place: Place) => void) | undefined {
    return this.stations.onStationLearned;
  }
  set onStationLearned(fn: ((place: Place) => void) | undefined) {
    this.stations.onStationLearned = fn;
  }

  async connect(): Promise<this> {
    log.info(`connecting: cloud login as ${this.email}`);
    // login + sipdata, with a retry for the transient post-(re)install 302 (see loginAndSipAccount).
    this.instance = await this.cloud.loginAndSipAccount(this.email, this.password);
    log.info("cloud login OK; SIP account fetched (sipdata)");
    this.realm = this.instance.realm;
    log.info(
      `SIP account = ${this.instance.username} (pw ${redact(this.instance.password)}) realm ${this.realm}`,
    );
    const data = await this.cloud.getMyDevices();
    if (data.length) {
      // Update the places IN PLACE, keyed by id: on a reconnect the 2Voice/video/announce services
      // still hold the Place objects handed out at startup, so a fresh array would leave them with
      // stale credentials (Place.update). Places the cloud no longer lists are dropped with a warning.
      const next: Place[] = [];
      for (const d of data) {
        const fresh = new Place(d, this.realm);
        const existing = this.places.find((p) => p.id === fresh.id);
        if (existing) {
          existing.update(d);
          next.push(existing);
        } else next.push(fresh);
        // The app marks such a place unavailable and offers no calls on it; we keep the entities but
        // say why a camera or door call to it is about to fail.
        if (isPowerDown(d))
          log.warn(
            `place ${fresh.id} (${fresh.name}): the cloud reports its main power supply DOWN; calls to it will likely fail until it is back`,
          );
      }
      const gone = this.places.filter((p) => !next.includes(p));
      if (gone.length)
        log.warn(
          `get_my_devices no longer lists place(s) ${gone.map((p) => p.id).join(", ")}; their entities stay until a restart`,
        );
      this.places = next;
    } else {
      // Phase-B CallMe devices (1083/58A family) are not listed by the cloud. The 2Voice door-open
      // path only needs this account plus the station URI, learned by StationDiscovery.
      if (!this.stations.place)
        log.warn("get_my_devices listed no devices; using a 2Voice place built from the instance SIP account");
      this.places = [this.stations.synthesize(this.realm)];
    }
    log.info(
      `get_my_devices: ${this.places.length} place(s): ${this.places.map((p) => `${p.id}(${p.name})`).join(", ")}`,
    );
    // Surface each device's model code. The raw uid_type is a numeric model (e.g. "1060", "1760_16"),
    // logged as-is rather than classified. For an unfamiliar model, set log_level: debug and inspect
    // the "device shape (redacted)" line above (secrets are masked) to assess support.
    for (const p of this.places)
      log.info(`device ${p.id} (${p.name || "?"}): uid_type=${p.uidType || "(none)"}`);
    await this.connectSip();
    if (this.stations.place) await this.stations.introduce(this.sip, this.responseUri);
    return this;
  }

  /** SIP register the instance account. On a reconnect this replaces this.sip; the old socket is
   *  closed first so a half-open connection from a prior drop isn't leaked, and the phase-B hooks
   *  (introduction replies, instance-account rings) are re-attached to the new client. */
  async connectSip(): Promise<void> {
    this.responseUri = `sip:${this.instance.username}@${this.realm}`;
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
    this.stations.attach(this.sip);
  }

  close() {
    this.sip?.close();
    this.doorbell?.close();
  }

  /** Fire `onRing` when an entrance panel rings a place: the per-place channel accounts get their own
   *  listeners (DoorbellListeners); the synthesized phase-B place rings on the instance account itself
   *  and is tapped there. Only fires when the monitor is set to "remote" - that's when the panel
   *  forwards the call. We ring but never answer (no media) and never decline, so the phone is
   *  undisturbed. */
  async startDoorbell(onRing: (r: DoorbellRing) => void): Promise<void> {
    const synthesized = this.places.filter((p) => p.synthesized);
    if (synthesized.length) this.stations.listenRing(this.sip, onRing);
    this.doorbell = new DoorbellListeners(this.realm);
    await this.doorbell.start(this.places.filter((p) => !p.synthesized), onRing);
  }

  /** Keepalive / re-register the doorbell listeners; call from the maintenance loop. */
  async maintainDoorbell(): Promise<void> {
    await this.doorbell?.maintain();
  }

  /** Mint the dedicated camera account on the cloud through the already-authenticated session. */
  createUniqueSipAccount(): Promise<InstanceAccount> {
    return this.cloud.createUniqueSipAccount(this.email, this.realm);
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

  // ---- IPERCOM gateway protocol, by place id (ipercom.ts) ----
  resolveGateway(placeId?: string, force = false): Promise<string> {
    return this.gateway.resolveGateway(this.place(placeId), force);
  }
  listDoors(placeId?: string): Promise<Door[]> {
    return this.gateway.listDoors(this.place(placeId));
  }
  listDevices(placeId?: string): Promise<AvailableDevice[]> {
    return this.gateway.listDevices(this.place(placeId));
  }
  callDevice(opts: DeviceCallOpts, placeId?: string): Promise<number> {
    return this.gateway.callDevice(opts, this.place(placeId));
  }
  cancelCall(opts: DeviceCallOpts, placeId?: string): Promise<number> {
    return this.gateway.cancelCall(opts, this.place(placeId));
  }
  open(doorId: number, doorType: "door" | "gate" = "door", placeId?: string): Promise<any> {
    return this.gateway.open(doorId, doorType, this.place(placeId));
  }
}
