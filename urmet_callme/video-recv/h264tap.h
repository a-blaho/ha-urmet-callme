/* SPDX-License-Identifier: GPL-3.0-or-later (links liblinphone, GPLv3) */
/*
 * h264tap.h - the camera's H.264 tap, shared by recv.c (the camera call) and opendoor.c (the camera
 * during a doorbell ring: early media on the ring call, as the official app's "view camera" does).
 * Header-only (one includer per binary), like talkout.h.
 *
 * The includer defines TAP_LOG(fmt, ...) (its own log function) before including. The output FIFO
 * comes from g_tap_target (opendoor's 'V' command) or line 0 of RECV_TARGET_FILE (recv); with no
 * target at all the tap still consumes the stream and writes nothing (video discarded).
 */
#ifndef URMET_H264TAP_H
#define URMET_H264TAP_H

#include <mediastreamer2/msfilter.h>
#include <mediastreamer2/msqueue.h>
#include <mediastreamer2/rfc3984.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#ifndef TAP_LOG
#error "define TAP_LOG before including h264tap.h"
#endif

/* Runtime target for the NEXT tap instance (takes precedence over RECV_TARGET_FILE/env). Set by an
 * includer that learns the camera FIFO per call (opendoor's 'V' command). Empty = not used. */
static char g_tap_target[256] = "";

/* ---- H.264 tap: a custom mediastreamer "decoder" that does NOT decode. Registered as the
 * H264 decoder so liblinphone negotiates H264 recvonly and routes the received RTP to it.
 * It depacketizes (rfc3984) to Annex-B NAL units and writes them to a byte stream (a FIFO),
 * which ffmpeg reads (-f h264 -c copy) and hands to go2rtc. No decode/re-encode. A raw byte
 * stream over a FIFO needs no seeking, so (unlike the MKV recorder) a pipe works. ---- */
/* Wall-clock of the last time a NAL was actually written out (i.e. a reader is draining the
 * FIFO). The main thread uses it for an idle timeout: brief reader gaps (go2rtc probing /
 * WebRTC renegotiation) are tolerated; the call is only torn down when NO reader has drained
 * for RECV_IDLE_SECONDS. Set by the ticker thread, read by the main thread. */
static volatile time_t g_last_drain = 0;

/* Set by the tap when an IDR (NAL type 5) is written out, i.e. real (decodable) video is now on
 * the wire. The main loop uses it to (a) stop nudging for a keyframe, (b) start the reader-idle
 * clock only once streaming actually begins, and (c) give up if no IDR arrives within the window
 * (see g_video_deadline). The nudge matters mainly when two cameras stream at once -- the panel
 * doesn't reliably send each a start-of-call IDR then (single-camera it does). */
static volatile int g_keyframe_seen = 0;

/* A canned black H.264 keyframe (SPS+PPS+IDR, generated at image build -- see Dockerfile), loaded
 * once at startup. The tap writes it to the output FIFO at the START of each call, BEFORE the real
 * panel keyframe arrives (~4s later), so ffmpeg can initialise its encoder and ADVERTISE the video
 * track to go2rtc immediately. That closes the on-demand WebRTC cold-start race: the viewer's
 * negotiation then completes WITH a video track (rendering a black frame), and real frames replace
 * it as they arrive -- instead of locking in a trackless black session that only a refresh fixes. */
static unsigned char *g_black = NULL;
static size_t g_black_len = 0;

static void load_black_frame(void) {
  const char *p = getenv("RECV_BLACK_FRAME");
  if (!p || !*p) p = "/app/black.h264";
  FILE *fp = fopen(p, "rb");
  if (!fp) { TAP_LOG("[tap] no priming frame at %s (cold-start black not masked)\n", p); return; }
  fseek(fp, 0, SEEK_END);
  long sz = ftell(fp);
  fseek(fp, 0, SEEK_SET);
  if (sz > 0 && sz < 1 << 20) {
    g_black = malloc((size_t)sz);
    if (g_black && fread(g_black, 1, (size_t)sz, fp) == (size_t)sz) g_black_len = (size_t)sz;
    else { free(g_black); g_black = NULL; }
  }
  fclose(fp);
  TAP_LOG("[tap] priming frame loaded: %zu bytes from %s\n", g_black_len, p);
}

typedef struct {
  Rfc3984Context *unpacker;
  int fd;
  char path[256];
  long nalus;
  int started;           /* have we hit the first SPS/IDR yet? gate output to a clean GOP boundary */
  long long last_black_ms; /* last time we wrote a priming black keyframe (0 = never) */
} TapState;

