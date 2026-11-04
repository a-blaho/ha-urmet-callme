# ha-urmet-callme — developer notes

Unofficial Home Assistant **add-on** (`urmet_callme/`, the whole product) that drives an Urmet CallMe
intercom: door/gate unlock, doorbell events and, opt-in, the entrance cameras. It re-implements the
official app's cloud + SIP client (pure TypeScript) and embeds liblinphone for anything that needs
media (two small C helpers). Not affiliated with Urmet.

## Layout

```
urmet_callme/
  src/            TypeScript control plane (node:test unit tests live beside the modules)
  video-recv/     recv.c (Ipercom camera receiver), station.c (2Voice station helper: door, camera,
                  ring, announcements on the one call), lpcommon.h / h264tap.h / talkout.h shared
  stream.sh       go2rtc exec target: asks for the call, then ffmpeg re-encodes the tapped FIFOs
  config.yaml     add-on manifest; version must match package.json and have a CHANGELOG section
  Dockerfile      Ubuntu 24.04 + node 22 + liblinphone + go2rtc + ffmpeg, single stage on purpose
  DOCS.md         user documentation (what the add-on exposes and why)
  deploy-local.sh push a working tree to a Home Assistant box as a local add-on
.github/workflows CI (typecheck, tests, build, compile the helpers, version/changelog, shellcheck);
                  images are built only by a v<version> tag
REFACTOR-PLAN.md  the 2026-11 cleanup analysis and its phases
reverse-engineering/  GIT-IGNORED: the official apps, their jadx output and the protocol notes
                  derived from them (Urmet's IP; see its README.md). Never commit, never copy from it.
```

## Modules (`urmet_callme/src`)

| Module | Role |
|---|---|
| `index.ts` | composition root: config, wiring, shutdown, the 25 s maintenance tick |
| `cloud.ts` | Urmet cloud HTTP: login, `sipdata`, `get_my_devices`, unique account creation |
| `urmetCrypto.ts`, `token.ts`, `query.ts` | the `sipdata` cipher, the MESSAGE token, the MESSAGE body |
| `sipClient.ts` | one TLS socket per account: REGISTER, out-of-dialog MESSAGE, inbound INVITE ring-only |
| `callme.ts` | the session: cloud login, instance SIP account, places (updated in place on reconnect), SIP registration; thin by-place-id delegates to the three below |
| `place.ts`, `ipercom.ts`, `doorbell.ts`, `stationDiscovery.ts` | the place model and `familyOf`; the Ipercom gateway MESSAGE protocol (resolve, doors, devices, open, call/cancel); per-place doorbell listeners; the phase-B place the cloud does not list (introduction, census, ring) |
| `twoVoiceStation.ts` | 2Voice: one persistent `station` helper per place; door/gate/ready/announce and, with video, the camera on its single call |
| `video.ts` | Ipercom camera service: shared account B, `recv`, one slot (`holder`) and one explicit call state (`requested` / `live` / `ended`) |
| `cameraPipeline.ts`, `go2rtc.ts`, `helperProtocol.ts` | shared FIFO/control-endpoint pieces, the hardened go2rtc config, the helper stdin/stdout alphabet |
| `announce.ts` | 2Voice announcements (TTS or URL → talk FIFO) |
| `mqtt.ts` | MQTT discovery entities and command routing (`publishEntity`) |
| `util.ts`, `proc.ts`, `logger.ts`, `station.ts` | pure helpers, child-process helpers, logging, learned stations |

## Rules that are not obvious from the code

- **Mimic the official app.** Before designing any call/DTMF/media behaviour, read the call site and
  the UI gating in the decompiled Uin (CallMe Five) app and copy it: `reverse-engineering/PROTOCOL-UIN.md`
  is the item-by-item comparison, `reverse-engineering/callme/callme-five-2.3.0/sources/com/urmet/` the
  source. The 4.5.4 app there is the legacy client; use it only for phase-B behaviour.
- **Wire identities are pinned.** `stableUuid` seeds (`urmet-callme:`, `urmet-opendoor:`, `urmet-recv:`)
  are the registrar bindings of the running processes; changing one makes a restart add a binding
  instead of replacing it. The tests pin them.
- **One call per 2Voice station.** The camera call *is* the door call, so one `station` process per
  place owns it and serves door, camera, ring and announcements on it; never spawn a second
  liblinphone process against a 2Voice station.
- **Entity ids are retained MQTT state.** `publishEntity` uids (`urmet_<place>_<door>_<kind>`, …) must
  stay stable across releases; `clearStaleDiscovery` purges ids older builds used.
- **Helper protocol.** The stdin letters and stdout `RESULT`/`RING`/`CAMERA` lines are defined once in
  `helperProtocol.ts` and documented in each helper's usage text; keep them in step.
- **Versioning.** `config.yaml` and `package.json` versions must match and `CHANGELOG.md` must have a
  `## <version>` section (CI enforces it). Changing options/schema needs a version bump for the
  Supervisor to pick the schema up.

## Build, test, deploy

```bash
cd urmet_callme && npm ci
npm run typecheck   # tsc over src/ including the tests
npm test            # node:test unit tests (src/**/*.test.ts)
npm run build       # dist/ as the image builds it
```

The C helpers need `liblinphone-dev` (Ubuntu 24.04); CI compiles them, or use Docker locally:
`docker run --rm -v "$PWD/video-recv:/s" ubuntu:24.04 sh -c 'apt-get update -qq && apt-get install -y -qq build-essential liblinphone-dev >/dev/null && cc -O2 -Wall /s/recv.c -llinphone -lbctoolbox -lbellesip -lmediastreamer -lortp -o /tmp/recv && cc -O2 -Wall /s/station.c -llinphone -lbctoolbox -lbellesip -lmediastreamer -lortp -o /tmp/station'`.

Testing on real hardware: `deploy-local.sh` (it detects `/local_apps` vs `/addons`). On the HA Green,
stop the store add-on first (it reclaims the go2rtc ports on every Supervisor restart) and prove the
new image is live by grepping the add-on log for a line only the new code prints; `ha apps update` at
an unchanged version is a no-op, use `ha apps rebuild`.
