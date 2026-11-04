/* SPDX-License-Identifier: GPL-3.0-or-later (links liblinphone, GPLv3) */
/*
 * lpcommon.h - the liblinphone setup both helpers share: recv.c (the Ipercom camera receiver) and
 * station.c (the 2Voice station helper). Header-only, one includer per binary (like talkout.h and
 * h264tap.h, which this header pulls in).
 *
 * Before including, the includer defines:
 *   TAP_LOG(fmt, ...)          its log function (also used by h264tap.h)
 *   static void lp_atap_target(char *out, size_t outsz)   -- defined AFTER the include is fine --
 *                              the PCM FIFO the audio tap writes this call's decoded audio to
 *                              ("" = discard)
 *   static int lp_atap_adopt;  1 = re-ask lp_atap_target while the path is still empty (the
 *                              station learns the camera FIFO mid-call); 0 = ask once at graph start
 * and sets lp_talk_env to the env var naming the announcement FIFO before the core starts.
 *
 * What lives here:
 *   - the PCM-tap sound card: a PLAYBACK writer that dumps the decoded audio (s16le) to a FIFO with
 *     atomic writes and level diagnostics, and a CAPTURE reader that pumps ticker-paced silence, or
 *     an announcement clip from the talk FIFO (talkout.h)
 *   - lp_create_core(): data dirs, callbacks, User-Agent, DTMF as SIP INFO, TLS-only transport,
 *     headless video, the H.264 tap registered as the decoder, the video policy, certificate policy,
 *     the stable +sip.instance id, start, the sound card as the device, G.711 forced, and the account
 *   - lp_wait_registered(): pump the core until the registration settles
 * Everything here was duplicated line for line between the two helpers before (2026-11).
 */
#ifndef URMET_LPCOMMON_H
#define URMET_LPCOMMON_H

#include <linphone/core.h>
#include <mediastreamer2/msfilter.h>
#include <mediastreamer2/msfactory.h>
#include <mediastreamer2/msqueue.h>
#include <mediastreamer2/mssndcard.h>
#include <ortp/str_utils.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <unistd.h>
#include "talkout.h"
#include "h264tap.h"

#ifndef TAP_LOG
#error "define TAP_LOG before including lpcommon.h"
#endif

/* The SIP realm/registrar. The cloud reports it per account (sip.urmet.com in production); the
 * control plane passes it through so dev/preprod realms need no rebuild. */
static const char *lp_realm(void) {
  const char *r = getenv("SIP_REALM");
  return (r && *r) ? r : "sip.urmet.com";
}

static MSFactory *g_factory = NULL;        /* stashed for the sound-card filter factories */
static const char *lp_talk_env = NULL;     /* env var naming the announcement FIFO (talkout.h) */
static int lp_atap_adopt = 0;              /* see the header comment */
static void lp_atap_target(char *out, size_t outsz);

static const char *dir_name(LinphoneMediaDirection d) {
  switch (d) {
  case LinphoneMediaDirectionInactive: return "inactive";
  case LinphoneMediaDirectionSendOnly: return "sendonly";
  case LinphoneMediaDirectionRecvOnly: return "recvonly";
  case LinphoneMediaDirectionSendRecv: return "sendrecv";
  default: return "invalid";
  }
}

/* Ask the panel for an instant keyframe via a SIP INFO carrying the RFC 5168 media_control+xml
 * "picture_fast_update". Sent alongside liblinphone's own linphone_call_send_vfu_request() (RTCP path);
 * the explicit INFO is what the panel actually honors on its plain-AVP profile. A single camera call
 * usually keyframes at call start on its own, but not always (two Ipercom cameras at once, a 2Voice
 * panel switch), and without the nudge the tap gates output forever (black). */
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

