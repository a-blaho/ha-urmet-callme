import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { callerName, SipClient, SipSocket, uriUser } from "./sipClient.js";
import { stableUuid } from "./util.js";

test("callerName formats display name + uri", () => {
  assert.equal(
    callerName('"Panel 1" <sip:cfw_abc@sip.urmet.com>;tag=1'),
    "Panel 1 (sip:cfw_abc@sip.urmet.com)",
  );
  assert.equal(callerName("<sip:x@h>"), "sip:x@h");
  assert.equal(callerName("sip:x@h"), "sip:x@h");
});

test("uriUser extracts the user part, ignoring params", () => {
  assert.equal(uriUser('"Panel" <sip:00_1E_E0_03_38_F8@sip.urmet.com;transport=tls>'), "00_1E_E0_03_38_F8");
  assert.equal(uriUser("<SIP:abc@h>"), "abc");
  assert.equal(uriUser("nonsense"), "");
});

/** An in-memory stand-in for the TLS socket: records what the client writes, lets the test push
 *  inbound bytes, and parses the client's requests so a reply can echo their Via branch. */
class FakeSocket extends EventEmitter implements SipSocket {
  destroyed = false;
  localAddress = "10.0.0.2";
  localPort = 40000;
  written: string[] = [];
  write(d: string | Buffer) {
    this.written.push(d.toString());
    return true;
  }
  destroy() {
    this.destroyed = true;
    this.emit("close");
  }
  setTimeout() {}
  /** The last SIP request written (keepalive CRLFs skipped), split into start line + headers. */
  lastRequest(): { start: string; headers: Record<string, string>; body: string } {
    const raw = [...this.written].reverse().find((w) => !/^\r\n\r\n$/.test(w))!;
    const [head, body = ""] = raw.split("\r\n\r\n");
    const [start, ...lines] = head.split("\r\n");
    const headers: Record<string, string> = {};
    for (const l of lines) {
      const i = l.indexOf(":");
      headers[l.slice(0, i).toLowerCase()] = l.slice(i + 1).trim();
    }
    return { start, headers, body };
  }
  /** Feed a response to the last request, echoing its Via (with Flexisip's NAT annotations). */
  reply(status: number, reason: string, extra: string[] = [], body = "") {
    const req = this.lastRequest();
    const via = req.headers["via"] + ";received=203.0.113.9;rport=51000";
    const msg =
      [
        `SIP/2.0 ${status} ${reason}`,
        `Via: ${via}`,
        `From: ${req.headers["from"]}`,
        `To: ${req.headers["to"]};tag=srv`,
        `Call-ID: ${req.headers["call-id"]}`,
        `CSeq: ${req.headers["cseq"]}`,
        ...extra,
        `Content-Length: ${Buffer.byteLength(body)}`,
      ].join("\r\n") +
      "\r\n\r\n" +
      body;
    this.emit("data", Buffer.from(msg));
  }
  /** Feed an inbound request (MESSAGE / INVITE / CANCEL) from the proxy. */
  request(method: string, callId: string, extra: string[] = [], body = "") {
    const msg =
      [
        `${method} sip:chan@10.0.0.2:40000 SIP/2.0`,
        `Via: SIP/2.0/TLS 198.51.100.1:5061;branch=z9hG4bK-proxy-${method}`,
        `Record-Route: <sip:198.51.100.1:5061;transport=tls;lr>`,
        `From: "Panel" <sip:1.2_@sip.urmet.com>;tag=p1`,
        `To: <sip:chan@sip.urmet.com>`,
        `Call-ID: ${callId}`,
        `CSeq: 1 ${method}`,
        ...extra,
        `Content-Length: ${Buffer.byteLength(body)}`,
      ].join("\r\n") +
      "\r\n\r\n" +
      body;
    this.emit("data", Buffer.from(msg));
  }
}

async function connected() {
  const sock = new FakeSocket();
  const sip = new SipClient("sip.urmet.com", 5061, "chan", "pw", "sip.urmet.com", "tls", (_h, _p, onConnect) => {
    setImmediate(onConnect);
    return sock;
  });
  await sip.connect();
  return { sock, sip };
}

