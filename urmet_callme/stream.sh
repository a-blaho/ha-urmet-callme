#!/bin/sh
# go2rtc exec source target. go2rtc runs this on the first viewer of a camera stream and kills
# it when idle. It (1) asks the control plane to place the call for this camera (recv answers and
# taps the raw H.264 + PCM audio to FIFOs), then (2) execs ffmpeg to mux them to go2rtc's {output}
# RTSP -- video RE-ENCODED to a clean CFR stream (see below; NOT copied), audio normalized + encoded
# to Opus/AAC.
#
# TEARDOWN is NOT done here. go2rtc stops an exec producer by cancelling a Go CommandContext, which
# is a SIGKILL: no trap ever runs, so a "curl /hangup on exit" step (an earlier version of this
# script) never fired -- the call always ended via recv's reader-idle timer instead. So this script
# `exec`s ffmpeg (ffmpeg IS the process go2rtc kills, no orphan left behind) and the call ends when
# recv sees no FIFO reader for RECV_IDLE_SECONDS. That idle window is also what makes a re-open of
# the same camera instant (the control plane reuses the still-live call, see video.ts placeCall).
#
#   $1 = camera index    $2 = {output} RTSP url provided by go2rtc    $3 = control port (optional)
CAM="$1"
OUTPUT="$2"
FIFO="/tmp/urmet_cam_${CAM}.h264"     # per-camera video FIFO (matches recv's RECV_H264_OUT)
AFIFO="/tmp/urmet_cam_${CAM}.pcm"     # per-camera audio FIFO  (matches recv's RECV_AUDIO_OUT)
# Control endpoint port. The 2Voice service passes an ephemeral port as $3 (to dodge a host-network
# clash with e.g. Zigbee2MQTT on 8099); the IPERCOM service omits it and uses the env/default.
CALL_PORT="${3:-${CALL_PORT:-8099}}"

# Place the call; recv (already registered) answers and starts tapping. Synchronous so that if the
# control plane rejects the request (`curl -f` fails) we exit BEFORE ffmpeg instead of waiting
# forever on an empty FIFO. The control plane serves ONE camera at a time: a /call while another
# camera holds the slot either actively switches to this one or (during the ping-pong debounce)
# returns 503 -> curl -f fails -> we exit and go2rtc shows the stream as unavailable.
if ! curl -fsS -m 20 "http://127.0.0.1:${CALL_PORT}/call?cam=${CAM}" >/dev/null 2>&1; then
  echo "urmet: camera ${CAM} not available (panel busy with another camera?)" >&2
  exit 1
fi

