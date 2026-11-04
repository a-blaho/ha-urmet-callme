// A place = one channel of one intercom device the cloud lists for the account (an apartment on a
// building's entrance system), with the SIP accounts the protocol needs and the family that decides
// how its door opens.
import { NO_ACCOUNT, PlaceData } from "./cloud.js";

/** Device family, derived from the raw get_my_devices `uid_type` MODEL code. IPERCOM opens doors
 *  with a cloud open_door_req (pure-Node); 2Voice opens with an in-call DTMF tone (the liblinphone
 *  `station` helper). The official app's model list is as strict as this one: an unknown model is
 *  dropped there too. */
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

export class Place {
  // The account fields are (re)assigned by update(), hence the definite-assignment marks.
  channel!: number;
  incomingUser!: string; // INCOMING/channel account username (doorbell calls arrive here)
  incomingPw!: string; // token password / INCOMING credentials ("" when absent)
  outgoingUser!: string; // gateway-query target (OUTGOING)
  outgoingPw!: string; // OUTGOING account password ("" when absent; needed for the 2Voice path)
  id: string;
  name!: string;
  uidType!: string; // raw device model code from get_my_devices ("1060" = IPERCOM, "1760/16" = 2Voice)
  // Set when the family can't be read from uid_type - i.e. on the place synthesized from the
  // instance account, where the cloud described no device at all (see StationDiscovery).
  familyOverride?: Family;
  // True for that synthesized place. Its station (OUTGOING) account is the device's MAC-shaped SIP
  // name, recovered from the registrar's binding census (or restored from disk).
  synthesized = false;
  constructor(
    d: PlaceData,
    public realm: string,
  ) {
    this.id = `${d.device_uid || d.Mac_Address}-${d.channel_number}`;
    this.update(d);
  }

  /** Refresh the account data from a (re)fetched get_my_devices entry. The services that drive the
   *  helpers (twoVoiceStation, announce) hold Place objects by reference, so a reconnect must update
   *  the existing object rather than replace it, or rotated channel credentials never reach them
   *  until a restart (see CallMe.connect). The id is derived from the same entry and never changes,
   *  so it is set once in the constructor. */
  update(d: PlaceData): void {
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
  }
  get outgoingUri() {
    return `sip:${this.outgoingUser}@${this.realm}`;
  }
  /** Device family (ipercom / twovoice / unknown), from uid_type. Selects the door-open path. */
  get family(): Family {
    return this.familyOverride ?? familyOf(this.uidType);
  }
}
