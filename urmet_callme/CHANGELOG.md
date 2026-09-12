# Changelog

## Unreleased

- **Stable SIP instance id for the 2Voice door helper** - liblinphone was inventing a new
  `+sip.instance` UUID on every start (its config lives in `/tmp` and is wiped with the container),
  so each restart *added* a registrar binding instead of replacing ours. Dead contacts lingered for
  the full expiry and Flexisip forked incoming calls to all of them. The helper now gets a
  deterministic UUID derived from the account and place, like the Node SIP client already does.

## 1.0.4

- **Phase-B door-open is audio-only** - 1083/58A-family stations (the `mac` header path) accept an
  audio-only unlock INVITE, so the persistent helper no longer builds an H.264 graph that is discarded
  anyway. This markedly lowers memory use on small hosts (it was OOM-killing the add-on on a 1 GB
  Raspberry Pi 3). Cloud-listed 2Voice keeps the video offer (`auto_insertion`); some of those panels
  403 audio-only.
- **Clean shutdowns are logged** - SIGTERM/SIGINT now print the signal, so a stop requested by
  Supervisor is distinguishable from a crash in the log.
- **Audio-level diagnostics for the camera stream** (`log_level: debug`) - the PCM tap now logs a
  once-per-second line with the buffer count, average/peak sample level, bytes written and dropped
  count, to pin down one-way-audio issues (silent input from the panel vs. audio not reaching go2rtc).

## 1.0.3

- **2Voice video on the 1083/58A family (experimental)** - the 2Voice video call now dials with the
  `mac` header, like door-open, so phase-B stations that reject `auto_insertion` (486 Busy) can stream.
  The panel sends its H.264 on that same call. Video remains off by default (`video: true` to enable).
- **Device discovery + real names for 1083/58A devices** - on start the add-on now asks the shared
  account for an introduction (the same request the app sends), and the device answers with its MAC
  and a human name. That names the place properly and gives its station account directly, rather than
  only inferring it from the SIP registration census (which stays as a fallback).
- **Cloud-listed 2Voice camera calls** now send no `auto_insertion` header, matching the app's camera
  call (`auto_insertion` is the door-open path only). Phase-B keeps the `mac` header.

## 1.0.2

- **2Voice CallMe call-forwarding devices (1083/58A family)** - accounts whose cloud device list is
  empty now get a 2Voice place built from the instance SIP account. The station is taken from the SIP
  registration census and persisted, and door/gate open uses the `mac` header those devices require.
  Cloud-listed Ipercom and 2Voice systems keep the existing `auto_insertion` / `open_door_req` paths.
- **More diagnostics on this path** (visible with `log_level: debug`) - the SIP binding census, where
  a station was learned (census / ring / disk) and whether its account is MAC-shaped, which door-open
  header goes out (`mac` vs `auto_insertion`), and the SIP status a station returns on rejection - so
  the new-device path can be verified from a log.

## 1.0.1

- **Fix camera video on some systems** - the image is back on Ubuntu 24.04. The 1.0.0 image moved to
  Debian, whose newer mediastreamer stack broke the video tap (the camera call connected but no frames
  reached go2rtc). Door-open/doorbell were unaffected.
- **Better diagnostics for unsupported models** - when an account returns no entrances, the log now
  shows the (secret-masked) shape of the cloud device response, so new models can be added.

## 1.0.0

Initial public release.

- **Door and gate unlock** for Ipercom panels - entrances are auto-discovered and exposed as Home
  Assistant `button` entities over MQTT (a press is a momentary strike release).
- **Doorbell events** - a `device_class: doorbell` event entity per panel that fires when it rings
  (requires the indoor monitor set to "remote").
- **2Voice support** - for non-Ipercom 2Voice systems, door/gate unlock plus a "ready" pre-warm
  button for an instant open, enabled automatically when a 2Voice system is detected.
- **Video (optional)** - one-way live video and audio from the entrance cameras, via an embedded
  liblinphone receiver + go2rtc, viewed with the WebRTC Camera card. One camera at a time.
- **Camera panel** in the Home Assistant sidebar (via ingress): the live go2rtc camera view when
  video is enabled; blank otherwise.