# TIMELINE: stamp every video frame with the WALL CLOCK (setpts=RTCTIME) before the CFR step.
# Raw Annex-B has no timestamps, so ffmpeg builds the timeline from a frame count at an assumed
# 25 fps. The panel actually delivers ~12.5 fps, so the timeline advanced at HALF real time: the
# view fell further behind the longer you watched, and -- because the transcode loop then
# consumed audio at half the rate the helper produces it -- the audio FIFO backed up and its
# buffers were dropped, which is heard as the sound dying a few seconds into every call.
# `-use_wallclock_as_timestamps 1` is meant to prevent this and DOES on ffmpeg 8, but is a no-op
# for raw H.264 on the ffmpeg 6.1 this image ships; measured 0.53x with it, 1.00x with setpts.
# setpts is also rate-agnostic: 0.99-1.00x whether the panel sends 6, 13 or 25 fps, whereas
# declaring a fixed input -r is only correct at the one rate it was tuned for.
#
# Video: RE-ENCODE to a constant-framerate stream. The panel's H.264 is small (CIF 352x288,
# ~200 kbps, mostly P-frames with an IDR ~every 0.7-2 s). The problem with passing it through
# (`-c:v copy`) is TIMING: raw Annex-B carries no timestamps, so stamping by arrival wall-clock
# produces NON-MONOTONIC DTS out of go2rtc (frames read in bursts get tied/roll-back
# stamps). Consumers then DROP most frames to keep a monotonic timeline (e.g. ~17 fps arriving
# at go2rtc but only ~7 fps surviving to an ffmpeg consumer, and far fewer to a browser) -- the
# "very low framerate" symptom. Copy can't fix this cleanly (a fixed input `-r` would desync from
# the real-time audio). So decode and re-encode with a real-time reference (wall-clock input PTS)
# and `-fps_mode cfr` (the documented replacement for `-vsync`, which ffmpeg 7 REMOVED; the image
# ships 6.1, where both work): libx264 emits clean, monotonic, evenly-paced timestamps at a true
# CFR, staying
# anchored to the real-time (audio) timeline. This also yields a proper GOP (small P-frames +
# periodic keyframe) that go2rtc/WebRTC CAN adapt down on a constrained link -- so it fixes the
# cellular stutter too. Re-encoding CIF is cheap: at CIF with ultrafast + CRF 20 + a 1.5 Mbps
# ceiling the picture is clean and CPU is light. `-tune zerolatency` keeps latency low; baseline +
# yuv420p keep it WebRTC-friendly.
# Audio: the panel's PCM arrives at recv in bursts/gaps (recv drops buffers under back-pressure).
# We NORMALIZE it (`aresample=async=1`: continuous output, gaps filled with silence, drift
# corrected) and wall-clock it so it shares the video's real-time reference -- otherwise WebRTC
# audio glitches on the gaps. Encode to BOTH Opus (WebRTC-native: WebRTC only allows
# Opus/PCMU/PCMA and go2rtc will NOT auto-transcode AAC -> without Opus, WebRTC is SILENT) and AAC
# (kept for an MSE fallback). filter_complex resamples once then asplit's to both encoders, so
# neither is a lossy re-transcode of the other. recv forces G.711 -> PCM is ALWAYS 8 kHz mono
# s16le (hardcode; raw s16le has no header).
# streams: 0 = H.264 (re-encoded, CFR 25), 1 = AAC, 2 = Opus.
# -thread_queue_size on BOTH inputs. ffmpeg demuxes each input in its own thread into a queue, and
# on a slow host that queue overflows at its default depth of 8 packets: the demux thread then stops
# reading the FIFO, recv's writes hit EAGAIN, and every buffer it wrote is dropped -- the panel's
# audio is decoded correctly and then thrown away, so the viewer gets silence while video still
# plays. This is not a guess: a 2Voice user on slow hardware reported ffmpeg saying so itself on
# both inputs, "Thread message queue blocking; consider raising the thread_queue_size option
# (current value: 8)", in the same call where the PCM tap logged repeated stalls. 512 packets is
# many seconds of buffer on either input and costs a few MB, which is affordable on a 1 GB host.
# The AUDIO queue is deliberately SMALL (32 packets ~ 2 s at 8 kHz mono; the raw demuxer reads
# 1024-byte packets). A big audio queue does not just absorb hiccups, it HIDES LATENCY: whatever
# is queued is older than what arrives next, and since the transcode loop consumes audio at the
# rate its output timeline advances, a backlog built up before the video timeline starts never
# drains -- it becomes a permanent offset. Measured on a real installation: audio ran 4.3 s
# behind the picture with a 512-packet queue, while losing no samples at all mid-call. For a
# doorbell a short gap is far better than hearing the visitor seconds late, so the audio side
# gets a tight queue and the video side keeps a generous one.
# ultrafast keeps the encode cheap on small ARM hosts (CIF at 25 fps; the 1.5 Mbps ceiling bounds
# the bitrate cost of the faster preset).
# -analyzeduration 0 -probesize 32k: don't spend the default ~5s analyzing the H.264 input before
# announcing the output track. recv feeds a continuous black keyframe stream from call-start (see
# recv.c g_black), so ffmpeg has a stream immediately; without these flags it still waits out
# analyzeduration (~5s) and the on-demand WebRTC negotiation locks in a trackless black session.
# With them, ffmpeg advertises the video track within a fraction of a second of the first frame.
exec ffmpeg -hide_banner -loglevel warning -stats -stats_period 30 \
  -analyzeduration 0 -probesize 32768 -thread_queue_size 512 \
  -use_wallclock_as_timestamps 1 -f h264 -i "$FIFO" \
  -thread_queue_size 32 \
  -use_wallclock_as_timestamps 1 -f s16le -ar 8000 -ac 1 -i "$AFIFO" \
  -filter_complex "[0:v]setpts=(RTCTIME-RTCSTART)/(TB*1000000)[v];[1:a]aresample=async=1,asplit=2[a0][a1]" \
  -map "[v]" -map "[a0]" -map "[a1]" \
  -c:v libx264 -preset ultrafast -tune zerolatency -profile:v baseline -pix_fmt yuv420p \
    -fps_mode cfr -r 25 -g 50 -crf 20 -maxrate 1500k -bufsize 1500k \
  -c:a:0 aac -c:a:1 libopus -ar 48000 -ac 1 -b:a 64k \
  -rtsp_transport tcp -f rtsp "$OUTPUT"
