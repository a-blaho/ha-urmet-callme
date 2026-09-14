# Ubuntu 24.04 base -- REQUIRED for the video path. The camera pipeline embeds liblinphone plus a
# custom mediastreamer2 tap filter (video-recv/recv.c) that must win the H.264 decoder lookup, and
# that tap is VERSION-FRAGILE: on Debian trixie (liblinphone 5.3.105 / mediastreamer2 v14) it stops
# producing frames -- the camera call connects but recv never reports media, so stream.sh gets a 503
# and go2rtc shows the camera "unavailable" (the 2Voice video regression Noemi caught, 2026-09).
# Door-open is unaffected (opendoor.c places the same call but does NOT tap video). Ubuntu 24.04 is
# the PROVEN media environment -- do NOT "modernize" the base to Debian/Alpine without re-verifying
# video on a real panel. ubuntu:24.04 is multi-arch, so the composable-actions CI
# (.github/workflows) still builds per-arch with no build.yaml. No S6 here, so config.yaml sets
# init: true (tini reaps the ffmpeg/go2rtc/stream.sh grandchildren).
#
# SINGLE-STAGE on purpose: a multi-stage split shrinks the image but (a) doubles the apt phase and
# (b) separates the compile-time and run-time liblinphone/mediastreamer -- another place the fragile
# media stack can drift. Keep single-stage until video is re-verified; optimize size later, via beta.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# go2rtc is PINNED and checksum-verified, not "latest". src/go2rtc.ts hardens its LAN-facing API with
# go2rtc config keys (app.modules, api.allow_paths, exec.allow_paths); go2rtc silently ignores keys it
# doesn't know, so an unpinned upgrade that renamed one would quietly re-open the API. Bump the
# version deliberately: update BOTH sha256s (sha256sum of go2rtc_linux_amd64 / go2rtc_linux_arm64
# from the release) and re-check those keys still exist.
ARG GO2RTC_VERSION=1.9.14
ARG GO2RTC_SHA256_AMD64=32d616af226bd731678ffde328b94cfb94e30339bfefc469cfb76323144615a6
ARG GO2RTC_SHA256_ARM64=359fabade8a7a51e81a55fe6df6b0ef81764a5e1d63179577534eaaa71904b50

# NOTE: linphone-cli is REQUIRED (not just for its binaries): it pulls linphone-common, which ships
# /usr/share/belr/grammars/identity_grammar. Without it liblinphone FATALs ("Unable to load Identity
# Address grammar") and recv crash-loops. liblinphone-dev alone only provides the sdp/vcard grammars.
# Do NOT drop linphone-cli to slim the image. On Ubuntu, liblinphone-dev pulls the mediastreamer/ortp
# dev symlinks, so recv/opendoor link -lmediastreamer -lortp (NOT the Debian -lmediastreamer2).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl build-essential pkg-config \
      liblinphone-dev linphone-cli mediastreamer2-plugin-openh264 ffmpeg \
 && curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource.sh \
 && bash /tmp/nodesource.sh \
 && apt-get install -y --no-install-recommends nodejs \
 && command -v npm \
 && node --version \
 && arch="$(dpkg --print-architecture)" \
 && case "$arch" in \
      amd64) sum="$GO2RTC_SHA256_AMD64" ;; \
      arm64) sum="$GO2RTC_SHA256_ARM64" ;; \
      *) echo "no go2rtc checksum for $arch" >&2; exit 1 ;; \
    esac \
 && curl -fsSL -o /usr/local/bin/go2rtc \
      "https://github.com/AlexxIT/go2rtc/releases/download/v${GO2RTC_VERSION}/go2rtc_linux_${arch}" \
 && echo "$sum  /usr/local/bin/go2rtc" | sha256sum -c - \
 && chmod +x /usr/local/bin/go2rtc \
 && rm -rf /var/lib/apt/lists/* /tmp/nodesource.sh

WORKDIR /app
COPY package.json package-lock.json* tsconfig.json tsconfig.build.json ./
RUN npm ci
COPY src ./src
COPY video-recv/recv.c ./recv.c
COPY video-recv/opendoor.c ./opendoor.c
COPY stream.sh ./stream.sh

# Build the TS control plane, compile the liblinphone receiver + 2Voice door-opener, drop dev deps.
# Also generate a tiny black H.264 keyframe (SPS+PPS+IDR, CIF 352x288 baseline): recv writes it to the
# output FIFO at the start of each call so ffmpeg (and thus go2rtc) can ADVERTISE the video track
# immediately, before the panel's first real keyframe (~4s later) -- otherwise the on-demand WebRTC
# negotiation completes with no track and the viewer locks in a black session until a refresh.
RUN npm run build \
 && cc -O2 -Wall recv.c -llinphone -lbctoolbox -lbellesip -lmediastreamer -lortp \
      -o /usr/local/bin/recv \
 && cc -O2 -Wall opendoor.c -llinphone -lbctoolbox -lbellesip -lmediastreamer -lortp \
      -o /usr/local/bin/opendoor \
 && ffmpeg -hide_banner -loglevel error -f lavfi -i color=black:s=352x288:r=25 \
      -frames:v 1 -c:v libx264 -profile:v baseline -pix_fmt yuv420p -f h264 /app/black.h264 \
 && chmod +x /app/stream.sh \
 && npm prune --omit=dev

ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
