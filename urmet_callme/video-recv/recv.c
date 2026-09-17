/* SPDX-License-Identifier: GPL-3.0-or-later (links liblinphone, GPLv3) */
/*
 * recv.c - the embedded liblinphone media receiver. SHIPPED: compiled into the add-on's video
 * image (see ../Dockerfile) and spawned ONCE by src/video.ts (the VideoService): a single
 * receiver serves every camera, one call at a time.
 *
 * liblinphone (mediastreamer2) is the ONLY stack that made the Urmet relay actually stream the
 * panel's H.264 - pure-Node and baresip both got 0 media. So the
 * media leg embeds real liblinphone here, driven by the Node/TS control plane. This program
 * registers the shared dedicated SIP account B, auto-answers the panel's INVITE, and taps the
 * received media WITHOUT decoding/re-encoding:
 *   - H.264: a custom mediastreamer "decoder" filter depacketizes (rfc3984) to Annex-B and
 *     writes the byte stream to a FIFO (RECV_H264_OUT).
 *   - audio: a custom mediastreamer sound card writes the decoded PCM (s16le) to a FIFO
 *     (RECV_AUDIO_OUT); a single G.711 codec is forced so the PCM is deterministic 8 kHz mono.
 * ffmpeg (in stream.sh) reads both FIFOs and hands them to go2rtc -> HA. No MKV, no display.
 *
 * The call is placed by the control plane (src/callme.ts, from account A) via call_device_req
 * with uri_to_call/response_uri pointed at account B, so the gateway routes the panel INVITE
 * here. This program only registers + answers + taps; teardown is an idle timeout (no FIFO
 * reader for RECV_IDLE_SECONDS) plus a gateway cancel_call_req curled via RECV_HANGUP_URL.
 *
 * Usage: recv <B-username> <B-password>   (see the env vars documented at main()).
 * Targets the liblinphone C API on Ubuntu 24.04 (liblinphone-dev + mediastreamer2-plugin-openh264).
 */
#include <linphone/core.h>
#include <mediastreamer2/msfilter.h>
#include <mediastreamer2/msfactory.h>
#include <mediastreamer2/msqueue.h>
#include <mediastreamer2/mssndcard.h>
#include <mediastreamer2/rfc3984.h>
#include <ortp/str_utils.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <stdarg.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>

/* Timestamped log line. The helper's output used to carry no timestamp of its own while the control
 * plane stamps every line and liblinphone stamps its own, so in the add-on log you could not tell
 * when [recv]/[atap]/[tap] events happened relative to anything else -- which made diagnosing the
 * order of "audio started", "first keyframe" and "ffmpeg attached" impossible from a user's log.
 * Everything also goes to STDOUT now: [atap] on stderr and [recv] on stdout could appear out of
 * order, since the two streams are buffered separately. */
static void rlog(const char *fmt, ...) {
  struct timeval tv;
  gettimeofday(&tv, NULL);
  struct tm tm;
  gmtime_r(&tv.tv_sec, &tm);
  char when[24];
  strftime(when, sizeof when, "%Y-%m-%dT%H:%M:%S", &tm);
  printf("%s.%03dZ ", when, (int)(tv.tv_usec / 1000));
  va_list ap;
  va_start(ap, fmt);
  vprintf(fmt, ap);
  va_end(ap);
  fflush(stdout);
}


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
  if (!fp) { rlog("[tap] no priming frame at %s (cold-start black not masked)\n", p); return; }
  fseek(fp, 0, SEEK_END);
  long sz = ftell(fp);
  fseek(fp, 0, SEEK_SET);
  if (sz > 0 && sz < 1 << 20) {
    g_black = malloc((size_t)sz);
    if (g_black && fread(g_black, 1, (size_t)sz, fp) == (size_t)sz) g_black_len = (size_t)sz;
    else { free(g_black); g_black = NULL; }
  }
  fclose(fp);
  rlog("[tap] priming frame loaded: %zu bytes from %s\n", g_black_len, p);
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
 * change per call. video.ts writes the target paths to RECV_TARGET_FILE (line 0 = H.264 FIFO,
 * line 1 = PCM FIFO) BEFORE placing each call; we read it here when the per-call tap is created.
 * Falls back to the static env var (single-camera / dev spike). */
static void read_target_line(char *out, size_t outsz, int lineno, const char *env_fallback) {
  out[0] = '\0';
  const char *tf = getenv("RECV_TARGET_FILE");
  if (tf && *tf) {
    FILE *fp = fopen(tf, "r");
    if (fp) {
      char line[256];
      int n = 0;
      while (fgets(line, sizeof line, fp)) {
        line[strcspn(line, "\r\n")] = '\0';
        if (n == lineno) { snprintf(out, outsz, "%s", line); break; }
        n++;
      }
      fclose(fp);
    }
  }
  if (!out[0]) {
    const char *e = env_fallback ? getenv(env_fallback) : NULL;
    if (e && *e) snprintf(out, outsz, "%s", e);
  }
}

static void tap_init(MSFilter *f) {
  TapState *s = ms_new0(TapState, 1);
  s->fd = -1;
  read_target_line(s->path, sizeof s->path, 0, "RECV_H264_OUT");
  if (!s->path[0]) snprintf(s->path, sizeof s->path, "%s", "/tmp/cam.h264");
  s->unpacker = rfc3984_new_with_factory(f->factory);
  f->data = s;
  rlog("[tap] H264 tap decoder instantiated -> %s\n", s->path);
  fflush(stderr);
}

