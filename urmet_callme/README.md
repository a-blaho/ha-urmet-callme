# Urmet CallMe (Unofficial) - Home Assistant Add-on

Connect your Urmet **CallMe** intercom to Home Assistant: unlock doors and gates, get doorbell-ring
events, and optionally stream the entrance cameras. The add-on signs in to the Urmet cloud with your
CallMe app credentials, **auto-discovers your entrances**, and exposes each as a Home Assistant
entity over MQTT.

[![Add repository to your Home Assistant](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Fa-blaho%2Fha-urmet-callme)

> **Independent community project. Not affiliated with, endorsed by, or supported by Urmet.**
> "Urmet" and "CallMe" are trademarks of their respective owners, used here only to identify
> compatible hardware. This project does not use Urmet's logo or product imagery. Use at your own
> risk; no warranty.

## Before you start: set up the official CallMe app

This add-on does **not** talk to your intercom directly - it uses the **same Urmet cloud account** the
official CallMe app uses. So the app has to be working first:

1. **Install the official Urmet CallMe app** on a phone and complete its setup so it is **connected to
   your intercom** (paired/registered to your system by you or your installer).
2. **Confirm it works** from the app - you can receive a call from your entrance panel and open the
   door.
3. Use **those same login credentials** (email + password) in this add-on.

If the official app is not set up and connected, the add-on has nothing to sign in to.

### Which app - Ipercom or 2Voice?

Urmet sells two intercom families, and they use **different** CallMe apps:

- **Ipercom** - Urmet's newer IP/digital system. Door-open is sent as a cloud command. This is the
  default path and needs no extra options.
- **2Voice** - Urmet's two-wire bus system (model codes such as `1083/83` and `1760/*`). It opens the
  door a different way - by placing a short call to the entrance and sending an "open" tone.

Install and set up the CallMe app that matches **your** intercom. The add-on **auto-detects** your
family from the cloud and uses the right door-open path - no extra option to set.

## Install

1. Click the **Add repository** badge above (or **Settings → Add-ons → Add-on Store → ⋮ (top-right) →
   Repositories** and paste this repo's URL).
2. Find **Urmet CallMe (Unofficial)** in the store and **Install**.
3. Set your Urmet **email** / **password** in the options and **Start**. Needs the **Mosquitto/MQTT**
   add-on for the entities to appear.

## Features

- **Door / gate unlock** - auto-discovered `button` entities.
- **Doorbell `event` entity** - fires on a panel ring (indoor monitor must be set to "remote").
- **Video (opt-in `video: true`)** - one-way live video + audio via the WebRTC Camera card, plus a
  "hang up" button per camera place to end the call from an automation or dashboard.
- **2Voice door-open** - auto-enabled on 2Voice systems: door/gate unlock plus a "ready" pre-warm
  button for an instant open; with video on, door/gate work on the live camera call.
- **Camera panel** - when video is enabled, a page in the Home Assistant sidebar (via ingress) shows
  the live camera view; blank when video is off (status is in the entities and the add-on log).

See the **Documentation** tab (`DOCS.md`) for full setup, every option, the camera card
configuration, and how it works. Licensed **GPL-3.0-or-later** - see the repository `LICENSE`.
