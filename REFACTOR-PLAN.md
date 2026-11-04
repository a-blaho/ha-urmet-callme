# Cleanup / refactor plan (analysis of 2026-11-04)

Scope: `urmet_callme/src` (~4,300 lines TS, 17 modules), `video-recv/` (recv.c 1,211 + opendoor.c 1,141
+ two shared headers ~500), `stream.sh`, and the decompiled CallMe 4.5.4 app as the behavioural
reference. Typecheck and the 25 unit tests pass on `main` (c0c1718).

## 0. The reference problem: we mirror the legacy app

The only decompiled app is **CallMe 4.5.4**. Its own code gates every 2Voice cloud feature on
`Build.VERSION.SDK_INT < 26` (`UCFCustoms.areTwoVoiceCloudDevicesSupported`), **skips every `1060`
(Ipercom) device**, and on Android 8+ tells the user to install **CallMe Five** (`com.urmet.callmefive`,
the "Uin" app). That app sat undecompiled in the sibling repo (now decompiled, see the update below).

**Update 2026-11-04 (later the same day): the Uin app is now decompiled** at
`reverse-engineering/callme/callme-five-2.3.0/` and compared call site by call site in
`reverse-engineering/PROTOCOL-UIN.md (git-ignored)`. Its SDK (`com.urmet.callmesdk`) is the one the
class names in `PROTOCOL.md` already refer to, so the Ipercom notes there were source-backed all along;
only the 2Voice notes were 4.5.4-derived. The table below is corrected against Uin.

## 1. Behaviour divergences (ranked, against the Uin app; 4.5.4 noted where it differed)

| # | Add-on | Uin 2.3.0 | Verdict |
|---|---|---|---|
| 1 | `familyOf`: `1060`, `1083/83`, `1760/*`, `*/58*`; else dropped | strict model enum; `Model.UNKNOWN` places are dropped too (`PlaceData.toPlace` returns null) | **Same.** The "default to 2Voice" rule was 4.5.4 only. Withdrawn |
| 2 | Camera call held as long as a reader drains the FIFO (no cap) | `setInCallTimeout(120)`, `setIncTimeout(60)`, one call at a time | Add a 120 s per-call cap in recv (re-call transparently if a viewer is still there) |
| 3 | opendoor waits 20 s for media; recv 12 s for a keyframe | no app-level no-media timer; only the 120 s cap and a 25 s camera-swap watchdog | Keep 20 s / 12 s; no change needed |
| 4 | Door/gate tone sent on an **answered ring** call (1.0.20) | `EXECUTE_ACTION` is handled only in `CallActive` states: a door tone goes out on any **established** call, incoming included (UI shows the slider for CALLINGSTATION/SWITCHBOARD/UNKNOWN callers), never on a ringing or early-media call | **Same.** Keep 1.0.20. The 4.5.4 suppression rule does not exist in Uin |
| 5 | `create_sip_account_no_mail_confirm/{user}/{realm}/{pass}`, empty POST | identical (`CreateSipAccountService.java:470`) | **Same.** Withdrawn |
| 6 | Unique account recreated within 7 days of expiry | recreated only once expired | Harmless margin; leave |
| 7 | `flags` ignored | bit 0 `MAIN_POWER_SUPPLY_DOWN` → place UNAVAILABLE, calls stripped | Log/mark such places |
| 8 | **2Voice door = call + DTMF only** | on 1760 firmware ≥ 1.5.0-13 (GROUP_1760_16) / 5.0.0-4 (GROUP_1760_31) the place gets `SUPPORTS_DOORS_REQUESTS`: `residentDoors` via `configuration_read_req` and **`open_door_req` as a MESSAGE to the OUT account**, no call | **New.** A call-less, instant 2Voice unlock may exist. Probe: `get_fw_upgrade_status_req` → `fw_version`, then `configuration_read_req residentDoors` to the OUT account. Hardware test needed |
| 9 | 2Voice camera/door INVITE: to the OUT account, header `auto_insertion: true` (or `mac:` for phase-B) | INVITE to the device's `sip_destination` from `get_available_devices_req`, headers `Subject: {"type":"autoins",…}` **and** `mac: <cloud Mac_Address>` for every 2Voice place; **no `auto_insertion` header anywhere** | Differs in form; ours is proven on a 1760/16. Optional: query devices on 2Voice and add the `Subject`+`mac` headers like Uin, behind a test |
| 10 | Next camera re-dials after open-audio | Uin keeps sending `3`; the arrows never depend on audio | Add-on-only workaround for the tested station; keep, document |
| 11 | DTMF `use_info=1, use_rfc2833=0` | `use_info=1` **and** `use_rfc2833=1` | Harmless; leave |
| 12 | UA `UrmetCallForwarding-Node` (sipClient) vs `-Android` (helpers) | `UrmetCallForwarding-Android` + versionCode | Unify to one constant |
| 13 | `response_uri` = instance `cfw…` account | `cfwunique_` account for every MESSAGE | Known, working; leave |

