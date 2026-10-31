/*
 * talkout.h - announcement ("talk-out") audio input, shared by opendoor.c and recv.c.
 *
 * The control plane (src/announce.ts) plays a clip into a per-place FIFO as raw s16le PCM at the
 * call's rate (8 kHz mono: G.711 is forced in both helpers). Whichever helper holds the call to the
 * station feeds it to the station from its capture filter, in place of the silence it would send:
 * a short read is zero-filled, so RTP keeps flowing at the same pace whether or not a clip is
 * playing (opendoor relies on that steady RTP for its fast DTMF cut-through).
 *
 * The FIFO is opened O_RDWR|O_NONBLOCK when the call's audio graph starts (we also hold a write end,
 * so a writer coming and going never reads as EOF) and closed when it stops. A writer still feeding
 * a call that ended then gets EPIPE, so nothing stale is left over to play on the next call.
 *
 * Diagnostics: the reader splits what it receives into clips (audio after >= TALK_GAP_MS of none)
 * and logs each one: when it started relative to the call audio, a level line per second while it
 * plays, and a summary at the end (audio sent, peak level, clipping, dropouts -- gaps where the
 * writer fed the FIFO slower than real time). That tells "the station got nothing" apart from "the
 * station got a clip, but quiet / clipped / choppy". All of it runs on the mediastreamer ticker
 * thread; g_talk_active / g_talk_last_ms let the helper's main loop follow along.
 *
 * Header-only on purpose: each helper is a single-file build (see ../Dockerfile and CI).
 */
#ifndef TALKOUT_H
#define TALKOUT_H

#include <errno.h>
#include <fcntl.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#define TALK_GAP_MS 1000    /* no audio this long = the clip ended (shorter gaps are dropouts) */
#define TALK_REPORT_MS 1000 /* level line cadence while a clip plays */

typedef void (*talk_log_fn)(const char *fmt, ...);

/* For the helper's main loop: a clip is playing / monotonic ms of its last audio block. */
static volatile int g_talk_active = 0;
static volatile long long g_talk_last_ms = 0;
static volatile long g_talk_clips = 0; /* clips finished so far (the main loop logs RTP per clip) */

static long long talk_now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

typedef struct {
  int fd;
  int has_carry; /* odd byte left over from the last read (keeps samples aligned) */
  uint8_t carry;
  const char *tag;
  talk_log_fn log;
  char path[256];
  long long opened_at; /* graph start (FIFO opened) */
  /* current clip */
  int active;
  long long clip_start, last_audio, last_report;
  long long bytes;   /* audio bytes this clip */
  long blocks;       /* blocks carrying audio */
  long short_blocks; /* blocks only partly filled (writer briefly behind) */
  long gaps;         /* dropouts: runs of empty blocks inside the clip */
  long long gap_start, longest_gap;
  long clipped;      /* samples at full scale */
  int peak;          /* |sample| max this clip */
  long skipped_ms;   /* ticker stalls the caller skipped over while the clip played */
  /* per-report window */
  int win_peak;
  double win_sumabs;
  long win_samp, win_short, win_gaps;
} TalkIn;

static void talkin_init(TalkIn *t, const char *tag, talk_log_fn log) {
  memset(t, 0, sizeof *t);
  t->fd = -1;
  t->tag = tag;
  t->log = log;
}

/* Open the FIFO named by env var `env` (unset/empty = no announcements: plain silence). */
static void talkin_open(TalkIn *t, const char *env, int rate, int nch) {
  const char *p = getenv(env);
  t->opened_at = talk_now_ms();
  if (!p || !*p) return;
  snprintf(t->path, sizeof t->path, "%s", p);
  t->fd = open(t->path, O_RDWR | O_NONBLOCK);
  if (t->fd >= 0)
    t->log("[%s] talk-out: listening on %s (%d Hz, %d ch, s16le)\n", t->tag, t->path, rate, nch);
  else
    t->log("[%s] talk-out: cannot open %s (%s) -- announcements will not play on this call\n",
           t->tag, t->path, strerror(errno));
  fflush(stdout);
}

static int talk_pct(int v) { return (int)((long)v * 100 / 32768); }