/* ---- Audio tap: liblinphone decodes the received audio to PCM; this minimal mediastreamer sound-card
 * PLAYBACK filter writes that PCM (s16le) to a FIFO instead of a speaker. ffmpeg reads it (-f s16le)
 * alongside the H.264 and muxes both into the go2rtc stream, so the HA camera gets sound. Codec-
 * agnostic: the tap is downstream of the decoder. A single G.711 codec is forced (lp_create_core), so
 * liblinphone drives this card at a DETERMINISTIC 8 kHz mono - the SET handlers just record that
 * format and stream.sh hardcodes the matching `-ar 8000 -ac 1` (raw s16le has no header). ---- */
typedef struct {
  int fd;
  char path[256];
  int rate;
  int nch;
  long bytes;
  int announced; /* logged the PCM format yet? */
  /* Level diagnostics (per ~1s window): distinguishes "no/silent audio from the panel" (rms 0, or
   * no buffers at all) from "audio arrives but does not reach the stream" (rms > 0, wrote > 0 but
   * the listener hears nothing -> the problem is downstream in ffmpeg/go2rtc). */
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
  lp_atap_target(s->path, sizeof s->path);
  f->data = s;
}

/* Log the actual PCM format once. With G.711 forced this must read "8000 Hz, 1 ch"; anything
 * else means the codec forcing didn't take and stream.sh's hardcoded 8k/mono will be wrong. */
static void awrite_announce(AudioTap *s) {
  if (s->announced) return;
  TAP_LOG("[atap] PCM format: %d Hz, %d ch, s16le\n", s->rate, s->nch);
  s->announced = 1;
}

