// Minimal SIP-over-TLS client. One persistent TLS socket carries REGISTER + all
// out-of-dialog MESSAGEs + inbound replies, so Flexisip trusts them (connection
// trust - a fresh connection is rejected 503). No media; door-open is MESSAGE-only.
import { createHash, randomBytes } from "node:crypto";
import * as tls from "node:tls";
import { logger } from "./logger.js";
import { stableUuid } from "./util.js";

const log = logger("sip");

const md5 = (s: string) => createHash("md5").update(s).digest("hex");
const rnd = (n = 12) => randomBytes(24).toString("hex").slice(0, n);

/** Human-readable caller from a SIP From header: `"Name" <uri>` -> `Name (uri)`. */
export function callerName(from: string): string {
  const name = /"?([^"<]*)"?\s*</.exec(from)?.[1]?.trim();
  const uri = /<([^>]+)>/.exec(from)?.[1] || from;
  return name ? `${name} (${uri})` : uri;
}

/** User part of a SIP header's URI: `"Panel" <sip:abc@host>` -> `abc`. On a panel's INVITE this is
 *  the calling station's account - the 2Voice door-open target. */
export function uriUser(header: string): string {
  return /sip:([^@>;]+)@/i.exec(header)?.[1] || "";
}

/** Via + Record-Route lines verbatim, in original order - a response MUST echo every
 *  Via the request carried (the proxy added its own) or it can't be routed back. */
function copyRoutingHeaders(rawHead: string): string[] {
  const out: string[] = [];
  for (const line of rawHead.split("\r\n").slice(1)) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    const n = line.slice(0, i).trim().toLowerCase();
    if (n === "via" || n === "v") out.push("Via: " + line.slice(i + 1).trim());
    else if (n === "record-route")
      out.push("Record-Route: " + line.slice(i + 1).trim());
  }
  return out;
}

function parseAuth(value: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /(\w+)=("([^"]*)"|[^,]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value)))
    out[m[1]] = m[3] !== undefined ? m[3] : m[2].trim();
  return out;
}