/* Monotonic milliseconds, for pacing the priming black frames at ~25 fps. */
static long long now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

static void tap_write(TapState *s, mblk_t *nal) {
  static const unsigned char startcode[4] = {0, 0, 0, 1};
  size_t n = msgdsize(nal);
  msgpullup(nal, n); /* linearize into one block */
  const unsigned char *bufs[2] = {startcode, nal->b_rptr};
  size_t lens[2] = {4, (size_t)(nal->b_wptr - nal->b_rptr)};
  for (int k = 0; k < 2; k++) {
    size_t off = 0;
    while (off < lens[k]) {
      ssize_t w = write(s->fd, bufs[k] + off, lens[k] - off);
      if (w > 0) { off += (size_t)w; continue; }
      if (w < 0 && errno == EINTR) continue;
      /* Buffer full: no reader is draining right now. DROP the rest and keep the call up; a
       * returning reader resyncs at the next IDR (the panel sends one ~every 0.7-2 s -- the
       * stream is P-frame based, NOT all-intra, so a mid-GOP drop shows brief corruption until
       * then; acceptable, and this only triggers under back-pressure, which is rare locally). */
      if (w < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) return;
      close(s->fd); s->fd = -1; return; /* unexpected error -> reopen next tick */
    }
  }
  g_last_drain = time(NULL); /* a full NAL went out -> a reader is present */
}

/* Write the canned black keyframe (already Annex-B with start codes) to the FIFO. Best-effort:
 * drop on EAGAIN (no reader draining yet -- it sits in the pipe buffer for ffmpeg). Used to feed a
 * continuous black stream until the panel's first real keyframe, so ffmpeg advertises the track. */
static void write_black(TapState *s) {
  if (s->fd < 0 || !g_black || !g_black_len) return;
  size_t off = 0;
  while (off < g_black_len) {
    ssize_t w = write(s->fd, g_black + off, g_black_len - off);
    if (w > 0) { off += (size_t)w; continue; }
    if (w < 0 && errno == EINTR) continue;
    return; /* EAGAIN / error -> stop; real frames follow */
  }
}

/* Resolve the output FIFO for the CURRENT call. With the single-account model, one recv serves
 * whichever camera the control plane (src/video.ts) is currently calling, so the target FIFO can
 * change per call. The control plane writes the target paths to RECV_TARGET_FILE (line 0 = H.264
 * FIFO, line 1 = PCM FIFO) BEFORE placing each call; we read it here when the per-call tap is
 * created. Empty when the file or the line is absent. */
static void read_target_line(char *out, size_t outsz, int lineno) {
  out[0] = '\0';
  const char *tf = getenv("RECV_TARGET_FILE");
  if (!tf || !*tf) return;
  FILE *fp = fopen(tf, "r");
  if (!fp) return;
  char line[256];
  int n = 0;
  while (fgets(line, sizeof line, fp)) {
    line[strcspn(line, "\r\n")] = '\0';
    if (n == lineno) { snprintf(out, outsz, "%s", line); break; }
    n++;
  }
  fclose(fp);
}

static void tap_init(MSFilter *f) {
  TapState *s = ms_new0(TapState, 1);
  s->fd = -1;
  if (g_tap_target[0]) snprintf(s->path, sizeof s->path, "%s", g_tap_target);
  else read_target_line(s->path, sizeof s->path, 0);
  s->unpacker = rfc3984_new_with_factory(f->factory);
  f->data = s;
  if (s->path[0]) TAP_LOG("[tap] H264 tap decoder instantiated -> %s\n", s->path);
  else TAP_LOG("[tap] H264 tap decoder instantiated (no camera target: video discarded)\n");
  fflush(stderr);
}