static void awrite_process(MSFilter *f) {
  AudioTap *s = (AudioTap *)f->data;
  awrite_announce(s);
  if (!s->path[0] && lp_atap_adopt) lp_atap_target(s->path, sizeof s->path);
  if (s->fd < 0 && s->path[0]) {
    /* Same O_RDWR|O_NONBLOCK trick as the H264 tap: we hold the FIFO open so writes never
     * EPIPE when ffmpeg comes and goes; a full pipe just returns EAGAIN and we drop. */
    int fd = open(s->path, O_RDWR | O_CREAT | O_NONBLOCK, 0644);
    if (fd >= 0) {
      s->fd = fd;
      TAP_LOG("[atap] PCM stream opened -> %s (%d Hz, %d ch, s16le)\n", s->path, s->rate, s->nch);
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
    }
    freemsg(im);
  }
  /* Once per ~1s of audio, report the level + write health (only while a FIFO is the target; a
   * door call with no camera would otherwise log a line a second for nothing). peak/avg 0 (or
   * "0 buf") => the panel isn't sending audio to us (e.g. paused); peak/avg > 0 with total rising
   * and dropped low => audio reaches the FIFO fine and the fault is downstream (ffmpeg/go2rtc). */
  if (s->win_samp >= s->rate && s->rate > 0) {
    if (s->path[0]) {
      long avg = s->win_samp ? (long)(s->win_sumabs / (double)s->win_samp) : 0;
      /* Reader health, logged on TRANSITIONS so it is visible at any log level: a whole window
       * dropped means nothing is reading the PCM FIFO -- ffmpeg gone (the viewer left; the H.264
       * idle timer will end the call) or ffmpeg alive but not consuming audio (its video encode is
       * behind real time and its audio input queue is full: see stream.sh's -thread_queue_size). */
      int all_dropped = s->win_frames > 0 && s->win_dropped >= s->win_frames;
      if (all_dropped && !s->stalled)
        TAP_LOG("[atap] PCM FIFO not being drained: every audio buffer dropped this second "
                "(no reader, or ffmpeg not consuming audio)\n");
      else if (!all_dropped && s->stalled)
        TAP_LOG("[atap] PCM FIFO draining again\n");
      s->stalled = all_dropped;
      TAP_LOG("[atap] audio ~1s: %ld buf, avg=%ld peak=%d (of 32768), total=%ldB dropped=%ld\n",
              s->win_frames, avg, s->win_peak, s->bytes, s->win_dropped);
    }
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
 * Returning the SET value from GET means liblinphone feeds us PCM in exactly that format. */
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

/* ---- Capture side: silence (or an announcement clip) ----
 * liblinphone insists on a capture filter whenever the audio stream is sendrecv, which the 2Voice
 * calls are (the station only sends audio when offered sendrecv, like the app does). Unlike
 * MS_VOID_SOURCE (which emits NOTHING), this pump emits zero-filled PCM frames so the G.711 encoder
 * packetizes them and ortp TRANSMITS RTP: 2Voice stations gate DTMF actuation / cut-through on
 * receiving inbound RTP -- with a no-packet stream the station waits out an internal timer (~2.5 s)
 * before acting on the first tone; real (silent) RTP cuts through immediately, as a live mic would.
 * Paced by the ticker clock, 20 ms per block, so real audio does not drift when the ticker runs late.
 *
 * Announcements: with lp_talk_env naming a FIFO, blocks are filled from it instead (talkout.h; a
 * short read is zero-filled, so the steady RTP is unchanged), so a clip the control plane plays goes
 * out on the live call. The Ipercom answer is recvonly, so there the capture graph never runs. */
typedef struct {
  int rate;
  int nch;
  int started;       /* first process() done (start_ms may legitimately be 0: the ticker starts there) */
  uint64_t start_ms; /* ticker time at the first process() */
  int64_t produced;  /* frames produced so far (per channel) */
  TalkIn talk;       /* announcement FIFO (talkout.h) */
} AudioSrc;

static void aread_init(MSFilter *f) {
  AudioSrc *s = ms_new0(AudioSrc, 1);
  s->rate = 8000;
  s->nch = 1;
  talkin_init(&s->talk, "atap", TAP_LOG);
  f->data = s;
}

static void aread_process(MSFilter *f) {
  AudioSrc *s = (AudioSrc *)f->data;
  uint64_t now = f->ticker->time;
  if (!s->started) {
    talkin_open(&s->talk, lp_talk_env ? lp_talk_env : "", s->rate, s->nch);
    s->started = 1;
    s->start_ms = now;
    return;
  }
  const int block = s->rate / 50; /* 20 ms of frames (one G.711 packet) */
  int64_t due = (int64_t)((now - s->start_ms) * (uint64_t)s->rate / 1000) - s->produced;
  if (due > s->rate / 5) { /* fell behind (ticker stall): skip rather than burst */
    talkin_note_skip(&s->talk, (long)((due - block) * 1000 / s->rate));
    s->produced += due - block;
    due = block;
  }
  while (due >= block) {
    size_t bytes = (size_t)block * 2 * (size_t)s->nch; /* s16le */
    mblk_t *m = allocb(bytes, 0);
    talkin_fill(&s->talk, m->b_wptr, bytes, s->rate, s->nch);
    m->b_wptr += bytes;
    ms_queue_put(f->outputs[0], m);
    s->produced += block;
    due -= block;
  }
}

static void aread_uninit(MSFilter *f) {
  AudioSrc *s = (AudioSrc *)f->data;
  talkin_close(&s->talk, s->rate, s->nch);
  ms_free(s);
}

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
    .text = "Silence / announcement capture source, ticker-paced (keeps a sendrecv audio graph fed)",
    .category = MS_FILTER_OTHER,
    .ninputs = 0,
    .noutputs = 1,
    .init = aread_init,
    .process = aread_process,
    .uninit = aread_uninit,
    .methods = aread_methods,
    .flags = MS_FILTER_IS_PUMP, /* clock-paced: run every tick, not only when input is queued */
};

/* A minimal sound card whose writer is awrite and whose reader is aread; set as BOTH the playback
 * and the capture device. liblinphone validates a capture device at audio-stream setup even for a
 * recvonly answer ("Failed to find audio device matching default input sound card" otherwise aborts
 * the audio stream). */
static MSFilter *pcm_create_writer(MSSndCard *card) {
  (void)card;
  return ms_factory_create_filter_from_desc(g_factory, &awrite_desc);
}
static MSFilter *pcm_create_reader(MSSndCard *card) {
  (void)card;
  return ms_factory_create_filter_from_desc(g_factory, &aread_desc);
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

/* ---- Core setup ---- */
typedef struct {
  const char *tag;        /* "[recv]" / "[station]" for the log lines */
  const char *user;       /* the SIP account to register */
  const char *pass;
  const char *data_dir;   /* writable, UNIQUE per process (a shared sqlite DB corrupts account state) */
  const char *uuid;       /* stable +sip.instance id ("" / NULL = let liblinphone invent one) */
  int want_video;         /* build the video graphs at all (a phase-B door call is audio only) */
  int auto_initiate;      /* offer video on outgoing calls */
  int debug;              /* liblinphone's own trace */
} LpSetup;

static LinphoneCore *lp_create_core(const LpSetup *s, LinphoneCoreCbs *cbs) {
  LinphoneFactory *factory = linphone_factory_get();
  if (s->debug) {
    LinphoneLoggingService *ls = linphone_logging_service_get();
    linphone_logging_service_set_log_level(ls, LinphoneLogLevelDebug);
  }

  /* Give liblinphone writable dirs; otherwise it errors opening its sqlite DB, which can stall the
   * core's global-state transition (and thus registration) in a container. */
  const char *datadir = (s->data_dir && *s->data_dir) ? s->data_dir : "/tmp/lp";
  linphone_factory_set_data_dir(factory, datadir);
  linphone_factory_set_config_dir(factory, datadir);
  linphone_factory_set_cache_dir(factory, datadir);

  /* NULL config paths -> in-memory config (nothing persisted). */
  LinphoneCore *lc = linphone_factory_create_core_3(factory, NULL, NULL, NULL);
  linphone_core_add_callbacks(lc, cbs);

  /* The official app's User-Agent (the 2Voice station may gate outgoing calls on it). */
  linphone_core_set_user_agent(lc, "UrmetCallForwarding-Android", NULL);
  /* DTMF as SIP INFO, not RFC 2833 -- what the 2Voice station acts on (door/gate/next/open-audio). */
  linphone_core_set_use_info_for_dtmf(lc, TRUE);
  linphone_core_set_use_rfc2833_for_dtmf(lc, FALSE);

  /* A fresh in-memory core has TLS transport disabled (tls_port=0), so a transport=tls REGISTER
   * never binds a channel. Enable TLS on a random port; drop UDP/TCP. */
  LinphoneTransports *tr = linphone_factory_create_transports(factory);
  linphone_transports_set_udp_port(tr, 0);
  linphone_transports_set_tcp_port(tr, 0);
  linphone_transports_set_tls_port(tr, -1 /* LC_SIP_TRANSPORT_RANDOM */);
  linphone_core_set_transports(lc, tr);
  linphone_transports_unref(tr);

  /* Video: we only RECEIVE. If BOTH capture and display are disabled, liblinphone answers the video
   * stream INACTIVE and never builds the receive graph. Enable both (when wanted) and route display
   * to MSExtDisplay - a headless sink that opens no X window; the absent camera is never used
   * (video is always offered/answered recvonly). Always the headless sink: if a station starts video
   * anyway, this keeps mediastreamer off the (non-existent) X display. */
  linphone_core_set_video_display_filter(lc, "MSExtDisplay");
  linphone_core_enable_video_capture(lc, s->want_video);
  linphone_core_enable_video_display(lc, s->want_video);

  /* Register the H264 tap as the decoder. openh264 stays installed so H264 is negotiable (codec
   * support needs enc+dec), but ms_factory_register_filter prepends, so our decoder wins the H264
   * decoder lookup and receives the RTP. And the PCM-tap sound card (made the device after start). */
  g_factory = linphone_core_get_ms_factory(lc);
  ms_factory_register_filter(g_factory, &tap_desc);
  ms_snd_card_manager_register_desc(ms_factory_get_snd_card_manager(g_factory), &pcm_card_desc);

  LinphoneVideoActivationPolicy *vap = linphone_factory_create_video_activation_policy(factory);
  linphone_video_activation_policy_set_automatically_accept(vap, s->want_video);
  linphone_video_activation_policy_set_automatically_initiate(vap, s->want_video && s->auto_initiate);
  linphone_core_set_video_activation_policy(lc, vap);
  linphone_video_activation_policy_unref(vap);

  /* The panel's TLS cert chain isn't ours to validate. */
  linphone_core_verify_server_certificates(lc, FALSE);
  linphone_core_verify_server_cn(lc, FALSE);

  /* STABLE RFC 5626 instance id. liblinphone keeps its `+sip.instance` UUID in `[misc] uuid` and
   * mints a random one when it is missing -- and our config lives in a /tmp dir the container wipes,
   * so each restart registered a NEW binding on the account instead of replacing the old one; they
   * linger for the full expiry and the registrar forks calls to all of them. A caller-supplied,
   * deterministic uuid makes re-registration replace our own binding. Must be set BEFORE start. */
  if (s->uuid && *s->uuid)
    linphone_config_set_string(linphone_core_get_config(lc), "misc", "uuid", s->uuid);

  linphone_core_start(lc);

  /* Route audio to our PCM-tap card (reload so detection picks up the registered desc). */
  {
    linphone_core_reload_sound_devices(lc);
    const char **snd = linphone_core_get_sound_devices(lc);
    for (int i = 0; snd && snd[i]; i++) {
      if (strstr(snd[i], "pcmtap")) {
        linphone_core_set_playback_device(lc, snd[i]);
        linphone_core_set_capture_device(lc, snd[i]);
        TAP_LOG("%s audio devices -> %s (playback + capture)\n", s->tag, snd[i]);
        break;
      }
    }
  }

  /* Force a single audio codec family so the tapped PCM format is DETERMINISTIC. The panel offers
   * both Opus (48 kHz stereo) and G.711 (8 kHz mono) and liblinphone picks a different one per call;
   * a shifting rate/channel layout makes a raw-PCM tap unusable. Keep only G.711 (PCMU/PCMA = 8 kHz
   * mono) -- telephone quality, but rock-solid and ample for a doorbell. */
  {
    bctbx_list_t *pts = linphone_core_get_audio_payload_types(lc);
    for (bctbx_list_t *it = pts; it; it = it->next) {
      LinphonePayloadType *pt = (LinphonePayloadType *)it->data;
      const char *mime = linphone_payload_type_get_mime_type(pt);
      int keep = mime && (strcasecmp(mime, "PCMU") == 0 || strcasecmp(mime, "PCMA") == 0);
      linphone_payload_type_enable(pt, keep);
      if (keep) TAP_LOG("%s audio codec kept: %s\n", s->tag, mime);
    }
    bctbx_list_free(pts); /* free the list nodes only (safe across liblinphone ownership quirks) */
  }

  /* Auth + registration (the modern LinphoneAccount API; the deprecated proxy_config path silently
   * never registered). */
  const char *domain = lp_realm();
  char server[300];
  snprintf(server, sizeof server, "sip:%s:5061;transport=tls", domain);
  LinphoneAuthInfo *ai = linphone_factory_create_auth_info(
      factory, s->user, NULL /*userid*/, s->pass, NULL /*ha1*/, NULL /*realm*/, domain);
  linphone_core_add_auth_info(lc, ai);
  linphone_auth_info_unref(ai);

  char identity[300];
  snprintf(identity, sizeof identity, "sip:%s@%s", s->user, domain);
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

  TAP_LOG("%s registering %s over %s ...\n", s->tag, identity, server);
  return lc;
}

/* Pump the core until `*ok` or `*failed` is set by the registration callback, or `ms` elapse.
 * Returns *ok. */
static inline int lp_wait_registered(LinphoneCore *lc, volatile int *ok, volatile int *failed,
                                     volatile sig_atomic_t *running, long long ms) {
  long long t0 = now_ms();
  while (*running && !*ok && !*failed && now_ms() - t0 < ms) {
    linphone_core_iterate(lc);
    usleep(50 * 1000);
  }
  return *ok;
}

#endif /* URMET_LPCOMMON_H */