static void talkin_end_clip(TalkIn *t, int rate, int nch, const char *why) {
  if (!t->active) return;
  const long audio_ms = (long)(t->bytes * 1000 / (2LL * rate * nch));
  const long wall_ms = (long)(t->last_audio - t->clip_start) + 20;
  t->log("[%s] talk-out: clip ended (%s): %ld ms of audio over %ld ms, %lld B in %ld blocks; "
         "peak %d%% of full scale, %ld clipped samples; %ld dropouts (longest %lld ms), "
         "%ld short blocks, %ld ms skipped on ticker stalls\n",
         t->tag, why, audio_ms, wall_ms, t->bytes, t->blocks, talk_pct(t->peak), t->clipped,
         t->gaps, t->longest_gap, t->short_blocks, t->skipped_ms);
  if (t->peak < 1638) /* < 5% */
    t->log("[%s] talk-out: the clip is very quiet (peak under 5%%); the station may be inaudible\n",
           t->tag);
  if (t->clipped > 0)
    t->log("[%s] talk-out: the clip clips (%ld samples at full scale); expect distortion\n",
           t->tag, t->clipped);
  if (t->gaps > 0)
    t->log("[%s] talk-out: the source fed the FIFO slower than real time %ld time(s); "
           "the station heard silence in between\n", t->tag, t->gaps);
  fflush(stdout);
  t->active = 0;
  g_talk_active = 0;
  g_talk_clips++;
}

/* Fill buf (bytes, a whole number of frames) from the FIFO, zero-filling what is missing, and keep
 * the clip diagnostics. Returns the bytes of real audio. */
static size_t talkin_fill(TalkIn *t, uint8_t *buf, size_t bytes, int rate, int nch) {
  memset(buf, 0, bytes);
  if (t->fd < 0) return 0;
  size_t got = 0;
  if (t->has_carry) { buf[got++] = t->carry; t->has_carry = 0; }
  ssize_t n = read(t->fd, buf + got, bytes - got);
  if (n > 0) got += (size_t)n;
  if (got & 1) { t->carry = buf[--got]; t->has_carry = 1; buf[got] = 0; }
  const long long now = talk_now_ms();

  if (got == 0) {
    if (!t->active) return 0;
    if (now - t->last_audio >= TALK_GAP_MS) {
      t->gap_start = 0; /* the trailing silence is the end, not a dropout */
      talkin_end_clip(t, rate, nch, "source finished");
      return 0;
    }
    if (!t->gap_start) t->gap_start = now; /* a dropout only if audio resumes (counted below) */
    return 0;
  }

  if (!t->active) {
    memset(&t->bytes, 0, sizeof *t - offsetof(TalkIn, bytes)); /* reset clip + window stats */
    t->active = 1;
    t->clip_start = t->last_report = now;
    g_talk_active = 1;
    t->log("[%s] talk-out: clip started, %lld ms after this call's audio began\n", t->tag,
           now - t->opened_at);
    fflush(stdout);
  } else if (t->gap_start) {
    const long long g = now - t->gap_start;
    if (g > t->longest_gap) t->longest_gap = g;
    t->gap_start = 0;
    t->gaps++;
    t->win_gaps++;
  }
  t->last_audio = now;
  g_talk_last_ms = now;
  t->bytes += (long long)got;
  t->blocks++;
  if (got < bytes) { t->short_blocks++; t->win_short++; }
  const int16_t *s = (const int16_t *)buf;
  for (size_t i = 0; i < got / 2; i++) {
    int v = s[i] < 0 ? -(int)s[i] : s[i];
    if (v >= 32767) t->clipped++;
    if (v > t->peak) t->peak = v;
    if (v > t->win_peak) t->win_peak = v;
    t->win_sumabs += v;
  }
  t->win_samp += (long)(got / 2);

  if (now - t->last_report >= TALK_REPORT_MS) {
    t->log("[%s] talk-out: +%.1fs playing: %ld ms this second, peak %d%%, avg %d%%, "
           "%ld short blocks, %ld dropouts\n",
           t->tag, (now - t->clip_start) / 1000.0, (long)(t->win_samp * 1000 / (rate * nch)),
           talk_pct(t->win_peak),
           t->win_samp ? talk_pct((int)(t->win_sumabs / t->win_samp)) : 0, t->win_short,
           t->win_gaps);
    fflush(stdout);
    t->last_report = now;
    t->win_peak = 0;
    t->win_sumabs = 0;
    t->win_samp = t->win_short = t->win_gaps = 0;
  }
  return got;
}

/* The caller skipped `ms` of frames on a ticker stall (it does not burst to catch up). */
static void talkin_note_skip(TalkIn *t, long ms) {
  if (!t->active) return;
  t->skipped_ms += ms;
  t->log("[%s] talk-out: ticker stalled, skipped %ld ms of the clip\n", t->tag, ms);
  fflush(stdout);
}

/* The call's audio graph stopped: close the FIFO (a writer still going gets EPIPE). */
static void talkin_close(TalkIn *t, int rate, int nch) {
  talkin_end_clip(t, rate, nch, "cut short: the call's audio stopped");
  if (t->fd >= 0) {
    close(t->fd);
    t->fd = -1;
    t->log("[%s] talk-out: stopped listening on %s\n", t->tag, t->path);
    fflush(stdout);
  }
}

#endif /* TALKOUT_H */