static void tap_process(MSFilter *f) {
  TapState *s = (TapState *)f->data;
  if (!s->path[0] && g_tap_target[0]) {
    /* The camera asked for this call's video after its graph started (opendoor: a ring answered for
     * an announcement, then the camera opened). Adopt the target now; output starts at the next
     * SPS/IDR like any call. */
    snprintf(s->path, sizeof s->path, "%s", g_tap_target);
    TAP_LOG("[tap] camera target set -> %s\n", s->path);
  }
  if (s->fd < 0 && s->path[0]) {
    /* Open O_RDWR|O_NONBLOCK: O_RDWR means the FIFO always has a "reader" (us), so writes
     * NEVER get EPIPE when go2rtc's ffmpeg comes and goes -- they just fill the pipe buffer
     * and return EAGAIN, which we drop. This decouples the SIP call from reader churn (the
     * bug that killed the call ~6s in). O_NONBLOCK keeps the media ticker from ever blocking.
     * O_CREAT covers a plain-file target for the dev spike. */
    int fd = open(s->path, O_RDWR | O_CREAT | O_NONBLOCK, 0644);
    if (fd >= 0) {
      s->fd = fd;
      TAP_LOG("[tap] output stream opened\n");
      fflush(stderr);
    }
  }
  /* Feed a CONTINUOUS black keyframe stream at ~25 fps until the panel's first real GOP arrives.
   * A single priming frame isn't enough -- ffmpeg needs a continuous stream to establish timing
   * before it announces the output track (with one frame it still waits several seconds for the
   * real keyframe). Continuous black lets ffmpeg advertise the video track within a fraction of a
   * second, so the on-demand WebRTC negotiation completes WITH a track (showing black) and real
   * frames replace it when they arrive -- no more trackless black session (see g_black). Paced by
   * wall-clock ms; the real-frame gate below still holds until the first SPS/IDR. */
  if (!s->started && s->fd >= 0 && g_black) {
    long long now = now_ms();
    if (now - s->last_black_ms >= 40) { /* ~25 fps */
      write_black(s);
      if (s->last_black_ms == 0) {
        TAP_LOG("[tap] priming black stream -> track advertised early\n");
        fflush(stderr);
      }
      s->last_black_ms = now;
    }
  }
  mblk_t *im;
  MSQueue nalus;
  ms_queue_init(&nalus);
  while ((im = ms_queue_get(f->inputs[0])) != NULL) {
    rfc3984_unpack2(s->unpacker, im, &nalus); /* consumes im, appends complete NALs */
    mblk_t *nal;
    while ((nal = ms_queue_get(&nalus)) != NULL) {
      size_t n = msgdsize(nal);
      int type = (n > 0) ? (nal->b_rptr[0] & 0x1F) : -1;
      if (type == 5) g_keyframe_seen = 1; /* IDR -> a decodable picture is now on the wire */
      if (s->nalus < 12) { /* diagnostic: log first NALs' type + size */
        TAP_LOG("[tap] NAL #%ld type=%d size=%zu\n", s->nalus, type, n);
        fflush(stderr);
      }
      s->nalus++;
      /* Start the output stream at a clean GOP boundary. If the panel starts us mid-GOP the first
       * NALs are P-frames (type 1) referencing a keyframe we never received -> the decoder renders
       * garbage or a stale picture until the next IDR. Drop everything until the first SPS/IDR so
       * ffmpeg/HA sees a decodable stream from the first byte. (The main loop nudges for that IDR;
       * if none ever arrives we write nothing and the card shows unavailable -- better than garbage.
       * See g_video_deadline for the give-up timeout.) */
      if (!s->started) {
        if (type == 7 || type == 5) {
          s->started = 1;
        } else {
          freemsg(nal);
          continue;
        }
      }
      if (s->fd >= 0) tap_write(s, nal);
      freemsg(nal);
    }
  }
  ms_queue_flush(&nalus);
}

static void tap_uninit(MSFilter *f) {
  TapState *s = (TapState *)f->data;
  if (s->fd >= 0) close(s->fd);
  if (s->unpacker) rfc3984_destroy(s->unpacker);
  ms_message("[tap] uninit (%ld NALs forwarded)", s->nalus);
  ms_free(s);
}

static MSFilterMethod tap_methods[] = {{0, NULL}};
static MSFilterDesc tap_desc = {
    .id = MS_FILTER_PLUGIN_ID,
    .name = "H264TapDecoder",
    .text = "Forwards received H264 NALs (Annex-B) to a byte stream instead of decoding",
    .category = MS_FILTER_DECODER,
    .enc_fmt = "H264",
    .ninputs = 1,
    .noutputs = 1,
    .init = tap_init,
    .preprocess = NULL,
    .process = tap_process,
    .postprocess = NULL,
    .uninit = tap_uninit,
    .methods = tap_methods,
    /* IS_PUMP: the ticker then calls tap_process on EVERY tick, not only when RTP is queued on our
     * input. Without it the priming black stream (see g_black) could not start until the panel's
     * FIRST packet arrived -- which is the keyframe itself, ~2 s after the streams start -- so the
     * "early" track advertisement happened ~30 ms before the real picture and bought nothing.
     * Measured 2026-09-14: one black frame reached the viewer, then the picture. As a pump the tap
     * primes from the moment the graph runs, so ffmpeg/go2rtc/the viewer are fully set up while the
     * panel is still warming up, and the real keyframe is shown as soon as it lands. */
    .flags = MS_FILTER_IS_PUMP,
};

#endif /* URMET_H264TAP_H */