static void tap_process(MSFilter *f) {
  TapState *s = (TapState *)f->data;
  if (s->fd < 0) {
    /* Open O_RDWR|O_NONBLOCK: O_RDWR means the FIFO always has a "reader" (us), so writes
     * NEVER get EPIPE when go2rtc's ffmpeg comes and goes -- they just fill the pipe buffer
     * and return EAGAIN, which we drop. This decouples the SIP call from reader churn (the
     * bug that killed the call ~6s in). O_NONBLOCK keeps the media ticker from ever blocking.
     * O_CREAT covers a plain-file target for the dev spike. */
    int fd = open(s->path, O_RDWR | O_CREAT | O_NONBLOCK, 0644);
    if (fd >= 0) {
      s->fd = fd;
      rlog("[tap] output stream opened\n");
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
        rlog("[tap] priming black stream -> track advertised early\n");
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
        rlog("[tap] NAL #%ld type=%d size=%zu\n", s->nalus, type, n);
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

/* ---- Audio tap: liblinphone decodes the received audio (Opus/PCMU/...) to PCM; this minimal
 * mediastreamer sound-card PLAYBACK filter writes that PCM (s16le) to a second FIFO instead of a
 * speaker. ffmpeg reads it (-f s16le) alongside the H.264 and muxes both into the go2rtc stream,
 * so the HA camera gets sound. Codec-agnostic: the tap is downstream of the decoder, so it works
 * whatever the panel offers. A single G.711 codec is forced (see main()), so liblinphone drives
 * this card at a DETERMINISTIC 8 kHz mono - the SET handlers just record that format and stream.sh
 * hardcodes the matching `-ar 8000 -ac 1` (raw s16le has no header). ---- */
static MSFactory *g_factory = NULL; /* stashed for the sound-card writer factory */

typedef struct {
  int fd;
  char path[256];
  int rate;
  int nch;
  long bytes;
  int announced; /* logged the PCM format yet? */
  /* Level diagnostics (per ~1s window): distinguishes "no/silent audio from the panel" (rms 0, or
   * no buffers at all) from "audio arrives but does not reach the stream" (rms > 0, wrote > 0 but
   * the listener hears nothing -> the problem is downstream in ffmpeg/go2rtc). See awrite_process. */
  long win_frames;  /* input buffers this window */
  long win_dropped; /* buffers dropped on a full FIFO (EAGAIN) this window */
  long win_samp;    /* samples accumulated this window */
  double win_sumabs; /* sum of |sample| this window (avg level; no sqrt/-lm needed) */
  int win_peak;     /* peak |sample| this window */
  int stalled;      /* last window: every write dropped (nothing draining the FIFO) */
} AudioTap;

static void awrite_init(MSFilter *f) {
  AudioTap *s = ms_new0(AudioTap, 1);
  s->fd = -1;
  s->rate = 48000; /* defaults; overwritten by whatever liblinphone SETs on the card */
  s->nch = 1;
  read_target_line(s->path, sizeof s->path, 1, "RECV_AUDIO_OUT"); /* per-call target (see tap_init) */
  if (!s->path[0]) snprintf(s->path, sizeof s->path, "%s", "/tmp/cam_audio.pcm");
  f->data = s;
}

/* Log the actual PCM format once. With G.711 forced this must read "8000 Hz, 1 ch"; anything
 * else means the codec forcing didn't take and stream.sh's hardcoded 8k/mono will be wrong. */
static void awrite_announce(AudioTap *s) {
  if (s->announced) return;
  rlog("[atap] PCM format: %d Hz, %d ch, s16le\n", s->rate, s->nch);
  fflush(stderr);
  s->announced = 1;
}

static void awrite_process(MSFilter *f) {
  AudioTap *s = (AudioTap *)f->data;
  awrite_announce(s);
  if (s->fd < 0) {
    /* Same O_RDWR|O_NONBLOCK trick as the H264 tap: we hold the FIFO open so writes never
     * EPIPE when ffmpeg comes and goes; a full pipe just returns EAGAIN and we drop. */
    int fd = open(s->path, O_RDWR | O_CREAT | O_NONBLOCK, 0644);
    if (fd >= 0) {
      s->fd = fd;
      rlog("[atap] PCM stream opened -> %s (%d Hz, %d ch, s16le)\n",
              s->path, s->rate, s->nch);
      fflush(stderr);
    }
  }
  mblk_t *im;
  while ((im = ms_queue_get(f->inputs[0])) != NULL) {
    {
      /* Level of THIS buffer (independent of whether the write below succeeds): tells us what the
       * panel is actually sending. avg/peak 0 with buffers flowing = silence upstream (e.g. audio
       * paused by the panel); no buffers at all = liblinphone built no audio graph. */
      size_t alen = msgdsize(im);
      msgpullup(im, alen);
      const int16_t *pcm = (const int16_t *)im->b_rptr;
      size_t nsamp = alen / 2;
      for (size_t k = 0; k < nsamp; k++) {
        int v = pcm[k];
        int a = v < 0 ? -v : v;
        if (a > s->win_peak) s->win_peak = a;
        s->win_sumabs += (double)a;
      }
      s->win_samp += (long)nsamp;
      s->win_frames++;
    }
    if (s->fd >= 0) {
      size_t len = msgdsize(im);
      msgpullup(im, len); /* linearize into one block (one whole set of PCM frames) */
      /* Write the buffer in ONE call. A pipe write <= PIPE_BUF (4 KiB) is atomic under
       * O_NONBLOCK: it writes everything or nothing (EAGAIN). Mediastreamer audio buffers are
       * far smaller, so we never write a partial frame -- critical for audio, where a mid-frame
       * byte offset would shift every subsequent sample and distort the whole stream (video
       * tolerates this by resyncing on keyframes; audio does not). On EAGAIN (reader not
       * draining) or any partial, we DROP the whole buffer to preserve frame alignment. */
      ssize_t w = write(s->fd, im->b_rptr, len);
      if (w == (ssize_t)len) {
        s->bytes += (long)len;
      } else if (w < 0 && (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR)) {
        s->win_dropped++; /* pipe full or interrupted: drop this buffer (stays frame-aligned) */
      } else if (w < 0) {
        close(s->fd); s->fd = -1; /* unexpected error -> reopen next tick */
      }
      /* 0 < w < len can't happen for our small buffers (atomic), so no partial to realign. */
    }
    freemsg(im);
  }
  /* Once per ~1s of audio, report the level + write health. Reading this line answers the split
   * Noemi asked for: peak/avg 0 (or "0 buf") => the panel isn't sending audio to us (e.g. paused);
   * peak/avg > 0 with total rising and dropped low => audio reaches the FIFO fine and the fault is
   * downstream (ffmpeg/go2rtc). */
  if (s->win_samp >= s->rate && s->rate > 0) {
    long avg = s->win_samp ? (long)(s->win_sumabs / (double)s->win_samp) : 0;
    /* Reader health, logged on TRANSITIONS so it is visible at any log level: a whole window
     * dropped means nothing is reading the PCM FIFO -- ffmpeg gone (the viewer left; the H.264
     * idle timer will end the call) or ffmpeg alive but not consuming audio (its video encode is
     * behind real time and its audio input queue is full: see stream.sh's -thread_queue_size). */
    int all_dropped = s->win_frames > 0 && s->win_dropped >= s->win_frames;
    if (all_dropped && !s->stalled) {
      rlog("[atap] PCM FIFO not being drained: every audio buffer dropped this second "
             "(no reader, or ffmpeg not consuming audio)\n");
      fflush(stdout);
    } else if (!all_dropped && s->stalled) {
      rlog("[atap] PCM FIFO draining again\n");
      fflush(stdout);
    }
    s->stalled = all_dropped;
    fprintf(stderr,
            "[atap] audio ~1s: %ld buf, avg=%ld peak=%d (of 32768), total=%ldB dropped=%ld\n",
            s->win_frames, avg, s->win_peak, s->bytes, s->win_dropped);
    fflush(stderr);
    s->win_frames = 0;
    s->win_dropped = 0;
    s->win_samp = 0;
    s->win_sumabs = 0;
    s->win_peak = 0;
  }
}

static void awrite_uninit(MSFilter *f) {
  AudioTap *s = (AudioTap *)f->data;
  if (s->fd >= 0) close(s->fd);
  ms_message("[atap] uninit (%ld PCM bytes forwarded)", s->bytes);
  ms_free(s);
}

/* Accept whatever rate/channels liblinphone configures (with G.711 forced this is 8 kHz mono).
 * Returning the SET value from GET means liblinphone feeds us PCM in exactly that format -- no
 * guessing; we just log it once (see awrite_announce) to confirm the forcing took. */
static int awrite_set_sr(MSFilter *f, void *a) { ((AudioTap *)f->data)->rate = *(int *)a; return 0; }
static int awrite_get_sr(MSFilter *f, void *a) { *(int *)a = ((AudioTap *)f->data)->rate; return 0; }
static int awrite_set_nch(MSFilter *f, void *a) { ((AudioTap *)f->data)->nch = *(int *)a; return 0; }
static int awrite_get_nch(MSFilter *f, void *a) { *(int *)a = ((AudioTap *)f->data)->nch; return 0; }

static MSFilterMethod awrite_methods[] = {
    {MS_FILTER_SET_SAMPLE_RATE, awrite_set_sr},
    {MS_FILTER_GET_SAMPLE_RATE, awrite_get_sr},
    {MS_FILTER_SET_NCHANNELS, awrite_set_nch},
    {MS_FILTER_GET_NCHANNELS, awrite_get_nch},
    {0, NULL}};

static MSFilterDesc awrite_desc = {
    .id = MS_FILTER_PLUGIN_ID,
    .name = "PCMTapWriter",
    .text = "Writes received PCM to a FIFO instead of a speaker",
    .category = MS_FILTER_OTHER,
    .ninputs = 1,
    .noutputs = 0,
    .init = awrite_init,
    .process = awrite_process,
    .uninit = awrite_uninit,
    .methods = awrite_methods,
    .flags = 0,
};

/* ---- Capture side: silence ----
 * liblinphone insists on a capture filter whenever the audio stream is sendrecv, which the 2Voice
 * camera call is (the station only sends audio when offered sendrecv, like the app does). This
 * pump source keeps that graph fed with a steady 8 kHz mono s16le silence, 20 ms per block, paced
 * by the ticker; the encoder then sends silent G.711 the station ignores. The Ipercom answer stays
 * recvonly, so there the capture graph never runs. (Two-way audio would plug a microphone feed in
 * here; it is not implemented.) */
typedef struct {
  int rate;
  int nch;
  uint64_t start_ms; /* ticker time at the first process() */
  int64_t produced;  /* frames produced so far (per channel) */
} AudioSrc;

static void aread_init(MSFilter *f) {
  AudioSrc *s = ms_new0(AudioSrc, 1);
  s->rate = 8000;
  s->nch = 1;
  f->data = s;
}

static void aread_process(MSFilter *f) {
  AudioSrc *s = (AudioSrc *)f->data;
  uint64_t now = f->ticker->time;
  if (!s->start_ms) { s->start_ms = now; return; }
  const int block = s->rate / 50; /* 20 ms of frames */
  int64_t due = (int64_t)((now - s->start_ms) * (uint64_t)s->rate / 1000) - s->produced;
  if (due > s->rate / 5) { /* fell behind (ticker stall): skip rather than burst */
    s->produced += due - block;
    due = block;
  }
  while (due >= block) {
    size_t bytes = (size_t)block * 2 * (size_t)s->nch;
    mblk_t *m = allocb(bytes, 0);
    memset(m->b_wptr, 0, bytes);
    m->b_wptr += bytes;
    ms_queue_put(f->outputs[0], m);
    s->produced += block;
    due -= block;
  }
}

static void aread_uninit(MSFilter *f) { ms_free(f->data); }

static int aread_set_sr(MSFilter *f, void *a) { ((AudioSrc *)f->data)->rate = *(int *)a; return 0; }
static int aread_get_sr(MSFilter *f, void *a) { *(int *)a = ((AudioSrc *)f->data)->rate; return 0; }
static int aread_set_nch(MSFilter *f, void *a) { ((AudioSrc *)f->data)->nch = *(int *)a; return 0; }
static int aread_get_nch(MSFilter *f, void *a) { *(int *)a = ((AudioSrc *)f->data)->nch; return 0; }

static MSFilterMethod aread_methods[] = {
    {MS_FILTER_SET_SAMPLE_RATE, aread_set_sr},
    {MS_FILTER_GET_SAMPLE_RATE, aread_get_sr},
    {MS_FILTER_SET_NCHANNELS, aread_set_nch},
    {MS_FILTER_GET_NCHANNELS, aread_get_nch},
    {0, NULL}};

static MSFilterDesc aread_desc = {
    .id = MS_FILTER_PLUGIN_ID,
    .name = "PCMTapReader",
    .text = "Silence capture source (keeps a sendrecv audio graph fed), ticker-paced",
    .category = MS_FILTER_OTHER,
    .ninputs = 0,
    .noutputs = 1,
    .init = aread_init,
    .process = aread_process,
    .uninit = aread_uninit,
    .methods = aread_methods,
    .flags = MS_FILTER_IS_PUMP,
};

static const char *dir_name(LinphoneMediaDirection d) {
  switch (d) {
  case LinphoneMediaDirectionInactive: return "inactive";
  case LinphoneMediaDirectionSendOnly: return "sendonly";
  case LinphoneMediaDirectionRecvOnly: return "recvonly";
  case LinphoneMediaDirectionSendRecv: return "sendrecv";
  default: return "invalid";
  }
}

/* A minimal sound card whose writer is awrite; setting it as the playback device routes
 * liblinphone's decoded audio into our FIFO. It also advertises CAPTURE with a void-source
 * reader: liblinphone insists on a valid capture card at audio-stream setup even for a recvonly
 * answer (else "Failed to find audio device matching default input sound card" aborts the audio
 * stream); the reader is the silence source above, used when the graph does run (2Voice). */
static MSFilter *pcm_create_writer(MSSndCard *card) {
  (void)card;
  return ms_factory_create_filter_from_desc(g_factory, &awrite_desc);
}
static MSFilter *pcm_create_reader(MSSndCard *card) {
  (void)card;
  return ms_factory_create_filter_from_desc(g_factory, &aread_desc); /* silence, see above */
}
static MSSndCard *pcm_new(void);
static MSSndCard *pcm_duplicate(MSSndCard *obj) { (void)obj; return pcm_new(); }
static void pcm_detect(MSSndCardManager *m);
static MSSndCardDesc pcm_card_desc = {
    .driver_type = "PCMTap",
    .detect = pcm_detect,
    .create_reader = pcm_create_reader,
    .create_writer = pcm_create_writer,
    .duplicate = pcm_duplicate,
};
static MSSndCard *pcm_new(void) {
  MSSndCard *card = ms_snd_card_new(&pcm_card_desc);
  if (card->name) ms_free(card->name);
  card->name = ms_strdup("pcmtap");
  card->capabilities = MS_SND_CARD_CAP_PLAYBACK | MS_SND_CARD_CAP_CAPTURE;
  return card;
}
static void pcm_detect(MSSndCardManager *m) { ms_snd_card_manager_add_card(m, pcm_new()); }

/* Fire-and-forget an HTTP GET to the URL in env var `name` (if set), backgrounded (`&`) so it
 * never blocks the media loop. Used to ping the control plane: "call connected" and "please
 * cancel this call at the gateway". */
static void fire_url(const char *name) {
  const char *url = getenv(name);
  if (!url || !*url) return;
  char cmd[512];
  snprintf(cmd, sizeof cmd, "curl -fsS -m 5 '%s' >/dev/null 2>&1 &", url);
  (void)!system(cmd);
}

/* Ask the panel for an instant keyframe via a SIP INFO carrying the RFC 5168 media_control+xml
 * "picture_fast_update". A single-camera call never needs this -- the panel emits a start-of-call
 * IDR on its own -- but when TWO cameras stream at once (which the add-on allows;
 * cameras are independent) the panel does NOT reliably emit that start-of-call IDR to each stream,
 * and the tap then gates output forever waiting for one. This nudge prompts it. Sent alongside
 * liblinphone's own linphone_call_send_vfu_request() (RTCP path); the explicit INFO is what the
 * panel actually honors on its plain-AVP profile. */
static void send_pfu_info(LinphoneCall *call) {
  LinphoneCore *lc = linphone_call_get_core(call);
  LinphoneInfoMessage *info = linphone_core_create_info_message(lc);
  LinphoneContent *content = linphone_factory_create_content(linphone_factory_get());
  linphone_content_set_type(content, "application");
  linphone_content_set_subtype(content, "media_control+xml");
  static const char xml[] =
      "<?xml version=\"1.0\" encoding=\"utf-8\" ?>\r\n"
      "<media_control>\r\n <vc_primitive>\r\n  <to_encoder>\r\n"
      "   <picture_fast_update></picture_fast_update>\r\n"
      "  </to_encoder>\r\n </vc_primitive>\r\n</media_control>\r\n";
  linphone_content_set_buffer(content, (const uint8_t *)xml, sizeof(xml) - 1);
  linphone_info_message_set_content(info, content);
  linphone_call_send_info_message(call, info);
  linphone_content_unref(content);
  linphone_info_message_unref(info);
}

static LinphoneCall *g_call = NULL; /* the active call, if any */
static int g_audio_opened = 0;      /* 2Voice: the open-audio DTMF went out for this call */
static volatile sig_atomic_t g_running = 1;
static int g_max_seconds = 0;  /* RECV_SECONDS: auto-stop after this long call (0=off) */
static time_t g_stop_at = 0;
static int g_idle_seconds = 10; /* RECV_IDLE_SECONDS: hang up if no reader drains this long */
static time_t g_video_deadline = 0; /* nudge for a keyframe until this time; give up if none (0=off) */
static time_t g_last_vfu = 0;  /* last keyframe nudge, to rate-limit to ~1/s */
/* SIGUSR1: end the CURRENT call now (in-dialog BYE) but keep the process registered for the next
 * one. This is how the control plane (src/video.ts) switches/closes cameras: a clean in-dialog BYE
 * from account B to the door station (a BYE only -- no gateway cancel_call_req). */
static volatile sig_atomic_t g_hangup_req = 0;
/* SIGUSR2: a NEW reader just attached to a call that is already streaming (the control plane reused
 * the live call instead of re-calling -- the instant flip-back). Ask the panel for a keyframe so the
 * new reader decodes now rather than at the panel's next periodic IDR. */
static volatile sig_atomic_t g_vfu_req = 0;

/* 2Voice OUTGOING mode. When RECV_CALL_URI is set, instead of waiting for an inbound INVITE (the
 * IPERCOM split-account flow) we register the given account and PLACE an outgoing auto_insertion
 * audio+video call to that URI, then tap it exactly like an answered call -- the 2Voice panel sends
 * its H.264 on the auto_insertion call (the same call opendoor uses to unlock). This reuses the whole
 * tap/FIFO/keyframe/idle pipeline. Inbound mode is 100% unchanged when RECV_CALL_URI is unset. */
static char g_call_uri[256] = "";
static int g_reg_ok = 0; /* our registration reached Ok (gate for placing the outgoing call) */
static int g_placed = 0; /* placed the outgoing call already (place it exactly once) */

static void on_sigint(int _sig) { (void)_sig; g_running = 0; }
static void on_sigusr1(int _sig) { (void)_sig; g_hangup_req = 1; }
static void on_sigusr2(int _sig) { (void)_sig; g_vfu_req = 1; }

static void on_reg_state(LinphoneCore *lc, LinphoneProxyConfig *cfg,
                         LinphoneRegistrationState state, const char *message) {
  (void)lc; (void)cfg;
  rlog("[recv] registration: %s (%s)\n",
         linphone_registration_state_to_string(state), message ? message : "");
  fflush(stdout);
  if (state == LinphoneRegistrationOk) g_reg_ok = 1;
}

static void on_global_state(LinphoneCore *lc, LinphoneGlobalState state,
                            const char *message) {
  (void)lc;
  rlog("[recv] global state: %s (%s)\n",
         linphone_global_state_to_string(state), message ? message : "");
  fflush(stdout);
}

static void on_call_state(LinphoneCore *lc, LinphoneCall *call,
                          LinphoneCallState state, const char *message) {
  rlog("[recv] call state: %s\n", linphone_call_state_to_string(state));
  fflush(stdout);
  switch (state) {
  case LinphoneCallIncomingReceived: {
    if (g_call_uri[0]) {
      /* 2Voice OUTGOING mode: we place our own call; never answer an inbound INVITE (a doorbell
       * ring forked to this registration -- the Node doorbell listener handles rings). */
      rlog("[recv] ignoring inbound INVITE (outgoing mode)\n");
      fflush(stdout);
      break;
    }
    /* ONE call at a time. If a call is still up, the control plane failed to end it before placing
     * the next one (it waits for our RECV_ENDED_URL ping, so this should not happen). Accepting
     * would make liblinphone PAUSE the live call: the panel then holds a zombie on-hold call that
     * blocks every later camera request until its session timer expires (minutes). Decline
     * instead, loudly -- a failed view is recoverable, a zombie call is not. */
    if (g_call) {
      rlog("[recv] DECLINING inbound INVITE: a call is already up (control plane did not BYE it)\n");
      fflush(stdout);
      linphone_call_decline(call, LinphoneReasonBusy);
      break;
    }
    /* Diagnostic: which physical panel (INVITE From = its topological code) is calling which of
     * our streams (identified by the H264 FIFO). If a stream's recv ever answers an INVITE From
     * the WRONG panel, the gateway/panel crossed the split-account routing (the feed-swap bug). */
    const LinphoneAddress *from = linphone_call_get_remote_address(call);
    const char *fromu = from ? linphone_address_get_username(from) : NULL;
    const char *outfifo = getenv("RECV_H264_OUT");
    rlog("[recv] INVITE FROM %s -> stream %s\n",
           fromu ? fromu : "?", outfifo ? outfifo : "?");
    {
      const LinphoneCallParams *rp = linphone_call_get_remote_params(call);
      rlog("[recv] panel's audio offer: %s\n",
             rp ? dir_name(linphone_call_params_get_audio_direction(rp)) : "?");
    }
    rlog("[recv] incoming call -> answering (audio+video recvonly, H264 tap + PCM tap)\n");
    fflush(stdout);
    LinphoneCallParams *p = linphone_core_create_call_params(lc, call);
    linphone_call_params_enable_audio(p, TRUE);
    linphone_call_params_set_audio_direction(p, LinphoneMediaDirectionRecvOnly);
    linphone_call_params_enable_video(p, TRUE);
    linphone_call_params_set_video_direction(p, LinphoneMediaDirectionRecvOnly);
    linphone_call_accept_with_params(call, p);
    linphone_call_params_unref(p);
    g_call = call;
    g_keyframe_seen = 0; /* reset per call; gate output until this call's first IDR (tap `started`) */
    break;
  }
  case LinphoneCallStreamsRunning: {
    rlog("[recv] streams running -> tapping H264\n");
    {
      const LinphoneCallParams *cp = linphone_call_get_current_params(call);
      const LinphoneCallParams *rp = linphone_call_get_remote_params(call);
      rlog("[recv] negotiated audio direction: %s (remote %s), video %s\n",
             cp ? dir_name(linphone_call_params_get_audio_direction(cp)) : "?",
             rp ? dir_name(linphone_call_params_get_audio_direction(rp)) : "?",
             cp ? dir_name(linphone_call_params_get_video_direction(cp)) : "?");
    }
    /* 2Voice (outgoing) camera call: the station keeps the audio closed until the viewer "opens"
     * it. The app does that with an in-call DTMF '4' (UCFCallManager.OPEN_AUDIO_DTMF, sent from
     * executeOpenAutoinsertionAudio once StreamsRunning) -- '1'/'2' being door/gate and '3' the
     * next camera. Send it once per call, right here, like opendoor sends the door digit.
     * RECV_OPEN_AUDIO_DTMF overrides the digit; empty disables. */
    if (g_call_uri[0] && !g_audio_opened) {
      const char *d = getenv("RECV_OPEN_AUDIO_DTMF");
      char digit = d ? d[0] : '4';
      g_audio_opened = 1;
      if (digit) {
        LinphoneStatus st = linphone_call_send_dtmf(call, digit);
        rlog("[recv] open-audio DTMF '%c' sent (SIP INFO) -> %s\n", digit,
               st == 0 ? "ok" : "FAILED");
      }
    }
    fflush(stdout);
    /* Do NOT start the reader-idle clock yet. With tap-gating we write NOTHING until the first
     * keyframe, so counting this pre-keyframe wait as "no reader" would tear the call down before
     * it ever streams (esp. with a short RECV_IDLE_SECONDS). The idle clock starts on the first
     * actual write (tap_write, or when g_keyframe_seen fires in the main loop). */
    g_last_drain = 0;
    if (g_max_seconds > 0) g_stop_at = time(NULL) + g_max_seconds;
    /* Open the keyframe-nudge window: the main loop sends VFU + picture_fast_update ~1/s until the
     * tap sees an IDR (needed when two cameras stream at once -- the panel doesn't reliably emit a
     * start-of-call IDR to each), or this deadline closes and we give up so go2rtc retries from a
     * clean state instead of holding a black channel. */
    g_video_deadline = time(NULL) + 12;
    g_last_vfu = 0;
    /* Tell the control plane the call actually connected, so it can tell "streaming" apart from
     * "panel never sent an INVITE" (busy / monitor not remote). */
    fire_url("RECV_CONNECTED_URL");
    break;
  }
  case LinphoneCallEnd:
  case LinphoneCallError: {
    rlog("[recv] call ended: %s\n", message ? message : "");
    /* One line of audio RTP accounting per call: "recv 0 pkts" = the panel never sent audio
     * (SIP/direction problem); packets in but a silent tap = a decode/routing problem. */
    LinphoneCallStats *st = linphone_call_get_audio_stats(call);
    if (st) {
      const rtp_stats_t *r = linphone_call_stats_get_rtp_stats(st);
      rlog("[recv] audio rtp totals: recv %llu pkts (%llu B), sent %llu pkts\n",
             (unsigned long long)r->packet_recv, (unsigned long long)r->recv,
             (unsigned long long)r->packet_sent);
      linphone_call_stats_unref(st);
    }
    fflush(stdout);
    if (g_call == call) g_call = NULL;
    g_last_drain = 0;
    g_stop_at = 0;
    g_video_deadline = 0;
    /* Tell the control plane the dialog is really over (our BYE was answered, or the panel hung
     * up). A camera SWITCH waits for this before placing the next call, like the app does (BYE ->
     * 200 OK -> next call_device_req), instead of racing the BYE with the new request. */
    fire_url("RECV_ENDED_URL");
    /* Inbound (IPERCOM): stay registered for the next call. Outgoing (2Voice on-demand): our one
     * call ended (viewer left / idle) -> exit so the control plane respawns us on the next view. */
    if (g_call_uri[0]) {
      rlog("[recv] outgoing call ended -> exiting\n");
      fflush(stdout);
      g_running = 0;
    }
    break;
  }
  case LinphoneCallPausedByRemote:
  case LinphoneCallUpdatedByRemote:
  case LinphoneCallPaused:
  case LinphoneCallResuming:
  case LinphoneCallUpdating: {
    /* Direction changes mid-call are the interesting part on 2Voice (the station re-INVITEs), so
     * say what the remote is now offering. liblinphone accepts remote updates on its own. */
    const LinphoneCallParams *rp = linphone_call_get_remote_params(call);
    rlog("[recv]   remote now offers audio %s, video %s\n",
           rp ? dir_name(linphone_call_params_get_audio_direction(rp)) : "?",
           rp ? dir_name(linphone_call_params_get_video_direction(rp)) : "?");
    fflush(stdout);
    break;
  }
  default:
    break;
  }
}

int main(int argc, char **argv) {
  if (argc < 3) {
    fprintf(stderr,
            "usage: %s <B-username> <B-password>\n"
            "  env (set by src/video.ts): RECV_H264_OUT=<fifo> (default /tmp/cam.h264), "
            "RECV_AUDIO_OUT=<fifo> (default /tmp/cam_audio.pcm; s16le 8k mono), "
            "RECV_DATA_DIR=<dir> (per-recv, MUST be unique), "
            "RECV_UUID=<uuid> (stable +sip.instance id so a restart replaces our binding), "
            "RECV_HANGUP_URL=<url> (gateway cancel on idle), "
            "RECV_CONNECTED_URL=<url> (pinged at StreamsRunning), "
            "RECV_OPEN_AUDIO_DTMF=<digit> (2Voice: in-call digit that opens the station's audio, "
            "default 4; empty = none), "
            "RECV_ENDED_URL=<url> (pinged when the call is over), "
            "RECV_IDLE_SECONDS=<n> (default 10)\n"
            "  dev-only: RECV_SECONDS=<n> (auto-stop), RECV_DEBUG=1 (SIP trace)\n",
            argv[0]);
    return 2;
  }
  const char *user = argv[1];
  const char *pass = argv[2];
  if (getenv("RECV_SECONDS")) g_max_seconds = atoi(getenv("RECV_SECONDS"));
  if (getenv("RECV_IDLE_SECONDS")) g_idle_seconds = atoi(getenv("RECV_IDLE_SECONDS"));
  { /* 2Voice: outgoing auto_insertion call target (empty -> inbound/IPERCOM mode) */
    const char *cu = getenv("RECV_CALL_URI");
    if (cu && *cu) snprintf(g_call_uri, sizeof g_call_uri, "%s", cu);
  }
  load_black_frame(); /* canned keyframe for early track advertisement (see g_black) */

  const char *domain = "sip.urmet.com";
  const char *server = "sip:sip.urmet.com:5061;transport=tls";

  signal(SIGINT, on_sigint);
  signal(SIGTERM, on_sigint);
  signal(SIGUSR1, on_sigusr1); /* control plane: hang up the current call, stay registered */
  signal(SIGUSR2, on_sigusr2); /* control plane: new reader on the live call -> request a keyframe */

  LinphoneFactory *factory = linphone_factory_get();

  if (getenv("RECV_DEBUG")) {
    LinphoneLoggingService *ls = linphone_logging_service_get();
    linphone_logging_service_set_log_level(ls, LinphoneLogLevelDebug);
  }

  /* Give liblinphone writable dirs; otherwise it errors opening its sqlite DB, which can
   * stall the core's global-state transition (and thus registration) in a container. Each
   * recv instance MUST use its OWN dir (RECV_DATA_DIR): two cores sharing one sqlite DB/config
   * corrupt each other's account state ("No account found for local address"). */
  const char *datadir = getenv("RECV_DATA_DIR");
  if (!datadir || !*datadir) datadir = "/tmp/lp";
  linphone_factory_set_data_dir(factory, datadir);
  linphone_factory_set_config_dir(factory, datadir);
  linphone_factory_set_cache_dir(factory, datadir);

  /* NULL config paths -> in-memory config (nothing persisted). */
  LinphoneCore *lc = linphone_factory_create_core_3(factory, NULL, NULL, NULL);

  LinphoneCoreCbs *cbs = linphone_factory_create_core_cbs(factory);
  linphone_core_cbs_set_call_state_changed(cbs, on_call_state);
  linphone_core_cbs_set_registration_state_changed(cbs, on_reg_state);
  linphone_core_cbs_set_global_state_changed(cbs, on_global_state);
  linphone_core_add_callbacks(lc, cbs);
  linphone_core_cbs_unref(cbs);

  /* Use the expected User-Agent (harmless inbound; the 2Voice station may gate outgoing calls on it). */
  linphone_core_set_user_agent(lc, "UrmetCallForwarding-Android", NULL);
  /* DTMF as SIP INFO, not RFC 2833 -- what the 2Voice station expects (same as opendoor.c). Used
   * for the open-audio digit on the 2Voice camera call (see on_call_state StreamsRunning). */
  linphone_core_set_use_info_for_dtmf(lc, TRUE);
  linphone_core_set_use_rfc2833_for_dtmf(lc, FALSE);

  /* A fresh in-memory core has TLS transport disabled (tls_port=0), so a transport=tls
   * REGISTER never binds a channel. Enable TLS on a random port; drop UDP/TCP. */
  LinphoneTransports *tr = linphone_factory_create_transports(factory);
  linphone_transports_set_udp_port(tr, 0);
  linphone_transports_set_tcp_port(tr, 0);
  linphone_transports_set_tls_port(tr, -1 /* LC_SIP_TRANSPORT_RANDOM */);
  linphone_core_set_transports(lc, tr);
  linphone_transports_unref(tr);

  /* Video: we only RECEIVE. But if BOTH capture and display are disabled, liblinphone
   * answers the video stream INACTIVE and never builds the receive graph (so nothing to
   * record). Enable both so the stream activates, and route display to MSExtDisplay - a
   * headless sink that opens no X window. The answer is forced recvonly below, so the
   * (absent) camera is never used. */
  linphone_core_enable_video_capture(lc, TRUE);
  linphone_core_enable_video_display(lc, TRUE);
  linphone_core_set_video_display_filter(lc, "MSExtDisplay");

  /* Register our H264 tap as the decoder. openh264 stays installed so H264 is negotiable
   * (codec support needs enc+dec); ms_factory_register_filter prepends, so our decoder wins
   * the H264 decoder lookup and receives the RTP. */
  g_factory = linphone_core_get_ms_factory(lc);
  ms_factory_register_filter(g_factory, &tap_desc);

  /* Register the PCM-tap sound card so we can route the decoded audio to a FIFO (set as the
   * playback device after start(), once card detection has run). */
  ms_snd_card_manager_register_desc(ms_factory_get_snd_card_manager(g_factory), &pcm_card_desc);

  LinphoneVideoActivationPolicy *vap =
      linphone_factory_create_video_activation_policy(factory);
  linphone_video_activation_policy_set_automatically_accept(vap, TRUE);
  /* Outgoing (2Voice) offers video; inbound (IPERCOM) only accepts it. */
  linphone_video_activation_policy_set_automatically_initiate(vap, g_call_uri[0] ? TRUE : FALSE);
  linphone_core_set_video_activation_policy(lc, vap);
  linphone_video_activation_policy_unref(vap);

  /* The panel's TLS cert chain isn't ours to validate; don't block the spike on it. */
  linphone_core_verify_server_certificates(lc, FALSE);
  linphone_core_verify_server_cn(lc, FALSE);

  /* STABLE RFC 5626 instance id (same fix as opendoor.c). liblinphone stores its `+sip.instance`
   * UUID in `[misc] uuid` and mints a random one when it is absent -- and our config lives in a
   * per-recv /tmp dir the container wipes, so each restart/recall registered a NEW binding on the
   * account instead of replacing the old one. On the shared 2Voice account (also holding opendoor +
   * phones) those stale bindings linger for the full expiry and the registrar forks calls to them.
   * RECV_UUID is a caller-supplied deterministic id (distinct from opendoor's), set BEFORE start. */
  const char *rid = getenv("RECV_UUID");
  if (rid && *rid)
    linphone_config_set_string(linphone_core_get_config(lc), "misc", "uuid", rid);

  linphone_core_start(lc);

  /* Route decoded audio to our PCM-tap card (reload so detection picks up the registered desc,
   * then match by name in the device id string "PCMTap: pcmtap"). */
  {
    linphone_core_reload_sound_devices(lc); /* rebuild liblinphone's list incl. our card */
    const char **snd = linphone_core_get_sound_devices(lc);
    for (int i = 0; snd && snd[i]; i++) {
      if (strstr(snd[i], "pcmtap")) {
        linphone_core_set_playback_device(lc, snd[i]);
        linphone_core_set_capture_device(lc, snd[i]); /* our silence source (runs only on a sendrecv call) */
        rlog("[recv] audio devices -> %s (playback + capture)\n", snd[i]);
        fflush(stdout);
        break;
      }
    }
  }

  /* Force a single audio codec family so the tapped PCM format is DETERMINISTIC. The panel
   * offers both Opus (48 kHz stereo) and G.711 (8 kHz mono) and liblinphone picks a different
   * one per call; a shifting rate/channel layout makes a raw-PCM tap unusable. Keep only G.711
   * (PCMU/PCMA = 8 kHz mono) -- telephone quality, but rock-solid and ample for a doorbell. */
  {
    bctbx_list_t *pts = linphone_core_get_audio_payload_types(lc);
    for (bctbx_list_t *it = pts; it; it = it->next) {
      LinphonePayloadType *pt = (LinphonePayloadType *)it->data;
      const char *mime = linphone_payload_type_get_mime_type(pt);
      int keep = mime && (strcasecmp(mime, "PCMU") == 0 || strcasecmp(mime, "PCMA") == 0);
      linphone_payload_type_enable(pt, keep);
      if (keep) { rlog("[recv] audio codec kept: %s\n", mime); fflush(stdout); }
    }
    bctbx_list_free(pts); /* free the list nodes only (safe across liblinphone ownership quirks) */
  }

  /* Auth + registration for account B (the dedicated cfwunique_ account). */
  LinphoneAuthInfo *ai = linphone_factory_create_auth_info(
      factory, user, NULL /*userid*/, pass, NULL /*ha1*/, NULL /*realm*/, domain);
  linphone_core_add_auth_info(lc, ai);
  linphone_auth_info_unref(ai);

  char identity[256];
  snprintf(identity, sizeof identity, "sip:%s@%s", user, domain);
  LinphoneAccountParams *ap = linphone_core_create_account_params(lc);
  LinphoneAddress *id_addr = linphone_factory_create_address(factory, identity);
  linphone_account_params_set_identity_address(ap, id_addr);
  linphone_account_params_set_server_addr(ap, server);
  linphone_account_params_set_register_enabled(ap, TRUE);
  LinphoneAccount *account = linphone_core_create_account(lc, ap);
  linphone_core_add_account(lc, account);
  linphone_core_set_default_account(lc, account);
  linphone_address_unref(id_addr);
  linphone_account_params_unref(ap);
  linphone_account_unref(account);

  rlog("[recv] registering %s over %s ...\n", identity, server);
  fflush(stdout);

  while (g_running) {
    linphone_core_iterate(lc);
    usleep(50 * 1000);
    /* 2Voice OUTGOING mode: once registered, place the auto_insertion audio+video call (recvonly)
     * to the OUT account and tap it like an answered call. Placed exactly once; the process exits
     * when the call ends (see on_call_state End). Uses the same auto_insertion offer as opendoor. */
    if (g_call_uri[0] && g_reg_ok && !g_placed && !g_call) {
      g_placed = 1;
      LinphoneFactory *f2 = linphone_factory_get();
      LinphoneAddress *to = linphone_factory_create_address(f2, g_call_uri);
      LinphoneCallParams *p = linphone_core_create_call_params(lc, NULL);
      linphone_call_params_enable_audio(p, TRUE);
      /* Audio SENDRECV, as the app offers it (UCFCallManager.inviteAddress never touches the audio
       * direction). Offering recvonly made the station answer sendonly, which liblinphone reports
       * as PausedByRemote right after Connected, and the station then never sent audio RTP (the
       * "video works, PCM is silence" report on 2Voice). Our capture side is silence, so the
       * station just gets silent G.711 from us. */
      linphone_call_params_set_audio_direction(p, LinphoneMediaDirectionSendRecv);
      linphone_call_params_enable_video(p, TRUE);
      linphone_call_params_set_video_direction(p, LinphoneMediaDirectionRecvOnly);
      if (linphone_core_media_encryption_supported(lc, LinphoneMediaEncryptionSRTP))
        linphone_call_params_set_media_encryption(p, LinphoneMediaEncryptionSRTP);
      /* Header matches the app's camera call (callCCTV), which differs from the door call: a phase-B
       * 58A station wants the `mac` header (and rejects auto_insertion with 486), while a cloud-listed
       * 2Voice station gets NO custom header at all -- NOT `auto_insertion` (that's the door path).
       * RECV_MAC carries the colon-form MAC for phase-B; unset -> cloud-listed -> no header. */
      const char *mac = getenv("RECV_MAC");
      if (mac && *mac) linphone_call_params_add_custom_header(p, "mac", mac);
      g_keyframe_seen = 0; /* gate output until this call's first IDR */
      g_audio_opened = 0;
      g_call = to ? linphone_core_invite_address_with_params(lc, to, p) : NULL;
      linphone_call_params_unref(p);
      if (to) linphone_address_unref(to);
      rlog("[recv] 2Voice video call placed (header: %s) -> %s\n",
             (mac && *mac) ? "mac" : "none", g_call_uri);
      fflush(stdout);
    }
    /* Control plane asked us to end the current call (camera switch / viewer closed). Terminate
     * the dialog -- liblinphone sends the in-dialog BYE to the door station -- and stay registered.
     * Do NOT fire RECV_HANGUP_URL here: the control plane initiated this, and pinging it back would
     * loop. The natural reader-idle timeout still covers the case where the viewer just vanishes. */
    if (g_hangup_req) {
      g_hangup_req = 0;
      if (g_call) {
        rlog("[recv] SIGUSR1 -> terminating current call (in-dialog BYE)\n");
        fflush(stdout);
        linphone_call_terminate(g_call);
        g_last_drain = 0;
        g_video_deadline = 0;
      } else {
        rlog("[recv] SIGUSR1 with no call up -> nothing to end\n");
        fflush(stdout);
      }
    }
    /* A reader re-attached to the live call (flip-back): one keyframe nudge so it decodes at once. */
    if (g_vfu_req) {
      g_vfu_req = 0;
      if (g_call) {
        linphone_call_send_vfu_request(g_call);
        send_pfu_info(g_call);
        rlog("[recv] SIGUSR2 -> keyframe requested for the re-attached reader\n");
        fflush(stdout);
      }
    }
    /* Nudge for a keyframe until the tap reports an IDR. Needed when two cameras stream at once:
     * the panel doesn't reliably emit a start-of-call IDR to each, and without the nudge the tap
     * gates output forever (black, then a give-up hangup). On the IDR, start the reader-idle clock.
     * If none arrives within the window, give up so go2rtc retries from a clean state instead of
     * holding a black channel (nothing was written, so the idle clock never started on its own). */
    if (g_call && g_video_deadline) {
      time_t now = time(NULL);
      if (g_keyframe_seen) {
        rlog("[recv] keyframe received -> video started\n");
        fflush(stdout);
        g_video_deadline = 0;
        if (!g_last_drain) g_last_drain = now;
      } else if (now >= g_video_deadline) {
        rlog("[recv] no keyframe within window -> hanging up (panel busy?)\n");
        fflush(stdout);
        g_video_deadline = 0;
        linphone_call_terminate(g_call);
        fire_url("RECV_HANGUP_URL");
      } else if (now != g_last_vfu) { /* rate-limit to ~1/s */
        g_last_vfu = now;
        linphone_call_send_vfu_request(g_call); /* liblinphone's RTCP path */
        send_pfu_info(g_call);                  /* explicit SIP INFO media_control+xml (what lands) */
        rlog("[recv] requesting keyframe (VFU + INFO) -- no IDR yet\n");
        fflush(stdout);
      }
    }
    /* End the call (stay registered for the next one) only when NO reader has drained the
     * FIFO for g_idle_seconds -- i.e. the viewer is really gone, not just a go2rtc probe /
     * WebRTC reconnect blip. This is what keeps a live view from dying at the first reader
     * gap. A SIP BYE alone won't free the door station's channel, so also ask the control
     * plane to send the gateway cancel_call_req. */
    if (g_call && g_last_drain && time(NULL) - g_last_drain >= g_idle_seconds) {
      rlog("[recv] no FIFO reader for %ds -> hanging up\n", g_idle_seconds);
      fflush(stdout);
      linphone_call_terminate(g_call);
      g_last_drain = 0;
      fire_url("RECV_HANGUP_URL");
    }
    /* With RECV_DEBUG, the audio RTP/RTCP counters every 5 s: packet_recv rising = the panel's
     * audio arrives (a silent tap is then a decode problem); rtcp in with a non-zero RTT = the
     * panel's stack sees our stream. */
    if (g_call && getenv("RECV_DEBUG")) {
      static time_t last_stats = 0;
      time_t now = time(NULL);
      if (now - last_stats >= 5) {
        last_stats = now;
        LinphoneCallStats *st = linphone_call_get_audio_stats(g_call);
        if (st) {
          const rtp_stats_t *r = linphone_call_stats_get_rtp_stats(st);
          rlog("[recv] audio rtp: sent %llu pkts, recv %llu pkts, rtcp in %llu, rtt %.0f ms, "
                 "sender loss %.1f%%\n",
                 (unsigned long long)r->packet_sent, (unsigned long long)r->packet_recv,
                 (unsigned long long)r->recv_rtcp_packets,
                 linphone_call_stats_get_round_trip_delay(st) * 1000.0,
                 linphone_call_stats_get_sender_loss_rate(st));
          fflush(stdout);
          linphone_call_stats_unref(st);
        }
      }
    }
    if (g_call && g_stop_at && time(NULL) >= g_stop_at) {
      rlog("[recv] reached RECV_SECONDS=%d -> hanging up\n", g_max_seconds);
      fflush(stdout);
      linphone_call_terminate(g_call);
      g_stop_at = 0;
    }
  }

  /* Hang up cleanly (BYE) so the door station frees the video channel; otherwise it stays
   * "busy" and won't ring again until its session timer expires. */
  if (g_call) {
    rlog("[recv] terminating active call (BYE)\n");
    linphone_call_terminate(g_call);
    for (int i = 0; i < 40 && g_call; i++) { /* pump iterate so the BYE actually goes out */
      linphone_core_iterate(lc);
      usleep(25 * 1000);
    }
  }
  rlog("[recv] shutting down\n");
  fflush(stdout);
  linphone_core_stop(lc);
  linphone_core_unref(lc);
  return 0;
}
