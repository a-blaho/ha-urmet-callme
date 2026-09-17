# Changelog

## 1.0.12

- **The per-second audio diagnostic line now carries a timestamp too.** 1.0.11 timestamped the
  helper's log lines but missed two whose format string sat on the following line, and one of them
  was `[atap] audio ~1s: ...` -- the very line you correlate against when chasing delayed or
  dropped camera audio. It was also the last line still going to stderr rather than stdout, so its
  position relative to the timestamped lines was not reliable. (The other missed one is the usage
  text, which correctly stays untimestamped on stderr.)

## 1.0.11

- **The media helper's log lines now carry a timestamp**, and all of them go to one stream. The
  control plane stamps every line it writes and liblinphone stamps its own, but the helper's
  `[recv]`, `[atap]` and `[tap]` lines carried none, so in an add-on log there was no way to tell
  when "audio started", "first keyframe" and "ffmpeg attached" happened relative to each other.
  That ordering is exactly what is needed to diagnose a camera whose audio is delayed or drops out,
  and it could previously only be guessed at from neighbouring liblinphone lines. `[atap]` also used
  to go to stderr while `[recv]` went to stdout, which are buffered separately, so their relative
  order in the log was not even reliable; everything is on stdout now.

## 1.0.10

- **The camera stream ran at half speed, and that is what killed the audio.** Raw Annex-B H.264
  carries no timestamps, so ffmpeg built the timeline from a frame count at an assumed 25 fps while
  the panel actually delivers about 12.5, leaving the media clock advancing at ~0.5x. Two
  consequences: the picture fell further behind real time the longer you watched, and the transcode
  loop consumed the audio FIFO at half the rate the media helper fills it, so the backlog overflowed
  and every buffer was dropped. That is what is heard as the sound dying a few seconds into a call
  while the picture keeps updating. Every frame is now stamped from the wall clock
  (`setpts=RTCTIME`) before the constant-framerate step. `-use_wallclock_as_timestamps 1` is meant
  to do exactly this and does on ffmpeg 8, but is a no-op for raw H.264 on the ffmpeg 6.1 this image
  ships (measured: 0.53x with it, 1.00x with setpts), and unlike declaring a fixed input rate it
  stays correct at whatever rate the panel happens to send (0.99-1.00x at 6, 13 and 25 fps).
  Measured over a 3-minute call on a real panel: 25 fps at 1.00x with no audio dropped at all,
  against audio that previously died after ~9.5 s (1.0.8) or ~53 s (1.0.9).
- The producer now logs its own throughput every 30 s when `log_level: debug` is set (`fps=`,
  `speed=`). That is what identified the bug above: a `speed=` below 1.0x means the stream is
  falling behind real time and something downstream must be discarded to keep up.

## 1.0.9

- **Camera audio went silent a few seconds into every call** (all panel types; present at least as
  far back as 1.0.6). ffmpeg reads each input on its own thread into a queue that is only 8 packets
  deep by default. That was too shallow here: a few seconds in, the demux thread stopped draining
  the media helper's audio FIFO, so every decoded buffer was refused with EAGAIN and dropped. The
  panel's audio was arriving and being decoded correctly the whole time and simply thrown away,
  which is why the picture kept updating while the sound died, and why the stream still *looks*
  healthy: the resampler fills the gap with silence. Both inputs now get a 512-packet queue.
  Measured on a real panel: audio used to stop for good after about 9.5 s, and now streams cleanly
  for about 50 s, after which any drop recovers instead of sticking. ffmpeg diagnosed this itself
  once its output was visible: `Thread message queue blocking; consider raising the
  thread_queue_size option (current value: 8)`.
- **The camera stream no longer uses the removed `-vsync` option.** It had been there since the
  first release and worked only because the image's ffmpeg (6.1) still tolerates the deprecated
  spelling. On ffmpeg 7 or newer the option is gone and the producer dies instantly with
  `Unrecognized option 'vsync'`, so every camera would go black the moment the base image moved.
  It now uses `-fps_mode cfr`, verified accepted on the image's own ffmpeg.