test("REGISTER carries the stable instance id, answers the 407 with a digest, learns the public mapping and the granted expiry", async () => {
  const { sock, sip } = await connected();
  const uuid = stableUuid("urmet-callme:chan");
  const reg = sip.register(3600);
  await new Promise((r) => setImmediate(r));
  let req = sock.lastRequest();
  assert.equal(req.start, "REGISTER sip:sip.urmet.com;transport=tls SIP/2.0");
  assert.match(req.headers["contact"], new RegExp(`^<sip:chan@10\\.0\\.0\\.2:40000;transport=tls>;\\+sip\\.instance="<urn:uuid:${uuid}>";reg-id=1$`));
  assert.equal(req.headers["expires"], "3600");
  assert.equal(req.headers["user-agent"], "UrmetCallForwarding-Android");
  // Flexisip challenges every request, even on the registered connection.
  sock.reply(407, "Proxy Authentication Required", [
    'Proxy-Authenticate: Digest realm="sip.urmet.com", nonce="abc", qop="auth", algorithm=MD5',
  ]);
  await new Promise((r) => setImmediate(r));
  req = sock.lastRequest();
  assert.equal(req.start, "REGISTER sip:sip.urmet.com;transport=tls SIP/2.0");
  assert.match(req.headers["proxy-authorization"], /^Digest username="chan", realm="sip\.urmet\.com", nonce="abc", uri="sip:sip\.urmet\.com;transport=tls", response="[0-9a-f]{32}", algorithm=MD5, qop=auth, nc=00000001, cnonce="[0-9a-f]+"$/);
  // The 200 lists every binding on the account: ours (capped to 600 s) plus a phone with push params
  // and a wired call-forwarding device whose instance node is its MAC.
  sock.reply(200, "OK", [
    `Contact: <sip:chan@203.0.113.9:51000;transport=tls>;+sip.instance="<urn:uuid:${uuid}>";expires=600`,
    `Contact: <sip:chan@1.2.3.4:5060;pn-provider=fcm;pn-prid=x>;+sip.instance="<urn:uuid:11111111-2222-3333-4444-555555555555>";expires=3600`,
    `Contact: <sip:chan@5.6.7.8:5060>;+sip.instance="<urn:uuid:aaaaaaaa-bbbb-cccc-dddd-001ee00338f8>";expires=3600`,
  ]);
  assert.equal(await reg, 200);
  assert.deepEqual(sip.bindings(), [
    { contact: "sip:chan@1.2.3.4:5060;pn-provider=fcm;pn-prid=x", instanceId: "11111111-2222-3333-4444-555555555555", push: true },
    { contact: "sip:chan@5.6.7.8:5060", instanceId: "aaaaaaaa-bbbb-cccc-dddd-001ee00338f8", push: false },
  ]);
  assert.equal(sip.dueForReregister(), false); // just registered; half of 600 s not elapsed
  // Later requests advertise the public mapping Flexisip reported, not the LAN address.
  const send = sip.sendCallme("sip:gw@sip.urmet.com", { id: 1, type: "x" }, false);
  await new Promise((r) => setImmediate(r));
  req = sock.lastRequest();
  assert.equal(req.start, "MESSAGE sip:gw@sip.urmet.com SIP/2.0");
  assert.equal(req.headers["contact"], "<sip:chan@203.0.113.9:51000;transport=tls>");
  assert.equal(req.headers["content-type"], "text/plain");
  assert.equal(req.body, '{"id":1,"type":"x"}');
  sock.reply(202, "Accepted");
  assert.equal((await send).status, 202);
});

test("a MESSAGE reply is correlated by body id, inbound MESSAGEs are acked, keepalives are skipped", async () => {
  const { sock, sip } = await connected();
  const pending = sip.sendCallme("sip:gw@sip.urmet.com", { id: 42, type: "open_door_req" }, true, 1000);
  await new Promise((r) => setImmediate(r));
  sock.reply(202, "Accepted");
  // Keepalive CRLFs from the proxy, then the gateway's reply as a separate inbound MESSAGE (plus an
  // unrelated one that must not resolve ours).
  sock.emit("data", Buffer.from("\r\n\r\n"));
  sock.request("MESSAGE", "m1", ["Content-Type: text/plain"], JSON.stringify({ id: 7, type: "noise" }));
  sock.request("MESSAGE", "m2", ["Content-Type: text/plain"], JSON.stringify({ id: 42, type: "open_door_resp", result: 0 }));
  const { status, reply } = await pending;
  assert.equal(status, 202);
  assert.deepEqual(reply, { id: 42, type: "open_door_resp", result: 0 });
  // Both inbound MESSAGEs were answered 200 on the same connection, echoing Via + Record-Route.
  const acks = sock.written.filter((w) => w.startsWith("SIP/2.0 200 OK"));
  assert.equal(acks.length, 2);
  assert.match(acks[0], /Via: SIP\/2.0\/TLS 198\.51\.100\.1:5061;branch=z9hG4bK-proxy-MESSAGE/);
  assert.match(acks[0], /Record-Route: <sip:198\.51\.100\.1:5061;transport=tls;lr>/);
  assert.match(acks[0], /Call-ID: m1/);
});

test("an inbound INVITE rings (100 + 180), fires onInvite, and is released 487 on CANCEL", async () => {
  const { sock, sip } = await connected();
  const rings: { from: string; callId: string }[] = [];
  sip.onInvite = ({ headers, callId }) => rings.push({ from: headers["from"], callId });
  sock.request("INVITE", "c1", ["Content-Type: application/sdp"], "v=0\r\n");
  assert.deepEqual(rings, [{ from: '"Panel" <sip:1.2_@sip.urmet.com>;tag=p1', callId: "c1" }]);
  const sent = sock.written.filter((w) => w.startsWith("SIP/2.0"));
  assert.match(sent[0], /^SIP\/2.0 100 Trying/);
  assert.match(sent[1], /^SIP\/2.0 180 Ringing/);
  assert.match(sent[1], /To: <sip:chan@sip\.urmet\.com>;tag=\w+/); // we add a To tag on the 180
  assert.equal(sent.length, 2); // never a 200: no media stack here
  sock.request("CANCEL", "c1");
  const after = sock.written.filter((w) => w.startsWith("SIP/2.0")).slice(2);
  assert.match(after[0], /^SIP\/2.0 200 OK/); // to the CANCEL
  assert.match(after[1], /^SIP\/2.0 487 Request Terminated/); // to the INVITE, same To tag
  assert.match(after[1], /CSeq: 1 INVITE/);
});

test("alive() is a pure probe and keepalive() writes the CRLF only while alive", async () => {
  const { sock, sip } = await connected();
  assert.equal(sip.alive(), true);
  sip.keepalive();
  assert.deepEqual(sock.written, ["\r\n\r\n"]);
  sock.destroy(); // the remote closed the connection
  assert.equal(sip.alive(), false);
  sip.keepalive();
  assert.equal(sock.written.length, 1); // nothing written to a dead socket
  assert.equal(sip.dueForReregister(), true); // never registered on this client
});
