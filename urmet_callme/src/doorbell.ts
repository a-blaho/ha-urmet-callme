// Doorbell listeners: one SipClient per place registered on its INCOMING/channel account, where the
// entrance panel's INVITE (the ring) arrives when the indoor monitor is set to "remote". We ring (180)
// but never answer (no media) and never decline, so the phone is undisturbed; the ring is surfaced
// as an MQTT `event`. The synthesized phase-B place rings on the instance account itself and is
// handled by StationDiscovery, not here.
import { logger } from "./logger.js";
import { Place } from "./place.js";
import { callerName, SipClient } from "./sipClient.js";

const log = logger("doorbell");

export interface DoorbellRing {
  placeId: string;
  from: string; // raw From header of the panel's INVITE
  caller: string; // human-readable caller (name/uri)
}

export class DoorbellListeners {
  private clients: { sip: SipClient; place: Place }[] = [];
  private onRing: (r: DoorbellRing) => void = () => {};

  constructor(private realm: string) {}

  /** A client for the place's channel account as it is NOW (Place.update refreshes the credentials on
   *  a reconnect, so a client is never reused across a reconnect). */
  private makeClient(place: Place): SipClient {
    const sip = new SipClient(this.realm, 5061, place.incomingUser, place.incomingPw, this.realm, "tls");
    sip.onInvite = ({ headers, callId }) => {
      const from = headers["from"] || "";
      const caller = callerName(from);
      log.info(`DOORBELL RING on place ${place.id}: ${caller} (call ${callId})`);
      try {
        this.onRing({ placeId: place.id, from, caller });
      } catch (e) {
        log.error(`doorbell handler error: ${(e as Error).message}`);
      }
    };
    return sip;
  }

  /** Register the channel account of each given place on its own connection and fire `onRing` when
   *  the entrance panel calls it. A listener whose first connect/REGISTER fails is recorded anyway and
   *  retried by maintain() instead of being lost until the next add-on restart. */
  async start(places: Place[], onRing: (r: DoorbellRing) => void): Promise<void> {
    this.onRing = onRing;
    for (const place of places) {
      if (!place.incomingUser || !place.incomingPw) {
        log.warn(`place ${place.id} has no channel account; doorbell unavailable`);
        continue;
      }
      const sip = this.makeClient(place);
      this.clients.push({ sip, place });
      try {
        await sip.connect();
        const st = await sip.register();
        if (st !== 200) {
          log.warn(
            `doorbell listener register failed for ${place.incomingUser} (${st}); retrying on the next maintenance tick`,
          );
          sip.close();
          continue;
        }
        log.info(`doorbell listener registered as ${place.incomingUser} (place ${place.id})`);
      } catch (e) {
        log.warn(
          `doorbell listener setup failed for place ${place.id}: ${(e as Error).message}; retrying on the next maintenance tick`,
        );
      }
    }
  }

  /** Keepalive / re-register every listener; call from the maintenance loop. Each refreshes on its
   *  OWN granted expiry (dueForReregister), so a capped lifetime can't lapse it; a dead connection is
   *  reconnected and re-registered. */
  async maintain(): Promise<void> {
    for (const c of this.clients) {
      const { place } = c;
      try {
        if (!c.sip.alive()) {
          // Rebuilt, not reconnected: the place's credentials may have changed since (a reconnect
          // re-reads get_my_devices), and the old client would re-register the stale password forever.
          c.sip.close();
          c.sip = this.makeClient(place);
          const sip = c.sip;
          await sip.connect();
          const st = await sip.register();
          if (st === 200)
            log.info(`doorbell listener re-registered as ${place.incomingUser} (place ${place.id})`);
          else log.warn(`doorbell listener register failed for ${place.incomingUser} (${st})`);
        } else {
          c.sip.keepalive();
          if (c.sip.dueForReregister()) await c.sip.register();
        }
      } catch (e) {
        log.debug(`doorbell listener ${place.id}: ${(e as Error).message}; retry next tick`);
      }
    }
  }

  close(): void {
    for (const c of this.clients) c.sip.close();
  }
}
