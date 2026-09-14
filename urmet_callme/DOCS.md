# Urmet CallMe (Unofficial) - Home Assistant Add-on

Unlock Urmet **CallMe** (Ipercom) doors from Home Assistant, get doorbell-ring events, and
(optionally) stream the entrance cameras. It logs into the Urmet cloud with your app credentials,
**auto-discovers your entrances**, and exposes each door/gate as a Home Assistant `button` entity
via MQTT. Door-open + doorbell are pure TypeScript/Node; the optional **video** feature embeds
liblinphone + go2rtc (see below).

## Install (custom repository)

1. **Settings → Add-ons → Add-on Store → ⋮ (top-right) → Repositories** - paste this repo's URL and
   **Add**.
2. Find **Urmet CallMe (Unofficial)** in the store and **Install**. The first build takes a while (it
   pulls in liblinphone + ffmpeg + go2rtc); later updates are fast.
3. **Configuration** → set your `email` / `password` → **Start**. Needs the **Mosquitto broker**
   add-on (auto-detected) to publish entities.

(For local development you can instead push the `urmet_callme/` folder onto HA's local add-ons - see
`deploy-local.sh` - but end users install via the custom repository above.)

Your entrances appear automatically as `button` entities (one per door/gate, named from your own devices). The hardware is a momentary door strike with no state feedback, so pressing a button just pulses the relay open (buzzes the door). There's no locked/unlocked state to show - the door re-latches on its own - which is why it's a stateless button rather than a lock.

### Doorbell (event entity)

Each entrance/panel gets its own **doorbell `event` entity** (`device_class: doorbell`, named from your own devices - one _"… doorbell"_ per entrance) that fires a **`ring`** event when **that** panel rings - routed to the correct door by its topological code, so an automation can open the matching camera. The event's attributes include `caller`, `topological_code`, and `matched`. Each ring is recorded in the HA logbook; automations trigger on the event.

**Important - this only works when your indoor monitor is set to "remote".** The panel forwards the ring to the CallMe account only in remote mode; in home mode it rings locally and nothing reaches the add-on (or the app). Set the monitor to remote for HA to receive doorbell rings.

The add-on never answers the doorbell call for the ring notification (no media needed), so your phone is undisturbed. Disable the feature with the `doorbell` option. The camera video stream is a separate, opt-in feature (see **Video** below). Past rings are visible in the doorbell event's history (HA logbook).

### Video (optional, experimental)

Set `video: true` to stream your entrance cameras into HA. The add-on embeds a real SIP/media
engine (liblinphone) plus **go2rtc**, and exposes one stream per camera. Video pulls in the heavier
media stack (liblinphone + ffmpeg + go2rtc), so the first build takes a while on modest hardware.