- **Diagnostics for silent-audio reports.** `log_level: debug` now also shows the stream producers'
  own ffmpeg messages (go2rtc forwards an exec producer's stderr only when asked for it), and the
  PCM tap reports when its FIFO stops or resumes being drained, at any log level. The ffmpeg
  warning that identified the bug above was invisible on every installation until this was added.
- The camera re-encode uses `ultrafast` instead of `veryfast`, measured ~1.7x cheaper for the same
  bitrate ceiling.
- `deploy-local.sh` now asks the box which directory it serves local add-ons from. Newer Supervisors
  migrated from `/addons` to `/local_apps` and build only from the latter, so deploying to `/addons`
  reported success, logged `Build ... done`, and silently kept running the previous image.

## 1.0.8

- **Diagnostics for the "video plays but the audio is silent" case.** `log_level: debug` now also
  shows the stream producers' own ffmpeg messages (go2rtc forwards an exec producer's stderr only
  when asked for it), and the PCM tap reports when its FIFO stops or resumes being drained, at any
  log level. Together these say whether ffmpeg is alive, what it is complaining about, and whether
  anything is reading the audio the panel sends.
- **The camera stream no longer uses the removed `-vsync` option.** It has been there since the
  first release and works only because the image's ffmpeg (6.1) still tolerates the deprecated
  spelling. On ffmpeg 7 or newer the option is gone and the producer dies instantly with
  `Unrecognized option 'vsync'`, so every camera would go black the moment the base image moved.
  It now uses `-fps_mode cfr`, verified accepted on the image's own ffmpeg.
- The camera re-encode uses `ultrafast` instead of `veryfast`, measured ~1.7x cheaper for the same
  bitrate ceiling. That is headroom, **not** a fix for the silent-audio report, whose cause is
  still open.

## 1.0.7

- **2Voice camera audio** (the "video works but the sound is silence" report on 2Voice stations).
  Two things were unlike the official app's camera call: the add-on offered audio recvonly, which
  the station answered with sendonly (liblinphone then reported *PausedByRemote* right after
  *Connected*) and never sent audio for, and the station keeps its microphone closed until the
  viewer "opens the audio", which the app does by sending an in-call DTMF `4` (`1`/`2` are door
  and gate, `3` the next camera). The camera call now offers audio sendrecv like the app and sends
  the open-audio digit once the streams are running. Ipercom panels were never affected. This
  mirrors the app's behaviour from its code and has not yet been confirmed on a 2Voice station:
  if your camera is still silent, please open an issue with a `log_level: debug` log of one call.
- **Audio diagnostics.** The negotiated audio/video direction is logged for every camera call, every
  mid-call direction change from the panel is logged, each call ends with an audio RTP packet total
  (0 received = the panel sent nothing), and `log_level: debug` adds a 5-second audio RTP/RTCP
  counter line plus liblinphone's SIP trace.

## 1.0.6

- **Camera switching is now consistent** (Ipercom video). Switching between two cameras used to
  take anywhere from 5 s to never (a 60 s "unavailable" from go2rtc), because the previous call was
  almost never hung up: the hang-up signal to the media helper was sent only once per helper
  lifetime (a Node `ChildProcess.killed` misuse), so the panel kept the old call, put it on hold
  when the next camera's call arrived, and that zombie on-hold call blocked every following camera
  request for minutes. Fixed: the hang-up is sent every time, the control plane waits for the helper
  to confirm the call is really over before placing the next one (the app's BYE → 200 OK → next
  request sequence), the helper declines a second call instead of pausing the live one, and the
  slot bookkeeping no longer lets a re-call of the same camera skip the switch path. Measured on a
  real panel: a switch now shows video in 7–8 s every time (it was 7 s on a good run and 60 s+
  on a bad one).