Matches confirmed against Uin source: DTMF digits 1/2/3/4, early-media gating (remote video SendOnly or
SendRecv, once per ring, never automatic), 2Voice next camera = live `3` with a 3 s debounce, open audio =
`4` on 2Voice and a re-INVITE on Ipercom, Ipercom split-account `call_device_req` with
`uri_to_call = response_uri`, teardown = BYE with `cancel_call_req` only before a dialog exists, Ipercom
switch = BYE then re-request, `residentDoors` double-decoded JSON, `open_door_req` body, token
`sha1(ts$pw)`, UrmetCrypto key, cookie login, `get_my_devices` fields and the `"*"` placeholder, 486 for a
second INVITE, one call at a time.

## 2. Structural findings (add-on)

Measured:
- recv.c has **44** file-scope globals, opendoor.c **25**; **113** identical non-comment lines between them.
- **24** env knobs read by the helpers; stdin alphabet `1 2 A H N T V W` split across two binaries;
  stdout machine lines `RESULT`, `RING held|gone`, `CAMERA ok|fail|end` parsed by regex in two TS files.
- `index.ts main()` is 290 lines; 12 of them are the eight cross-callbacks that make
  `TwoVoiceService` and `TwoVoiceVideoService` share one station call.
- `/tmp/urmet_cam_<i>.h264|.pcm` is spelled in `video.ts`, `video2voice.ts` and `stream.sh`.
- `deterministicUuid` (video.ts) duplicates `stableUuid` (util.ts).
- mqtt.ts: 11 `publish(...config)` blocks and 6 command maps that differ only in uid suffix/icon/payload.
- Tests cover pure helpers only. Untested: SIP stream parsing and REGISTER-census parsing, helper
  stdout protocol, the Ipercom slot machine, MQTT command routing, every C file.

### The core problem: two liblinphone helpers for one 2Voice call
On 2Voice the camera call **is** the door call. Today two processes per place (`opendoor`, `recv` in
outgoing mode) register the same channel account under different instance ids, and all the collision
avoidance lives in Node callbacks: release-before-call, ring held by one and shown by the other
(`V` command + FIFO handoff), tones routed to whichever holds the call, "ready" no-op while the camera
is up. The helpers have converged anyway: both tap H.264 (`h264tap.h`), both send DTMF, both handle
rings, both read stdin commands, both play announcements (`talkout.h`). The app itself runs
`max_calls=1` on one core.

**Proposal: one `station` helper per 2Voice place** (opendoor.c + recv.c outgoing mode), owning the
single call to the station and serving one command set: `door`, `gate`, `next`, `audio`, `warm`,
`release`, `talk`, `camera <h264> <pcm>`, `hangup`. It answers every command with a tagged line.
`recv.c` shrinks back to the Ipercom inbound receiver. `door2voice.ts` + `video2voice.ts` collapse into
one `TwoVoiceStation` service; the eight callbacks in `index.ts` disappear.

### Other structure
- **callme.ts** mixes cloud login, SIP session, Ipercom gateway queries, camera-call requests, doorbell
  listeners, and phase-B station discovery (introduction/census/ring). Split into `Session`
  (cloud+instance SIP), `IpercomGateway`, `DoorbellListeners`, `StationDiscovery`.
- **video.ts** tracks one call with 9 state fields (`slotHolder`, `displacedAt`, `streaming`,
  `connected`, `liveCall`, `endWaiters`, `placedAt`, `busyTimers`, `retried`). Replace with an explicit
  per-call state (`idle | requested | ringing | live | ending`) plus one timer. Hardware-verified today,
  so do this last and behind the new tests.
- **video.ts / video2voice.ts** share FIFO creation, the control HTTP endpoint, go2rtc supervision,
  `placesServed`, `stop`. Extract a `CameraPipeline`.
- **mqtt.ts**: one `publishEntity(kind, uid, cfg, handler)` with a single `handlers` map.
- **Helper protocol**: define the stdin commands and stdout replies once (a header for C, a TS enum),
  prefix machine lines (`@RESULT ...`) so regexes stop matching free text, and let Node stamp all helper
  lines (today opendoor lines are unstamped and door2voice re-logs them, recv lines are pre-stamped and
  passed through verbatim).