**View the cameras with the [WebRTC Camera](https://github.com/AlexxIT/WebRTC) card (HACS), not a
Generic Camera.** HA's built-in Generic Camera / `stream` (HLS) worker re-pulls the stream through
its own ffmpeg and can't handle it (it aborts on RTP timestamp discontinuities) - WebRTC via go2rtc
is the path that works.

1. Install **HACS**, then add the **WebRTC Camera** integration (AlexxIT/WebRTC) and restart HA.
2. Add a card (one per camera), pointing it at the **add-on's own go2rtc**:

   ```yaml
   type: custom:webrtc-camera
   url: urmet_cam_0 # and urmet_cam_1, …
   server: http://homeassistant.local:1984 # the add-on's go2rtc (use your API port if you changed it)
   mode: webrtc
   ```

   `mode: webrtc` forces the live path (you'll see "Live Broadcast", not a seek bar). This works both
   on your LAN and remotely (the Home Assistant app routes the card's go2rtc connection through your
   HA connection when you're away, e.g. via Nabu Casa).

   **Already run your own go2rtc add-on?** It owns ports `1984`/`8554`/`8555`, so set
   `go2rtc_api_port` / `go2rtc_rtsp_port` / `go2rtc_webrtc_port` in this add-on's **Configuration**
   options to free ports (e.g. `11984`/`18554`/`18555`) and point the card's `server:` at the API port
   you set. Both go2rtc instances then coexist.

   **Point the card at the add-on's go2rtc (`server: …:1984`), not at HA's built-in go2rtc via a
   `url: rtsp://…:8554` source.** The add-on's go2rtc waits for the video track before answering, so
   the first open comes up cleanly; routing through HA's go2rtc instead was unreliable (intermittent
   black on a fresh open, needing a page refresh). The add-on runs with **host networking** precisely
   so its go2rtc advertises a reachable WebRTC address - without that the media path can't connect and
   you get a black screen ~half the time.

Audio plays after a **one-click unmute** (browser autoplay policy) - telephone quality (8 kHz
G.711 upsampled), enough to hear a visitor. go2rtc's own stream pages at `http://<your-ha-host>:1984`
also play every stream (handy for testing); its config/log/add-stream pages are disabled (see below).

**What is reachable on your LAN.** With video on, the add-on's go2rtc listens on the host network
without a password (the WebRTC card cannot send one), so it is locked down instead: only the
modules and API paths the card and the stream pages need are enabled, the stream list and player
pages work but the config editor, log, restart and exit endpoints do not exist, and the only
program go2rtc is allowed to run is the add-on's own stream script. Anyone on your LAN can still
*watch* the cameras through port `1984`/`8554`, exactly as they could through the card, so keep
the add-on on a trusted network. The API port is not something to forward from the internet.

**Audio works fully on desktop browsers.** On **mobile** (the HA companion app _and_ mobile
browsers), unmuting can freeze the feed and reload it back to muted - a known limitation of the
WebRTC card on mobile ([AlexxIT/WebRTC issues](https://github.com/AlexxIT/WebRTC/issues)), not the
add-on (the same stream unmutes fine on desktop). Video on mobile is reliable; audio on mobile isn't.

**Note on the picture:** each call starts with several seconds of black while the entrance camera
warms up, then the image appears - so give a freshly-opened camera ~10 s. At night the scene may
also simply be dark.

**One camera at a time.** The door system serves **one video call at a time**, so the add-on shows
one camera at a time. Opening a camera takes about 5–6 s to the first picture (the panel's INVITE
plus its keyframe), and switching to the other camera about 6–7 s: the add-on hangs up the current
call, waits for the panel to confirm, and places the next one, the same sequence the official app
uses. Going **back** to a camera you left less than ~10 s ago is faster (~2 s) because the call is
still up and is reused. So:

- If you want **both** cameras, put them on **separate dashboard views/tabs** so only one streams
  at a time. Two always-visible cards aren't recommended - they would keep displacing each other,
  and only one can be live.

The stream includes **one-way audio** (hear the visitor); two-way (talk-back) is not implemented yet.

### Door-open on 2Voice models (experimental)

The default door-open path is for **Ipercom** panels (it sends a cloud command). **2Voice** systems
(model codes `1083/83`, `1083/58*`, `1722/58*`, `9854/58*`, `1760/*`) open the door a different way -
by placing a short call to the door station and sending an "open" tone. The add-on **auto-detects**
your model from the cloud, so 2Voice door-open is enabled automatically for a detected 2Voice system -
there is no option to set (just like Ipercom doors).

Some CallMe call-forwarding devices (the 1083/58A family) are not listed by the cloud device API.
The add-on then builds a 2Voice place from your SIP account, takes the station name from the SIP
registration census, and opens with a `mac` header instead of `auto_insertion`. That unlock call is
audio-only (no H.264) -- those stations accept it, and it is much cheaper on small hosts. Cloud-listed
2Voice systems are unchanged (they still get a video offer; some of those panels reject audio-only).

Any 2Voice entrance on your account appears as a **door `button`**. Pressing it registers your channel
account, places a silent `auto_insertion` call to the station, sends the door tone, and hangs up (this
reuses the embedded liblinphone engine, so it works whether or not `video` is on).

Each 2Voice place gets a **door** button (DTMF `1`) and a **gate** button (DTMF `2`) - use whichever
your installation has wired.

**"… ready" (pre-warm) button.** The very first press after a while is slower (~5 s), because placing
the call to the entrance takes a couple of seconds before the open tone can be sent; presses on an
already-open call are near-instant. Each 2Voice place therefore also gets a **"… ready"** button that
opens the call ahead of time (no tone) and holds it for `door_open_2voice_prewarm_hold` seconds, so a
door/gate press right after is instant. Trigger it from any automation - for example a doorbell ring,
or opening your entry dashboard - so the call is already up when you unlock. If you don't press within
the hold window, the call releases on its own.

**Experimental / what to check:** the call is _meant_ to be silent (it should open the door without
ringing your indoor monitor). If you test this, watch that your monitor stays quiet. Set
`log_level: debug` and the add-on log shows each step (`[opendoor] …`) for troubleshooting.

## Options

| Option                                         | Notes                                                                                                                                          |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `email`, `password`                            | Your Urmet CallMe app login                                                                                                                    |
| `doorbell`                                     | Expose a doorbell `event` entity per panel (default `true`; requires monitor set to "remote")                                                  |
| `video`                                        | Stream entrance cameras via embedded liblinphone + go2rtc (default `false`)                                                                    |
| `door_open_2voice_keepalive`                   | 2Voice: seconds to keep the call open after an unlock so a follow-up (e.g. door → gate) is instant (default `4`; `0` = a fresh call per press) |
| `door_open_2voice_prewarm_hold`                | 2Voice: seconds a **"… ready"** (pre-warm) button press keeps the call open, so a following door/gate press is instant (default `15`)          |
| `mqtt_url` / `mqtt_username` / `mqtt_password` | Optional; omit to use the HA MQTT service automatically                                                                                        |
| `log_level`                                    | `debug` / `info` (default) / `warn` / `error`                                                                                                  |

## Logging

Everything is logged to the add-on log, timestamped and tagged by component
(`[main] [cloud] [callme] [sip] [mqtt] [video]`, plus `[recv]` from the video receiver):

- `info` (default): login, SIP registration, gateway resolution, discovered entrances, every open (which door + result), MQTT connect, reconnects, inbound calls.
- `debug`: full SIP request/response trace, cloud HTTP calls, message bodies - useful for diagnosing. Inbound calls (if the panel ever forwards to this account) log a `[sip] INBOUND CALL: …` line.

Passwords/tokens are redacted.

## How it works

Pure Node SIP-over-TLS over one persistent connection: REGISTER → `get_gateway_sip_address_req` (dynamic gateway) → `configuration_read/residentDoors` (entrances) → `open_door_req`. Door-open needs no media. The connection is reused for all requests (Flexisip only trusts requests on the registered connection).

Video (when enabled) reuses that control plane to place camera calls (`call_device_req`, routed to a single shared dedicated account via the split-account trick - one video call at a time) but hands the actual media to an embedded **liblinphone** receiver - the only stack that makes the panel's relay stream - which taps the H.264 and feeds it to **go2rtc**. A per-camera **ffmpeg** re-encodes the tapped stream to a clean constant-framerate stream (the raw stream is timestamp-less, so a passthrough copy played back at a broken framerate).
