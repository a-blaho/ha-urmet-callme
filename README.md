# Urmet CallMe for Home Assistant (Unofficial)

A Home Assistant **add-on** that connects your Urmet **CallMe** intercom to Home Assistant: unlock
doors and gates, get doorbell-ring events, and optionally stream the entrance cameras. It signs in to
the Urmet cloud with your CallMe app credentials, **auto-discovers your entrances**, and exposes each
one as a Home Assistant entity over MQTT.

[![Add repository to your Home Assistant](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Fa-blaho%2Fha-urmet-callme)

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
![Supports aarch64, amd64](https://img.shields.io/badge/architecture-aarch64%20%7C%20amd64-informational)

> **Independent community project. Not affiliated with, endorsed by, or supported by Urmet.**
> "Urmet" and "CallMe" are trademarks of their respective owners, used here only to identify
> compatible hardware. This project does not use Urmet's logo or product imagery. It is for
> personal interoperability with your own account and hardware. Use at your own risk; no warranty.

## Features

- **Door and gate unlock.** Your entrances are discovered automatically and exposed as `button`
  entities (a door and, where fitted, a gate per entrance). A press releases the latch momentarily
  (a buzz-open); there is no locked/unlocked state to read back, so it is a stateless button rather
  than a lock.
- **Doorbell events.** Each panel gets a `device_class: doorbell` **event** entity that fires when
  the panel rings, so automations can react (notify, turn on a camera, run a scene). Requires the
  indoor monitor set to "remote" (see the add-on docs). Notification only - the add-on never answers.
- **Entrance camera streaming (optional).** One-way live video and audio from the cameras into Home
  Assistant, viewed with the WebRTC Camera card, with a "hang up" button per camera place. Off by
  default; enable with `video: true`.
- **2Voice support.** Non-Ipercom 2Voice systems open the door a different way (an in-call tone);
  when a 2Voice system is detected, door/gate unlock and a "ready" pre-warm button appear
  automatically - no option to set. With video on, door and gate work on the live camera call.
- **Camera panel.** When video is enabled, a page in the Home Assistant sidebar (via ingress) shows
  the live camera view. With video off it is blank - entity states and the add-on log report status.
- **Local MQTT, cloud control.** Entities are published via Home Assistant's MQTT discovery; the door
  and doorbell commands travel over Urmet's own cloud/SIP path, the same one the app uses.

## Requirements

- A working **Urmet CallMe** setup: the official CallMe app installed, set up, and connected to your
  intercom, with an account you can sign in with. This add-on rides on that same account - get the
  app working first. See the [add-on documentation](urmet_callme/DOCS.md) for which app matches your
  model (Ipercom vs 2Voice).
- The **Mosquitto (MQTT)** add-on, so the entities can be published.

## Install

1. Click the **Add repository** badge above (or **Settings → Add-ons → Add-on Store → ⋮ → Repositories**
   and paste this repo's URL).
2. Find **Urmet CallMe (Unofficial)** in the store and **Install**.
3. Set your Urmet **email** and **password** in the add-on options and **Start**.

Full setup, all options, the camera card configuration, and 2Voice details are in the
[add-on documentation](urmet_callme/DOCS.md).

## Layout

```
urmet_callme/        the Home Assistant add-on (this is the whole product)
  src/               TypeScript source
  config.yaml        add-on manifest
  Dockerfile         image build
  DOCS.md            add-on documentation
  CHANGELOG.md       version history
repository.yaml      HA add-on repository descriptor
LICENSE              GPLv3
```

## Development

```bash
cd urmet_callme && npm ci
npm run typecheck   # tsc over src/ including the tests
npm test            # node:test unit tests (src/**/*.test.ts, not shipped in the image)
npm run build       # dist/ as the image builds it
```

CI (`.github/workflows/ci.yml`) runs those plus a compile of the two liblinphone helpers on Ubuntu
24.04, a config.yaml/package.json/CHANGELOG version check and shellcheck, on every pull request and
push to `main`. Images are built and pushed only by a `v<version>` tag (`builder.yml`), which must
match `config.yaml`. To try a change on your own Home Assistant first, see `urmet_callme/deploy-local.sh`.

## License

This project is licensed **GPL-3.0-or-later** (see [LICENSE](LICENSE)) - the video path links
liblinphone (GPLv3), so the whole work is distributed under the GPL. It does not include, and
grants no rights to, Urmet's application or intellectual property.

### Third-party components (bundled in the built image)

The container image installs these unmodified from the distribution / upstream at build time; their
source is available from the upstreams below (and, for the Ubuntu packages, from Ubuntu's source
mirrors):

- **liblinphone / mediastreamer2 / ortp / belle-sip / bctoolbox** - GPLv3 - https://gitlab.linphone.org/BC/public
- **FFmpeg** (built with **libx264**) - GPL (x264 is GPLv2+) - https://ffmpeg.org · https://www.videolan.org/developers/x264.html
- **openh264** (Cisco) - BSD-2-Clause + patent grant - https://github.com/cisco/openh264
- **go2rtc** - MIT - https://github.com/AlexxIT/go2rtc
- **Node.js** and the npm dependencies in `urmet_callme/package.json`, plus the base image and its
  packages - under their respective licenses

For the GPL components the "corresponding source" is the unmodified upstream/distribution source
linked above. This README also serves as a **written offer**, valid for three years from
distribution, to provide that corresponding source on request.