- **Hardcoded `sip.urmet.com:5061`** in both C files while TS uses the cloud-supplied realm. Pass it in.
- One `Cloud` login per start (VideoService logs in a second time just to mint the account).

## 3. Latent bugs found while reading

1. **Reconnect replaces `Place` objects.** `CallMe.connect()` sets `this.places = data.map(...)`;
   `TwoVoiceService`, `TwoVoiceVideoService` and `Announcer` keep the startup objects. Rotated channel
   credentials or a changed OUT account never reach the helpers until an add-on restart (only the
   synthesized place is preserved by reference). Fix: update existing places in place, keyed by id.
2. **A doorbell listener whose first REGISTER fails is dropped forever** (`startDoorbell` `continue`s
   without recording it; `maintainDoorbell` only refreshes recorded listeners).
3. **`SipClient.alive()` has a side effect** (writes the CRLF keepalive); on a dead socket this emits an
   async error logged as "socket error" on every 25 s tick until reconnect. Split probe from keepalive.
4. **recv.c idle path still fires `RECV_HANGUP_URL`** with a comment claiming a BYE alone will not free
   the channel, which the 2026-07-16 capture disproved. video.ts then SIGUSR1s a recv that is already
   terminating. Harmless race, but a second teardown path and a misleading comment.

## 4. Dead / legacy code to delete

- opendoor.c single-shot mode (argv digit); door2voice always sets `OPENDOOR_PERSISTENT=1`.
- opendoor.c non-keep-alive branch (`run_open` / `run_talk`, reachable only via
  `door_open_2voice_keepalive: 0`); fold `0` into `keepalive_loop`.
- recv.c `RECV_SECONDS`, `RECV_H264_OUT`/`RECV_AUDIO_OUT` fallbacks, `TAP_DEFAULT_PATH` (dev spike).
- stream.sh `CALL_PORT` default 8099 (both services always pass `$3`).
- `sipClient.pubGruu` (parsed, only logged).
- mqtt.ts `clearStaleDiscovery` purges 1.0.0-era `lock` / `binary_sensor` / missed-calls topics; keep
  one more release, then drop.
- Stale docs: the sibling repo's `CLAUDE.md` / `PROTOCOL*.md` describe a removed `door_open_2voice`
  option, missing files (`INSTALL-local.md`, `INTEGRATION.md`, `video-recv/Dockerfile`), and "Phase 1
  door only". This repo has **no** `CLAUDE.md`; the architecture notes should live here (minus Urmet IP).

## 5. Suggested order

**Phase 1, safe (no behaviour change; one PR) — DONE on branch `refactor/phase-1` (2026-11-04):**
bugs 1-3 fixed (bug 4's stale comment corrected, the idle ping kept for the slot bookkeeping),
section 4 dead code removed (`clearStaleDiscovery` kept), `stableUuid` deduped, `camFifos` is the one
FIFO-path source (stream.sh takes them as `$4`/`$5`), `SIP_USER_AGENT` constant, `publishEntity` in
mqtt.ts, `cameraPipeline.ts` (FIFOs + control endpoint), `helperProtocol.ts` (command alphabet +
line parser), tests for `SipClient` (fake socket: REGISTER/407/census, MESSAGE correlation, INVITE
ring/CANCEL), the helper protocol and the MQTT bridge, and this repo's `CLAUDE.md`. Not yet verified
on the Green.

**Phase 2, protocol-neutral merge — DONE on `refactor/phase-1` (2026-11-04):** `video-recv/station.c`
(opendoor.c + recv.c's outgoing mode: one process per 2Voice place owns the station call; door, camera,
ring, announcements, next camera on it), `recv.c` slimmed to the Ipercom receiver, `lpcommon.h` (core
setup, PCM tap card, silence/talk source, keyframe INFO), `src/twoVoiceStation.ts` replacing
`door2voice.ts` + `video2voice.ts`, the eight cross-callbacks in `index.ts` gone, `announce.ts`
simplified (no camera take-over replay). The helper line protocol is unchanged apart from the added
`CAMERA live` line. Compiled in Docker; **not verified on hardware** (no 2Voice station available to
the maintainer): the first 2Voice user report after release is the test.

**Phase 3, behaviour (Uin decompiled; see `PROTOCOL-UIN.md` in the sibling repo):** 120 s call cap,
channel `flags`, UA constant; then two hardware-gated experiments on a 1760: the call-less
`open_door_req` door path (item 8) and the Uin-style `Subject`+`mac` INVITE headers (item 9).