function digest(
  user: string,
  pass: string,
  realm: string,
  nonce: string,
  method: string,
  uri: string,
  qop?: string,
  opaque?: string,
  algorithm = "MD5",
): string {
  const nc = "00000001";
  const cnonce = rnd(16);
  const ha1 = md5(`${user}:${realm}:${pass}`);
  const ha2 = md5(`${method}:${uri}`);
  const resp = qop
    ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${nonce}:${ha2}`);
  const parts = [
    `username="${user}"`,
    `realm="${realm}"`,
    `nonce="${nonce}"`,
    `uri="${uri}"`,
    `response="${resp}"`,
    `algorithm=${algorithm}`,
  ];
  if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  if (opaque) parts.push(`opaque="${opaque}"`);
  return "Digest " + parts.join(", ");
}

interface SipResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** One Contact binding the registrar holds for our account. A CallMe account is shared: the user's
 *  phones register on it and so does a call-forwarding device, so the binding list is a census of
 *  what else lives on the account (see SipClient.bindings). */
export interface SipBinding {
  contact: string; // the Contact URI
  instanceId: string; // +sip.instance UUID ("" when the binding carries none)
  push: boolean; // carries push-notification parameters, i.e. a phone rather than a wired device
}

export class SipClient {
  private socket!: tls.TLSSocket;
  private localIp = "";
  private localPort = 0;
  // Our public mapping as Flexisip sees it (from received=/rport= on responses).
  // Contacts MUST advertise this, not the LAN address, or in-dialog requests (ACK,
  // BYE) loose-route to an unreachable private IP and the call never establishes.
  private publicIp = "";
  private publicPort = 0;
  // RFC 5626 outbound: a stable instance id gives ONE binding (re-registers replace it,
  // instead of piling up) and makes Flexisip hand back a pub-gruu.
  private instanceId = "";
  private pubGruu = "";
  // Registration refresh is driven by the expiry the REGISTRAR GRANTS (the Contact `expires=` /
  // `Expires` header on the 200 OK), not a fixed timer - Flexisip may cap our requested value well
  // below it, and refreshing on a stale fixed interval could then let the binding lapse.
  private grantedExpires = 0; // seconds granted at the last successful REGISTER
  private lastRegisterMs = 0; // when that REGISTER landed (0 = never registered)
  private otherBindings: SipBinding[] = []; // everything else registered on this account
  private recvBuf = Buffer.alloc(0);
  private callIdReg = rnd(16);
  private fromTag = rnd(12);
  private cseqCounter = 1;
  private pendingResp = new Map<string, (r: SipResponse) => void>();
  private pendingMsg = new Map<number, (o: any) => void>();
  private invites = new Map<
    string,
    { headers: Record<string, string>; toTag: string }
  >();

  /** Fires on every inbound INVITE. Used by the doorbell listener to surface a panel ring
   *  (uses `headers`/`callId`). We ring (180) but never answer (no media) or decline, so the
   *  phone is undisturbed. */
  onInvite?: (info: {
    headers: Record<string, string>;
    callId: string;
  }) => void;

  /** Fires on an inbound `introduction_resp` MESSAGE. Phase-B call-forwarding devices (1083/58A
   *  family) answer an `introduction_req` (sent to the shared account) with their MAC and a human
   *  name -- the app's device-discovery for devices the cloud does not list. */
  onIntroduction?: (info: { mac: string; name: string }) => void;

  private closing = false; // set by close() so an intentional teardown doesn't log as an error

  constructor(
    private server: string,
    private port: number,
    private username: string,
    private password: string,
    private realm: string,
    private transport = "tls",
  ) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      this.closing = false;
      this.socket = tls.connect(
        { host: this.server, port: this.port, servername: this.server },
        () => {
          this.localIp = this.socket.localAddress || "0.0.0.0";
          this.localPort = this.socket.localPort || 0;
          log.info(
            `TLS connected ${this.localIp}:${this.localPort} -> ${this.server}:${this.port}`,
          );
          settled = true;
          resolve();
        },
      );
      this.socket.on("data", (d) => {
        // The socket has no encoding set, so `d` is always a Buffer at runtime; newer @types/node
        // type the event as Buffer | string, hence the guard.
        const chunk = typeof d === "string" ? Buffer.from(d) : d;
        this.recvBuf = Buffer.concat([this.recvBuf, chunk]);
        this.drain();
      });
      this.socket.on("error", (e) => {
        if (!settled) {
          settled = true;
          reject(e);
          return;
        }
        // Post-connect failure: the connect promise is long settled, so reject is a no-op --
        // just log it. The maintenance loop's alive() probe drives reconnection.
        log.warn(`socket error: ${(e as Error).message}`);
      });
      this.socket.on("close", () => {
        if (!this.closing)
          log.warn("socket closed unexpectedly (reconnect on next keepalive)");
      });
      this.socket.setTimeout(0);
    });
  }

  close() {
    this.closing = true;
    try {
      this.socket.destroy();
    } catch {
      /* ignore */
    }
  }
  private keepalive() {
    this.socket.write("\r\n\r\n");
  }
  alive(): boolean {
    try {
      this.keepalive();
      return !this.socket.destroyed;
    } catch {
      return false;
    }
  }

  private uri() {
    return `sip:${this.username}@${this.realm}`;
  }
  private contact() {
    const ip = this.publicIp || this.localIp;
    const port = this.publicPort || this.localPort;
    return `<sip:${this.username}@${ip}:${port};transport=${this.transport}>`;
  }
  /** Stable per-account instance UUID (RFC 5626). */
  private instance(): string {
    if (!this.instanceId)
      this.instanceId = stableUuid(`urmet-callme:${this.username}`);
    return this.instanceId;
  }
  private via(branch: string) {
    return `SIP/2.0/${this.transport.toUpperCase()} ${this.localIp}:${this.localPort};branch=${branch};rport`;
  }

  private build(
    method: string,
    reqUri: string,
    toUri: string,
    callId: string,
    cseq: number,
    extra: string[],
    body: string,
    auth?: { which: "proxy" | "www"; value: string },
  ): { msg: string; branch: string } {
    const branch = "z9hG4bK" + rnd(16);
    const lines = [
      `${method} ${reqUri} SIP/2.0`,
      `Via: ${this.via(branch)}`,
      `Max-Forwards: 70`,
      `From: <sip:${this.username}@${this.realm}>;tag=${this.fromTag}`,
      `To: <${toUri}>`,
      `Call-ID: ${callId}`,
      `CSeq: ${cseq} ${method}`,
    ];
    if (auth)
      lines.push(
        `${auth.which === "proxy" ? "Proxy-Authorization" : "Authorization"}: ${auth.value}`,
      );
    lines.push(
      ...extra,
      `User-Agent: UrmetCallForwarding-Node`,
      `Content-Length: ${Buffer.byteLength(body)}`,
    );
    return { msg: lines.join("\r\n") + "\r\n\r\n" + body, branch };
  }

  private sendAndWait(
    msg: string,
    branch: string,
    timeoutMs: number,
  ): Promise<SipResponse | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingResp.delete(branch);
        resolve(null);
      }, timeoutMs);
      this.pendingResp.set(branch, (r) => {
        clearTimeout(timer);
        this.pendingResp.delete(branch);
        resolve(r);
      });
      log.debug(`>>> ${msg.split("\r\n")[0]} (branch ${branch.slice(-8)})`);
      this.socket.write(msg);
    });
  }

  private async request(
    method: string,
    reqUri: string,
    toUri: string,
    extra: string[],
    body = "",
    callId?: string,
    timeoutMs = 12000,
  ): Promise<SipResponse | null> {
    callId = callId ?? rnd(16);
    let { msg, branch } = this.build(
      method,
      reqUri,
      toUri,
      callId,
      this.cseqCounter++,
      extra,
      body,
    );
    let res = await this.sendAndWait(msg, branch, timeoutMs);
    if (res && (res.status === 401 || res.status === 407)) {
      const hv =
        res.headers["www-authenticate"] ||
        res.headers["proxy-authenticate"] ||
        "";
      const a = parseAuth(hv);
      const which = res.status === 407 ? "proxy" : "www";
      const value = digest(
        this.username,
        this.password,
        a.realm || this.realm,
        a.nonce,
        method,
        reqUri,
        a.qop,
        a.opaque,
        a.algorithm || "MD5",
      );
      const r2 = this.build(
        method,
        reqUri,
        toUri,
        callId,
        this.cseqCounter++,
        extra,
        body,
        { which, value },
      );
      res = await this.sendAndWait(r2.msg, r2.branch, timeoutMs);
    }
    if (res) log.debug(`<<< ${res.status}`);
    return res;
  }

  // ---- stream parsing ----
  private drain() {
    for (;;) {
      while (
        this.recvBuf.length >= 2 &&
        this.recvBuf[0] === 0x0d &&
        this.recvBuf[1] === 0x0a
      )
        this.recvBuf = this.recvBuf.subarray(2); // drop keepalive CRLFs
      const idx = this.recvBuf.indexOf("\r\n\r\n");
      if (idx < 0) return;
      const head = this.recvBuf.subarray(0, idx).toString("utf-8");
      const headers = this.parseHeaders(head);
      const clen = parseInt(headers["content-length"] || "0", 10) || 0;
      const total = idx + 4 + clen;
      if (this.recvBuf.length < total) return;
      const body = this.recvBuf.subarray(idx + 4, total).toString("utf-8");
      this.recvBuf = this.recvBuf.subarray(total);
      this.dispatch(headers, body);
    }
  }

  private parseHeaders(head: string): Record<string, string> {
    const lines = head.split("\r\n");
    const h: Record<string, string> = { _start: lines[0] || "", _raw: head };
    for (const line of lines.slice(1)) {
      const i = line.indexOf(":");
      if (i > 0)
        h[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    return h;
  }

  private dispatch(headers: Record<string, string>, body: string) {
    const start = headers._start;
    if (!start.trim()) return;
    log.debug(
      `<<< RAW inbound:\n${headers._raw}${body ? "\n\n" + body : ""}\n---`,
    );
    if (start.startsWith("SIP/2.0")) {
      const status = parseInt(start.split(" ")[1], 10);
      // Learn our public mapping from Flexisip's NAT annotations on our top Via.
      const via = headers["via"] || "";
      const rcv = /received=([^;,\s]+)/.exec(via)?.[1];
      const rp = /rport=(\d+)/.exec(via)?.[1];
      if (rcv) this.publicIp = rcv;
      if (rp) this.publicPort = parseInt(rp, 10);
      if (status < 200) return; // provisional
      const m = /branch=([^;,\s]+)/.exec(headers["via"] || "");
      const cb = m ? this.pendingResp.get(m[1]) : undefined;
      if (cb) cb({ status, headers, body });
      return;
    }
    const method = start.split(" ")[0];
    const callId = headers["call-id"] || "";
    if (method === "MESSAGE") {
      this.respondTo(headers, 200, "OK");
      this.onInboundMessage(headers, body);
    } else if (method === "OPTIONS") this.respondTo(headers, 200, "OK");
    else if (method === "INVITE") {
      // Inbound call to this account. On the doorbell (channel-account) client this is a
      // panel ring; `onInvite` surfaces it. We ring (180) but never answer (no media) or
      // decline, so the phone is undisturbed; the call releases cleanly on CANCEL/BYE.
      this.respondTo(headers, 100, "Trying");
      const toTag = rnd(10);
      this.respondTo(headers, 180, "Ringing", toTag); // ring, but never answer (no media stack)
      this.invites.set(callId, { headers, toTag });
      if (this.onInvite) {
        // Expected inbound ring on a doorbell listener; the handler logs + routes it.
        try {
          this.onInvite({ headers, callId });
        } catch {
          /* handler errors must not break SIP processing */
        }
      } else {
        // No handler on this client (e.g. the instance account) - an inbound call here is
        // unexpected. We ring (180) but never answer (no media).
        log.warn(
          `INBOUND CALL: INVITE from ${callerName(headers["from"] || "")} ` +
            `(Call-ID ${callId}); no handler - not answered.`,
        );
      }
    } else if (method === "CANCEL") {
      this.respondTo(headers, 200, "OK"); // 200 to the CANCEL
      const inv = this.invites.get(callId);
      if (inv) {
        this.respondTo(inv.headers, 487, "Request Terminated", inv.toTag);
        this.invites.delete(callId);
      }
      log.info(`inbound call ${callId} canceled/ended`);
    } else if (method === "BYE") {
      this.respondTo(headers, 200, "OK");
      this.invites.delete(callId);
      log.info(`inbound call ${callId} ended (BYE)`);
    } else if (method === "ACK")
      log.info(`inbound ACK for ${callId} - call established`);
  }

  private respondTo(
    req: Record<string, string>,
    code: number,
    reason: string,
    toTag?: string,
  ) {
    let to = req["to"] || "";
    if (toTag && !/tag=/.test(to)) to += `;tag=${toTag}`;
    const routing = req["_raw"]
      ? copyRoutingHeaders(req["_raw"])
      : [`Via: ${req["via"] || ""}`];
    const resp =
      [
        `SIP/2.0 ${code} ${reason}`,
        ...routing,
        `From: ${req["from"] || ""}`,
        `To: ${to}`,
        `Call-ID: ${req["call-id"] || ""}`,
        `CSeq: ${req["cseq"] || ""}`,
        "Content-Length: 0",
      ].join("\r\n") + "\r\n\r\n";
    try {
      this.socket.write(resp);
    } catch {
      /* ignore */
    }
  }

  private onInboundMessage(headers: Record<string, string>, body: string) {
    log.debug(`<<< inbound MESSAGE: ${body.slice(0, 160)}`);
    let obj: any;
    try {
      obj = JSON.parse(body);
    } catch {
      return;
    }
    // introduction_resp is unsolicited (a device announcing itself on the shared account), so route
    // it by type via the hook rather than by id-correlation. Other replies correlate by body id.
    if (obj.type === "introduction_resp" && this.onIntroduction) {
      this.onIntroduction({ mac: obj.mac || "", name: obj.name || "" });
      return;
    }
    const cb = this.pendingMsg.get(obj.id);
    if (cb) cb(obj);
  }

  // ---- public ----
  async register(expires = 3600): Promise<number> {
    const uuid = this.instance();
    const extra = [
      `Contact: ${this.contact()};+sip.instance="<urn:uuid:${uuid}>";reg-id=1`,
      `Expires: ${expires}`,
      "Supported: outbound, path, gruu",
    ];
    const res = await this.request(
      "REGISTER",
      `sip:${this.realm};transport=${this.transport}`,
      this.uri(),
      extra,
      "",
      this.callIdReg,
    );
    // On the 200, read our binding back from the Contact line carrying our instance uuid: the
    // pub-gruu AND the expiry the registrar actually granted (which drives the refresh cadence).
    if (res && res.status === 200) {
      const line = (res.headers["_raw"] || "")
        .split("\r\n")
        .find((l) => /^contact:/i.test(l) && l.includes(uuid));
      // Granted lifetime: prefer `expires=` on OUR Contact binding, else the top-level `Expires`
      // header, else the value we requested (Flexisip echoes one of the first two).
      let granted = expires;
      const cexp = line && /;\s*expires=(\d+)/i.exec(line);
      const hexp = (res.headers["expires"] || "").trim();
      if (cexp) granted = parseInt(cexp[1], 10);
      else if (/^\d+$/.test(hexp)) granted = parseInt(hexp, 10);
      this.grantedExpires = granted;
      this.lastRegisterMs = Date.now();
      // DIAGNOSTIC: is OUR binding still in the registrar's response? On the synthesized 58A place
      // the opendoor helper registers this SAME account on its own connection; if its +sip.instance
      // collides with ours it would REPLACE our binding (killing doorbell + door commands) rather
      // than add one. A "MISSING" here after the helper spawns is the smoking gun for that.
      log.debug(
        `our binding ${line ? "present" : "MISSING"} in the REGISTER 200 response`,
      );
      // Census of the OTHER bindings on this account (ours excluded by its instance uuid). A CallMe
      // account is shared, so this is where a call-forwarding device shows itself even when the HTTP
      // API lists no devices at all.
      this.otherBindings = (res.headers["_raw"] || "")
        .split("\r\n")
        .filter((l) => /^contact:/i.test(l) && !l.includes(uuid))
        .map((l) => ({
          contact: /<([^>]+)>/.exec(l)?.[1] || "",
          instanceId:
            /\+sip\.instance="?<?urn:uuid:([^">]+)>?"?/.exec(l)?.[1] || "",
          push: /pn-provider=|pn-prid=/i.test(l),
        }));
      const m = line && /pub-gruu="([^"]+)"/.exec(line);
      if (m) this.pubGruu = m[1];
      log.info(
        `registered (granted expires ${granted}s)${this.pubGruu ? `, pub-gruu ${this.pubGruu}` : ""}`,
      );
    }
    return res?.status ?? 0;
  }

  /** True when the registration should be refreshed: half the granted expiry has elapsed since the
   *  last successful REGISTER (or we never registered). Refreshing at half the granted lifetime
   *  leaves ample margin even if Flexisip caps the expiry well below what we asked for. */
  dueForReregister(): boolean {
    if (!this.lastRegisterMs) return true;
    const halfMs = Math.max(60, this.grantedExpires / 2) * 1000;
    return Date.now() - this.lastRegisterMs >= halfMs;
  }

  /** Bindings the registrar reported for this account at the last REGISTER, ours excluded. */
  bindings(): SipBinding[] {
    return this.otherBindings;
  }

  /** Send a CallMe MESSAGE (JSON body); optionally await the reply correlated by body.id. */
  async sendCallme(
    toUri: string,
    bodyObj: any,
    waitReply = true,
    timeoutMs = 15000,
  ): Promise<{ status: number; reply: any }> {
    const id = bodyObj.id as number;
    let replyResolve: ((o: any) => void) | undefined;
    const replyPromise = new Promise<any>((resolve) => {
      replyResolve = resolve;
      this.pendingMsg.set(id, (o) => resolve(o));
    });
    const replyTimer = setTimeout(() => replyResolve?.(null), timeoutMs);

    const payload = JSON.stringify(bodyObj);
    const extra = [`Contact: ${this.contact()}`, "Content-Type: text/plain"];
    const res = await this.request("MESSAGE", toUri, toUri, extra, payload);
    const status = res?.status ?? 0;

    let reply: any = null;
    if (waitReply && status >= 200 && status < 300) {
      reply = await replyPromise;
    }
    clearTimeout(replyTimer);
    this.pendingMsg.delete(id);
    return { status, reply };
  }
}
