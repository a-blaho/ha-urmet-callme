// The IPERCOM gateway protocol: JSON requests in out-of-dialog SIP MESSAGEs (query.ts bodies) sent on
// the instance account's connection. Everything is dynamic: resolve the place's GATEWAY from its
// OUTGOING account, then ask the gateway for its entrances (`residentDoors`), its cameras
// (`get_available_devices_req`), to open a door (`open_door_req`) or to have a camera call us back
// (`call_device_req` / `cancel_call_req`). Replies are separate inbound MESSAGEs correlated by body id.
import { logger } from "./logger.js";
import { Place } from "./place.js";
import { buildBody, randId } from "./query.js";
import { SipClient } from "./sipClient.js";
import { sipUri } from "./util.js";

const log = logger("ipercom");

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

/** Options for a device (camera) call/cancel request. */
export interface DeviceCallOpts {
  topologicalCode: string;
  vdsTypes?: string;
  displayName?: string;
  callType?: string;
  /** Route the panel's INVITE to a DIFFERENT account (the split-account trick) for this call
   *  only, without changing the response_uri door-open replies still need. */
  responseUri?: string;
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

export class IpercomGateway {
  private gateways = new Map<string, string>(); // placeId -> resolved gateway URI (no TTL)

  /** `sip` / `responseUri` are getters because CallMe replaces its SipClient on every reconnect. */
  constructor(
    private sip: () => SipClient,
    private responseUri: () => string,
  ) {}

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
      responseUri: this.responseUri(),
      tokenPassword: place.incomingPw,
      extra,
    });
    const { status, reply } = await this.sip().sendCallme(destUri, body, true, timeoutMs);
    if (status < 200 || status >= 300)
      throw new Error(`${typeReq}: SIP send status ${status}`);
    return reply;
  }

  /** The place's gateway: `get_gateway_sip_address_req` to its OUTGOING account, cached per place
   *  and re-resolved on demand (`force`) after a delivery failure. */
  async resolveGateway(place: Place, force = false): Promise<string> {
    if (!force && this.gateways.has(place.id)) return this.gateways.get(place.id)!;
    const reply = await this.query(place.outgoingUri, "get_gateway_sip_address_req", place);
    if (!reply?.sip_address)
      throw new Error(`gateway resolution failed: ${JSON.stringify(reply)}`);
    const gw = sipUri(String(reply.sip_address));
    this.gateways.set(place.id, gw);
    // `alive` (defaults true when absent) is the panel's own reachability flag; false normally
    // means the place is unreachable. We still try (the flag is occasionally stale and a real open
    // may succeed) but warn loudly so a black/timed-out open has an explanation.
    if (reply.alive === false)
      log.warn(
        `gateway(${place.id}) reports alive=false - the entrance panel may be offline; open may fail`,
      );
    log.info(`gateway(${place.id}) resolved = ${reply.sip_address} (alive=${reply.alive})`);
    return gw;
  }

  async listDoors(place: Place): Promise<Door[]> {
    const gw = await this.resolveGateway(place);
    const reply = await this.query(gw, "configuration_read_req", place, {
      data: { request: [{ id: randId(), type: "residentDoors" }] },
    });
    if (reply?.result !== 0)
      throw new Error(`list_doors failed: ${JSON.stringify(reply)}`);
    return parseDoors(reply, place.id);
  }

  /** The place's callable devices (cameras, intercoms) via get_available_devices_req. Cameras have
   *  call_type "calling_station" and carry the vds_types that call_device_req needs to make the panel
   *  actually stream video. */
  async listDevices(place: Place): Promise<AvailableDevice[]> {
    const gw = await this.resolveGateway(place);
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

  /** Ask an entrance panel to call us back for monitoring. The panel then sends an INVITE to the
   *  `responseUri` (the shared camera account) whose SDP offer carries the cloud RTP relay. To get
   *  VIDEO (not just audio) the request must carry the camera's vds_types + topological_code.
   *  Signaling only; the media is answered by `recv`. Returns the MESSAGE send status. */
  callDevice(opts: DeviceCallOpts, place: Place): Promise<number> {
    return this.deviceCall("call_device_req", opts, place);
  }

  /** End a monitoring call via a gateway `cancel_call_req` whose body is IDENTICAL to the
   *  `call_device_req` that started the call, only the type differs. A fallback for a call that never
   *  established a SIP dialog to BYE: without a teardown the door station can hold that camera's
   *  channel "busy" until its own session timer, which makes rapid re-views fail. */
  cancelCall(opts: DeviceCallOpts, place: Place): Promise<number> {
    return this.deviceCall("cancel_call_req", opts, place);
  }

  private async deviceCall(
    typeReq: "call_device_req" | "cancel_call_req",
    opts: DeviceCallOpts,
    place: Place,
  ): Promise<number> {
    const gw = await this.resolveGateway(place);
    const target = opts.responseUri ?? this.responseUri();
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
    // Reply (for call_device_req) is the panel's INVITE, not a correlated MESSAGE, so don't wait for
    // one - just confirm the send.
    const { status } = await this.sip().sendCallme(gw, body, false);
    if (status < 200 || status >= 300)
      throw new Error(`${typeReq}: SIP send status ${status}`);
    return status;
  }

  /** Open a door/gate. Retries once with a fresh gateway. */
  async open(
    doorId: number,
    doorType: "door" | "gate",
    place: Place,
    retry = true,
  ): Promise<any> {
    let gw = await this.resolveGateway(place);
    let reply: any;
    try {
      reply = await this.query(gw, "open_door_req", place, { door_id: doorId, door_type: doorType });
    } catch (e) {
      if (!retry) throw e;
      gw = await this.resolveGateway(place, true);
      reply = await this.query(gw, "open_door_req", place, { door_id: doorId, door_type: doorType });
    }
    if (reply?.result !== 0) {
      if (retry) {
        await this.resolveGateway(place, true);
        return this.open(doorId, doorType, place, false);
      }
      throw new Error(`open failed: ${JSON.stringify(reply)}`);
    }
    log.info(`opened ${doorType} door_id=${doorId} on place ${place.id}: result=${reply.result}`);
    return reply;
  }
}