- **Instant flip-back.** Re-opening a camera within ~10 s of leaving it reuses the still-live call
  (with a keyframe nudge) instead of hanging up and re-calling: video in ~2.5 s instead of ~7 s.
- The go2rtc producer script now `exec`s ffmpeg. go2rtc stops producers with SIGKILL, so the old
  "hang up on exit" step never ran; teardown is the helper's reader-idle timer, as it always was
  in practice, and no orphaned ffmpeg is left behind.
- Switch timing is logged at `info` (BYE round-trip, re-call gap, time to media) for diagnosis.
- **Earlier picture on a cold open / switch.** The media helper's black priming stream (which lets
  ffmpeg and go2rtc set up the track before the panel's first keyframe) could not start until the
  panel's first packet arrived, which *is* the keyframe, so it bought ~30 ms. The tap now runs as a
  pump filter and primes from the moment the call's media starts, ~2 s earlier.
- **Withheld INVITE is retried once.** When the panel does not send the camera call within 8 s
  (typically the Urmet app briefly holding that camera), the add-on cancels the ringing attempt and
  re-calls once, instead of leaving the viewer black until go2rtc's 60 s producer timeout.
- **Clean shutdown.** Stopping the add-on now waits for the media/door helpers to send their
  in-dialog BYEs (up to 2.5 s) and for the retained MQTT "offline" to be acknowledged before the
  process exits. Previously the exit raced both: entities could stay "available" after a stop, and
  an un-BYE'd camera call stayed busy on the panel until its session timer.

- Camera/door request bodies are now logged at `debug` (the `info` line keeps only the request type
  and gateway).
- Repo: CI on pull requests and pushes (type-check, unit tests, helper compile, version/changelog
  and shellcheck guards), a release-tag/version guard, Dependabot, and the first unit tests.

- **Hardened the embedded go2rtc** - with video on, its API listens on the host network without a
  password (the WebRTC card cannot send one), and a bare go2rtc API lets anyone on the LAN run a
  command inside the add-on (an `exec:`/`echo:` stream). go2rtc now loads only the modules the add-on
  uses, registers only the API paths the card and the stream pages need (no config editor, log,
  restart or exit endpoints), and may only run the add-on's own stream script. Its config is also
  regenerated on every (re)start so a tampered file never survives. The cameras remain viewable
  from the LAN as before; go2rtc's config/log pages are gone from the ingress panel.
- **go2rtc is pinned (1.9.14) and checksum-verified** in the image instead of `latest`, so a
  future go2rtc release cannot silently change behaviour (or drop the hardening keys) in a rebuild.
- **Accounts with several Ipercom places** - entrances are now discovered on **every** Ipercom
  place, not just the first, and each camera call goes to its own place's gateway. Previously a
  second apartment/building got no door buttons, and on a mixed 2Voice + Ipercom account video
  could try to resolve a gateway on the 2Voice place and fail. A place whose gateway is unreachable
  is skipped with an error instead of blocking the others.

## 1.0.5

- **Stable SIP instance id for the liblinphone helpers** - liblinphone was inventing a new
  `+sip.instance` UUID on every start (its config lives in `/tmp` and is wiped with the container),
  so each restart *added* a registrar binding instead of replacing ours. Dead contacts lingered for
  the full expiry and Flexisip forked incoming calls to all of them. Both the 2Voice door helper
  (`opendoor`) and, with video on, the media receiver (`recv`) now get a deterministic UUID derived
  from the account, like the Node SIP client already does - and the two use distinct ids so the door
  and video helpers on a shared 2Voice account never displace each other's binding.
- **No more fatal `sipdata HTTP 302` on start** - right after a (re)install the SIP-data fetch could
  redirect before the login session settled, and the add-on treated it as fatal. It now re-logs in
  and retries a couple of times, so it rides out the transient case instead of needing a restart.

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
