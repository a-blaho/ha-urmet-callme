/*
 * opendoor.c - the persistent liblinphone helper that opens a 2Voice (or other non-IPERCOM CallMe)
 * door. Auto-enabled whenever a 2Voice system is detected on the account; compiled into the image
 * next to recv (see ../Dockerfile) and spawned ONCE per place by src/door2voice.ts, which then drives
 * it over stdin (one command letter per line) and reads its replies on stdout. The command alphabet
 * is spelled out in src/helperProtocol.ts and in the usage text below.
 *
 * WHY a separate binary (not the pure-Node open_door_req path): IPERCOM opens a door with a cloud
 * MESSAGE (open_door_req to the gateway). 2Voice has NO such command - the door is opened by placing
 * a real SIP CALL to the door station and sending an in-call DTMF tone (DOOR_DTMF='1', GATE_DTMF='2',
 * sent as a SIP INFO, not RFC2833). That couples door-open to liblinphone/media, so we reuse the
 * embedded stack here rather than hand-rolling a media call in Node.
 *
 * Flow (the 2Voice auto-insertion door-open, non-SER_PHASE_B families):
 *   1. register the place's INCOMING/channel account (argv IN user/pass) over TLS to sip.urmet.com,
 *      once, at startup (each later press then skips the ~2-3 s register)
 *   2. on a '1'/'2' command, place an OUTGOING INVITE to the OUTGOING account (argv OUT uri) with a
 *      custom header `auto_insertion: true` so the station auto-answers without ringing the indoor
 *      monitor (or `mac: <MAC>` for a phase-B station, see OPENDOOR_MAC)
 *   3. on StreamsRunning, send the DTMF digit via SIP INFO and print `RESULT <d> ok`
 *   4. keep the call up for OPENDOOR_KEEPALIVE_MS so a follow-up tone rides the same call, then BYE
 * No media is tapped on the door call - a silence capture + null playback just satisfy liblinphone's
 * device lookup so a stream negotiates and StreamsRunning fires. The same process also holds a
 * doorbell ring unanswered (OPENDOOR_ANSWER_RING) so a press/announcement during the ring can answer
 * it, and can show that ring call on the camera (the 'V' command, h264tap.h).
 *
 * Usage: opendoor <in-username> <in-password> <out-sip-uri>
 *   env: OPENDOOR_DATA_DIR (writable, unique per place - liblinphone's sqlite/config),
 *        OPENDOOR_UUID (stable +sip.instance id, so a restart REPLACES our registrar binding),
 *        OPENDOOR_KEEPALIVE_MS, OPENDOOR_PREWARM_HOLD_MS, OPENDOOR_MAC, OPENDOOR_AUDIO_IN,
 *        OPENDOOR_TALK_DTMF, OPENDOOR_ANSWER_RING, OPENDOOR_DEBUG=1 (SIP trace).
 * Targets the same liblinphone C API (Ubuntu 24.04: liblinphone-dev) as recv.c.
 */
#include <linphone/core.h>
#include <mediastreamer2/msfilter.h>
#include <mediastreamer2/msfactory.h>
#include <mediastreamer2/msqueue.h>
#include <mediastreamer2/mssndcard.h>
#include <ortp/str_utils.h>
#include <stdarg.h>
#include <fcntl.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <time.h>
#include <unistd.h>
#include "talkout.h"

/* ---- A minimal sound card so an audio stream negotiates in a headless container. liblinphone
 * validates a capture AND a playback device at audio-stream setup even when we neither send nor
 * play real audio; without one it aborts the stream ("Failed to find audio device..."). The reader
 * is a void source (silence); the writer is a null sink that discards. This is the same trick recv.c
 * uses, minus the FIFO tap (door-open needs no audio content, only that a stream runs). ---- */
static MSFactory *g_factory = NULL;

/* Camera audio FIFO while a ring call feeds the camera ('V', see ring_camera): the received PCM goes
 * there, like recv's audio tap. Empty = discard. */
static char g_cam_audio[256] = "";

typedef struct {
  int rate;
  int nch;
  int fd; /* camera PCM FIFO, opened O_RDWR|O_NONBLOCK like recv's taps (no EPIPE, drop when full) */
} NullSink;

static void nullsink_init(MSFilter *f) {
  NullSink *s = ms_new0(NullSink, 1);
  s->rate = 8000;
  s->nch = 1;
  s->fd = -1;
  f->data = s;
}
static void nullsink_process(MSFilter *f) {
  NullSink *s = (NullSink *)f->data;
  if (s->fd < 0 && g_cam_audio[0]) s->fd = open(g_cam_audio, O_RDWR | O_NONBLOCK);
  mblk_t *im;
  while ((im = ms_queue_get(f->inputs[0])) != NULL) {
    if (s->fd >= 0) (void)!write(s->fd, im->b_rptr, (size_t)(im->b_wptr - im->b_rptr));
    freemsg(im); /* otherwise discard: no speaker */
  }
}
static void nullsink_uninit(MSFilter *f) {
  NullSink *s = (NullSink *)f->data;
  if (s->fd >= 0) close(s->fd);
  ms_free(s);
}
static int nullsink_set_sr(MSFilter *f, void *a) { ((NullSink *)f->data)->rate = *(int *)a; return 0; }
static int nullsink_get_sr(MSFilter *f, void *a) { *(int *)a = ((NullSink *)f->data)->rate; return 0; }
static int nullsink_set_nch(MSFilter *f, void *a) { ((NullSink *)f->data)->nch = *(int *)a; return 0; }
static int nullsink_get_nch(MSFilter *f, void *a) { *(int *)a = ((NullSink *)f->data)->nch; return 0; }
static MSFilterMethod nullsink_methods[] = {
    {MS_FILTER_SET_SAMPLE_RATE, nullsink_set_sr},
    {MS_FILTER_GET_SAMPLE_RATE, nullsink_get_sr},
    {MS_FILTER_SET_NCHANNELS, nullsink_set_nch},
    {MS_FILTER_GET_NCHANNELS, nullsink_get_nch},
    {0, NULL}};
static MSFilterDesc nullsink_desc = {
    .id = MS_FILTER_PLUGIN_ID,
    .name = "NullSink",
    .text = "Discards received audio (no speaker)",
    .category = MS_FILTER_OTHER,
    .ninputs = 1,
    .noutputs = 0,
    .init = nullsink_init,
    .process = nullsink_process,
    .uninit = nullsink_uninit,
    .methods = nullsink_methods,
    .flags = 0,
};

/* ---- Silence CAPTURE source. Unlike MS_VOID_SOURCE (which emits NOTHING), this emits zero-filled
 * PCM frames so the G.711 encoder actually packetizes them and ortp TRANSMITS RTP. 2Voice stations
 * gate DTMF actuation / cut-through on receiving inbound RTP -- with a no-packet stream the station
 * waits out an internal timer (~2.5s) before acting on the first tone (the fresh-call delay); real
 * (silent) RTP cuts through immediately, as a live mic would.
 *
 * Announcements: with OPENDOOR_AUDIO_IN=<fifo>, blocks are filled from that FIFO instead (see
 * talkout.h; a short read is zero-filled, so the steady RTP above is unchanged). Paced by the ticker
 * clock like recv.c's aread, not one block per tick, so real audio does not drift when the ticker
 * runs late. Env unset = silence, as before. ---- */
static void olog(const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  vprintf(fmt, ap);
  va_end(ap);
}

/* The camera's H.264 tap (shared with recv.c). Registered as our H264 decoder: with no camera target
 * it just discards the video (cheaper than decoding it for the headless display, as before); while a
 * ring call feeds the camera it writes the stream to the camera's FIFO. */
#define TAP_LOG olog
#include "h264tap.h"
typedef struct {
  int rate;
  int nch;
  int started;       /* first process() done (start_ms may legitimately be 0: the ticker starts there) */
  uint64_t start_ms; /* ticker time at the first process() */
  int64_t produced;  /* frames produced so far (per channel) */
  TalkIn talk;       /* announcement FIFO (talkout.h) */
} SilenceSrc;
static void silence_init(MSFilter *f) {
  SilenceSrc *s = ms_new0(SilenceSrc, 1);
  s->rate = 8000; /* G.711 forced -> 8 kHz mono; SET handlers below confirm */
  s->nch = 1;
  talkin_init(&s->talk, "opendoor", olog);
  f->data = s;
}
static void silence_uninit(MSFilter *f) {
  SilenceSrc *s = (SilenceSrc *)f->data;
  talkin_close(&s->talk, s->rate, s->nch);
  ms_free(s);
}
static void silence_process(MSFilter *f) {
  SilenceSrc *s = (SilenceSrc *)f->data;
  uint64_t now = f->ticker->time;
  if (!s->started) {
    talkin_open(&s->talk, "OPENDOOR_AUDIO_IN", s->rate, s->nch);
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
static int silence_set_sr(MSFilter *f, void *a) { ((SilenceSrc *)f->data)->rate = *(int *)a; return 0; }
static int silence_get_sr(MSFilter *f, void *a) { *(int *)a = ((SilenceSrc *)f->data)->rate; return 0; }
static int silence_set_nch(MSFilter *f, void *a) { ((SilenceSrc *)f->data)->nch = *(int *)a; return 0; }
static int silence_get_nch(MSFilter *f, void *a) { *(int *)a = ((SilenceSrc *)f->data)->nch; return 0; }
static MSFilterMethod silence_methods[] = {
    {MS_FILTER_SET_SAMPLE_RATE, silence_set_sr},
    {MS_FILTER_GET_SAMPLE_RATE, silence_get_sr},
    {MS_FILTER_SET_NCHANNELS, silence_set_nch},
    {MS_FILTER_GET_NCHANNELS, silence_get_nch},
    {0, NULL}};
static MSFilterDesc silence_desc = {
    .id = MS_FILTER_PLUGIN_ID,
    .name = "SilenceSource",
    .text = "Emits silent PCM frames so RTP actually flows (cut-through the 2Voice station)",
    .category = MS_FILTER_OTHER,
    .ninputs = 0,
    .noutputs = 1,
    .init = silence_init,
    .process = silence_process,
    .uninit = silence_uninit,
    .methods = silence_methods,
    .flags = MS_FILTER_IS_PUMP, /* clock-paced: run every tick, not only when input is queued */
};

static MSFilter *null_create_writer(MSSndCard *card) {
  (void)card;
  return ms_factory_create_filter_from_desc(g_factory, &nullsink_desc);
}
static MSFilter *null_create_reader(MSSndCard *card) {
  (void)card;
  /* Real silent RTP (not MS_VOID_SOURCE, which sends nothing) so the station cuts through fast. */
  return ms_factory_create_filter_from_desc(g_factory, &silence_desc);
}
static MSSndCard *null_new(void);
static MSSndCard *null_duplicate(MSSndCard *obj) { (void)obj; return null_new(); }
static void null_detect(MSSndCardManager *m);
static MSSndCardDesc null_card_desc = {
    .driver_type = "NullCard",
    .detect = null_detect,
    .create_reader = null_create_reader,
    .create_writer = null_create_writer,
    .duplicate = null_duplicate,
};
static MSSndCard *null_new(void) {
  MSSndCard *card = ms_snd_card_new(&null_card_desc);
  if (card->name) ms_free(card->name);
  card->name = ms_strdup("nullcard");
  card->capabilities = MS_SND_CARD_CAP_PLAYBACK | MS_SND_CARD_CAP_CAPTURE;
  return card;
}
static void null_detect(MSSndCardManager *m) { ms_snd_card_manager_add_card(m, null_new()); }

/* ---- call-state machine driven from main() ---- */
static LinphoneCall *g_call = NULL;
static volatile sig_atomic_t g_running = 1;
static int g_reg_ok = 0;     /* registration succeeded */
static int g_reg_failed = 0; /* registration failed (bad creds / server) */
static int g_streams = 0;    /* the call reached StreamsRunning (media up) -> safe to send DTMF */
static int g_ended = 0;      /* the call ended (End/Error/Released) */
static int g_talk_digit_sent = 0; /* the open-audio digit went out on this call (announcements) */
/* Doorbell ring held unanswered (OPENDOOR_ANSWER_RING). While a station rings it answers 486 Busy to
 * every new call, so an announcement or door press during the ring can't place its own call; it
 * answers this one instead (answer_ring). NULL = no ring, or not holding rings. */
static LinphoneCall *g_ring = NULL;
static int g_call_is_ring = 0; /* g_call is a ring we answered (not a call we placed) */
static int g_cam_on = 0;       /* the ring call (held or answered) feeds the camera ('V') */

static void on_sig(int _s) { (void)_s; g_running = 0; }

static const char *dir_name(LinphoneMediaDirection d) {
  switch (d) {
  case LinphoneMediaDirectionInactive: return "inactive";
  case LinphoneMediaDirectionSendOnly: return "sendonly";
  case LinphoneMediaDirectionRecvOnly: return "recvonly";
  case LinphoneMediaDirectionSendRecv: return "sendrecv";
  default: return "invalid";
  }
}

/* Announcement diagnostics: the NEGOTIATED audio (codec + direction, ours and the station's). An
 * announcement only reaches the station when our side may send: "sendrecv"/"sendonly" here. A
 * station answering "sendonly" (from its side) puts us on recvonly, and nothing we play gets out. */
static void log_audio_media(LinphoneCall *call, const char *when) {
  const LinphoneCallParams *cp = linphone_call_get_current_params(call);
  const LinphoneCallParams *rp = linphone_call_get_remote_params(call);
  const LinphonePayloadType *pt = cp ? linphone_call_params_get_used_audio_payload_type(cp) : NULL;
  printf("[opendoor] audio (%s): %s/%d, our direction %s, station offered %s\n", when,
         pt ? linphone_payload_type_get_mime_type(pt) : "?",
         pt ? linphone_payload_type_get_clock_rate(pt) : 0,
         cp ? dir_name(linphone_call_params_get_audio_direction(cp)) : "?",
         rp ? dir_name(linphone_call_params_get_audio_direction(rp)) : "?");
  fflush(stdout);
}

/* Audio RTP counters for the call so far: "sent" rising while a clip plays = it left for the station;
 * "recv" = the station sends audio back (its microphone is open). */
static void log_audio_rtp(LinphoneCall *call, const char *when) {
  LinphoneCallStats *st = linphone_call_get_audio_stats(call);
  if (!st) return;
  const rtp_stats_t *r = linphone_call_stats_get_rtp_stats(st);
  printf("[opendoor] audio rtp (%s): sent %llu pkts (%llu B), recv %llu pkts, lost %lld\n", when,
         (unsigned long long)r->packet_sent, (unsigned long long)r->sent,
         (unsigned long long)r->packet_recv, (long long)r->cum_packet_loss);
  fflush(stdout);
  linphone_call_stats_unref(st);
}

static void on_reg_state(LinphoneCore *lc, LinphoneProxyConfig *cfg,
                         LinphoneRegistrationState state, const char *message) {
  (void)lc; (void)cfg;
  printf("[opendoor] registration: %s (%s)\n",
         linphone_registration_state_to_string(state), message ? message : "");
  fflush(stdout);
  if (state == LinphoneRegistrationOk) g_reg_ok = 1;
  else if (state == LinphoneRegistrationFailed) g_reg_failed = 1;
}

/* The ring call is gone (ended while held, or the answered ring ended): stop feeding the camera and
 * tell the control plane, which then places normal camera calls again. */
static void ring_gone(void) {
  if (g_cam_on) {
    g_cam_on = 0;
    g_tap_target[0] = '\0';
    g_cam_audio[0] = '\0';
    printf("[opendoor] camera: the ring call ended, so did its picture\nCAMERA end\n");
  }
  printf("RING gone\n");
  fflush(stdout);
}

static void on_call_state(LinphoneCore *lc, LinphoneCall *call,
                          LinphoneCallState state, const char *message) {
  (void)lc;
  printf("[opendoor] call state: %s\n", linphone_call_state_to_string(state));
  fflush(stdout);
  switch (state) {
  case LinphoneCallIncomingReceived:
    /* Persistent mode stays registered on the channel account, so a doorbell ring forks here too.
     * The Node doorbell listener handles rings. With OPENDOOR_ANSWER_RING we hold one ring unanswered
     * (ringing, like the listener and the phone app) so an announcement / door press during it can
     * answer it (answer_ring: the station refuses new calls while it rings); otherwise, and for a
     * second ring, decline (Busy). (486 is a 4xx, so
     * Flexisip keeps forking to the other bindings; it just drops us from this call.) */
    if (!g_ring && getenv("OPENDOOR_ANSWER_RING")) {
      g_ring = linphone_call_ref(call);
      printf("[opendoor] ring: holding the doorbell call unanswered (an announcement or door press "
             "during the ring answers it; the camera shows it without answering)\nRING held\n");
      fflush(stdout);
    } else {
      linphone_call_decline(call, LinphoneReasonBusy);
    }
    break;
  case LinphoneCallStreamsRunning: {
    /* Report the NEGOTIATED media, not what we asked for -- a station can still answer with video. */
    const LinphoneCallParams *cur = linphone_call_get_current_params(call);
    printf("[opendoor] media up: audio%s\n",
           (cur && linphone_call_params_video_enabled(cur)) ? "+video" : " only");
    fflush(stdout);
    log_audio_media(call, "media up");
    g_streams = 1;
    break;
  }
  case LinphoneCallPausedByRemote:
  case LinphoneCallUpdatedByRemote:
    /* The station changed the media mid-call (e.g. put us on hold) -- this can stop an announcement. */
    log_audio_media(call, linphone_call_state_to_string(state));
    break;
  case LinphoneCallError: {
    if (call == g_ring) { /* the ring ended before anyone needed it (answered elsewhere / gave up) */
      printf("[opendoor] ring: ended (%s)\n", message ? message : "");
      fflush(stdout);
      linphone_call_unref(g_ring);
      g_ring = NULL;
      ring_gone();
      break;
    }
    /* DIAGNOSTIC (58A support): print the SIP status the station returned. A `486 Busy Here` here
     * means the station rejected our header (the 58A rejects `auto_insertion`; a cloud-listed
     * station rejects `mac`) -- this is how we tell "wrong header" apart from "no media / timeout". */
    const LinphoneErrorInfo *ei = linphone_call_get_error_info(call);
    printf("[opendoor] call error: %d %s (%s)\n",
           ei ? linphone_error_info_get_protocol_code(ei) : 0,
           (ei && linphone_error_info_get_phrase(ei)) ? linphone_error_info_get_phrase(ei) : "",
           message ? message : "");
    fflush(stdout);
    if (g_call == call) g_ended = 1;
    if (g_call == call && g_call_is_ring) {
      g_call_is_ring = 0;
      ring_gone();
    }
    break;
  }
  case LinphoneCallEnd:
  case LinphoneCallReleased:
    if (call == g_ring) {
      printf("[opendoor] ring: ended (%s)\n", message ? message : "");
      fflush(stdout);
      linphone_call_unref(g_ring);
      g_ring = NULL;
      ring_gone();
      break;
    }
    if (state == LinphoneCallEnd) log_audio_rtp(call, "call ended");
    if (g_call == call && g_call_is_ring) {
      g_call_is_ring = 0;
      ring_gone();
    }
    printf("[opendoor] call finished: %s\n", message ? message : "");
    fflush(stdout);
    if (g_call == call) g_ended = 1;
    break;
  default:
    break;
  }
}


#define OPENDOOR_STREAMS_TIMEOUT_MS 20000 /* after the INVITE, wait this long for media */
/* Pre-warm hold: how long to keep a call opened by a 'W' (warm) command up while waiting for the
 * unlock press, before releasing the 2Voice bus if no tone arrives. Overridable via env. */
#define OPENDOOR_PREWARM_HOLD_MS 15000

/* Phase-B (1083/58A family) is identified by OPENDOOR_MAC. Those stations accept an audio-only
 * INVITE with a `mac` header; cloud-listed 2Voice panels 403 an audio-only offer (observed on a
 * 1760/16) and keep the video graph. */
static int phase_b(void) {
  const char *mac = getenv("OPENDOOR_MAC");
  return mac && *mac;
}

/* A doorbell ring is held (g_ring): the station refuses new calls while it rings (486 Busy), and the
 * held ring has our sound device, so liblinphone would not even place our own call. Answer the ring
 * instead and make it g_call, so it carries the announcement / tone. Answering takes the call, so
 * the phone app stops ringing. No open-audio digit on it: a ring answered like the app answers it
 * has the audio open already. Returns 1 when the ring is now g_call; on failure the ring is declined
 * (freeing the sound device) so the caller can still try its own call. */
static int answer_ring(LinphoneCore *lc, const char *what) {
  if (!g_ring || g_call) return 0;
  LinphoneCall *c = g_ring;
  g_ring = NULL;
  LinphoneCallState st = linphone_call_get_state(c);
  if (st != LinphoneCallIncomingReceived && st != LinphoneCallIncomingEarlyMedia) {
    linphone_call_unref(c);
    return 0;
  }
  LinphoneCallParams *p = linphone_core_create_call_params(lc, c);
  linphone_call_params_enable_audio(p, TRUE);
  if (phase_b()) {
    linphone_call_params_enable_video(p, FALSE);
  } else {
    linphone_call_params_enable_video(p, TRUE); /* as on our own calls: receive only, discarded */
    linphone_call_params_set_video_direction(p, LinphoneMediaDirectionRecvOnly);
  }
  /* Make it g_call BEFORE accepting: the media of an incoming call comes up inside the accept
   * (StreamsRunning fires synchronously), so clearing g_streams afterwards lost it and a queued door
   * tone waited forever for media that was already up (#19). */
  g_call = c; /* keeps the ref taken when the ring arrived */
  g_call_is_ring = 1;
  g_streams = 0;
  g_ended = 0;
  g_talk_digit_sent = 1;
  LinphoneStatus rc = linphone_call_accept_with_params(c, p);
  linphone_call_params_unref(p);
  printf("[opendoor] ring: the station is ringing -> answering the ring call for the %s (%s)\n",
         what, rc == 0 ? "ok; the phone app stops ringing" : "FAILED, declining it");
  fflush(stdout);
  if (rc != 0) {
    g_call = NULL;
    g_call_is_ring = 0;
    g_ended = 0;
    linphone_call_decline(c, LinphoneReasonBusy);
    linphone_call_unref(c);
    return 0;
  }
  return 1;
}

/* The camera opened during a ring ('V <h264 fifo> <pcm fifo>'): feed it from the ring call, as the
 * official app's "view camera" button does on its incoming-call screen. A ring still ringing gets
 * early media (183 + SDP: the station streams while the call keeps ringing, so the phones keep
 * ringing too), and only when its video is recvonly/sendrecv for us -- the app's isEarlyMediaAllowed
 * check. A ring already answered (for an announcement / door press) just has its video and audio
 * redirected to the camera. Replies "CAMERA ok" or "CAMERA fail <why>" (the control plane then
 * places a normal camera call); "CAMERA end" follows when the ring call ends. */
static void ring_camera(const char *h264, const char *pcm) {
  LinphoneCall *c = g_ring ? g_ring : (g_call && g_call_is_ring ? g_call : NULL);
  if (!c || !h264[0] || !pcm[0]) {
    printf("[opendoor] camera: no ring call to show\nCAMERA fail no ring\n");
    fflush(stdout);
    return;
  }
  if (c == g_ring) {
    const LinphoneCallParams *cp = linphone_call_get_current_params(c);
    LinphoneMediaDirection vd =
        cp && linphone_call_params_video_enabled(cp) ? linphone_call_params_get_video_direction(cp)
                                                     : LinphoneMediaDirectionInactive;
    if (vd != LinphoneMediaDirectionRecvOnly && vd != LinphoneMediaDirectionSendRecv) {
      printf("[opendoor] camera: the ring call offers no video for us (%s)\nCAMERA fail no video\n",
             dir_name(vd));
      fflush(stdout);
      return;
    }
  }
  snprintf(g_tap_target, sizeof g_tap_target, "%s", h264);
  snprintf(g_cam_audio, sizeof g_cam_audio, "%s", pcm);
  g_cam_on = 1;
  if (c == g_ring) {
    LinphoneStatus st = linphone_call_accept_early_media(c);
    printf("[opendoor] camera: showing the ringing call (early media, as the app's \"view camera\"; "
           "the phones keep ringing) -> %s\n", st == 0 ? "ok" : "FAILED");
    if (st != 0) {
      g_cam_on = 0;
      g_tap_target[0] = '\0';
      g_cam_audio[0] = '\0';
      printf("CAMERA fail early media refused\n");
      fflush(stdout);
      return;
    }
  } else {
    printf("[opendoor] camera: showing the answered ring call\n");
  }
  printf("CAMERA ok\n");
  fflush(stdout);
}

/* The rest of a 'V' command line from stdin (the control plane writes it in one go). */
static void read_rest_of_line(char *out, size_t outsz) {
  size_t n = 0;
  for (int spins = 0; spins < 200;) {
    char c;
    ssize_t r = read(STDIN_FILENO, &c, 1);
    if (r == 1) {
      if (c == '\n') break;
      if (n + 1 < outsz) out[n++] = c;
      continue;
    }
    if (r == 0) break;
    usleep(1000);
    spins++;
  }
  out[n] = '\0';
}

static void handle_camera_command(void) {
  char line[600], h264[256] = "", pcm[256] = "";
  read_rest_of_line(line, sizeof line);
  if (sscanf(line, " %255s %255s", h264, pcm) < 2) h264[0] = pcm[0] = '\0';
  ring_camera(h264, pcm);
}

/* Place an auto_insertion call to out_uri (or, while a ring is held, answer it -- see answer_ring).
 * Resets g_streams/g_ended, sets g_call (refed).
 * Uses the expected offer (UA + SRTP configured on the core). Returns the call or NULL. */
static LinphoneCall *place_call(LinphoneCore *lc, LinphoneFactory *factory, const char *out_uri,
                               const char *what) {
  if (g_ring) {
    /* `what` = what the call is for; NULL (a pre-warm) never answers a ring: nothing needs the call
     * yet, and answering would stop the phone app ringing. */
    if (!what) {
      printf("[opendoor] a doorbell ring is in progress; not opening a call now\n");
      fflush(stdout);
      return NULL;
    }
    if (answer_ring(lc, what)) return g_call;
  }
  g_call_is_ring = 0;
  g_streams = 0;
  g_ended = 0;
  g_talk_digit_sent = 0;
  LinphoneAddress *to = linphone_factory_create_address(factory, out_uri);
  if (!to) { fprintf(stderr, "[opendoor] bad OUT uri %s\n", out_uri); return NULL; }
  LinphoneCallParams *p = linphone_core_create_call_params(lc, NULL);
  linphone_call_params_enable_audio(p, TRUE);
  if (phase_b()) {
    /* Explicit: the params inherit the core's video activation policy, so "not enabling" video is
     * not enough to keep the m=video line (and its H.264 graph) out of the offer. */
    linphone_call_params_enable_video(p, FALSE);
  } else {
    /* Offer video recvonly (no camera; the m=video line makes some stations accept auto_insertion). */
    linphone_call_params_enable_video(p, TRUE);
    linphone_call_params_set_video_direction(p, LinphoneMediaDirectionRecvOnly);
  }
  if (linphone_core_media_encryption_supported(lc, LinphoneMediaEncryptionSRTP))
    linphone_call_params_set_media_encryption(p, LinphoneMediaEncryptionSRTP);
  /* Phase-B stations (1083/58A family) want `mac` and reject `auto_insertion` with 486 Busy.
   * Cloud-listed 2Voice stations want `auto_insertion: true`. The app sends one or the other. */
  const char *mac = getenv("OPENDOOR_MAC");
  if (mac && *mac) linphone_call_params_add_custom_header(p, "mac", mac);
  else linphone_call_params_add_custom_header(p, "auto_insertion", "true");
  /* DIAGNOSTIC (58A support): record which header we actually put on the INVITE, so a tester's log
   * confirms the mac-vs-auto_insertion choice reaching the wire (paired with the call-error code
   * below when the station rejects it). */
  printf("[opendoor] outgoing header: %s\n",
         (mac && *mac) ? "mac" : "auto_insertion");
  fflush(stdout);
  LinphoneCall *call = linphone_core_invite_address_with_params(lc, to, p);
  linphone_call_params_unref(p);
  linphone_address_unref(to);
  if (!call) { fprintf(stderr, "[opendoor] invite failed to start\n"); return NULL; }
  linphone_call_ref(call);
  g_call = call;
  printf("[opendoor] call placed, offering %s -> waiting for media\n",
         phase_b() ? "audio only" : "audio+video");
  fflush(stdout);
  return call;
}

/* Terminate the active call (in-dialog BYE), pump iterate so it goes out, unref, clear g_call. */
static void bye_call(LinphoneCore *lc) {
  if (g_call) {
    LinphoneCall *c = g_call;
    if (!g_ended) linphone_call_terminate(c);
    for (int i = 0; i < 40 && !g_ended; i++) {
      linphone_core_iterate(lc);
      usleep(25 * 1000);
    }
    linphone_call_unref(c);
    g_call = NULL;
    if (g_call_is_ring) { /* its End did not arrive in time: report the ring gone ourselves */
      g_call_is_ring = 0;
      ring_gone();
    }
  }
  g_ended = 0; /* consume: place_call sets it fresh for the next call */
}

/* Send one tone on the active (already-running) call and report it. */
static void send_tone(char c, long long *last_activity, long long now) {
  LinphoneStatus st = linphone_call_send_dtmf(g_call, c);
  printf("[opendoor] sent DTMF '%c' (status %d)\n", c, (int)st);
  printf("[opendoor] RESULT %c ok\n", c);
  fflush(stdout);
  *last_activity = now;
}

/* ---- Announcements ('T' on stdin). The control plane plays a clip into OPENDOOR_AUDIO_IN (see
 * talkout.h); our job is to have a call up while it plays: place one if none is held, send the
 * station the open-audio digit (OPENDOOR_TALK_DTMF; the app sends '4' to open the audio on an
 * auto_insertion call; empty = none), wait up to OPENDOOR_TALK_START_MS for the clip to start (TTS
 * may still be rendering), keep the call while it plays, and release it like any other activity
 * afterwards. No RESULT line: the control plane matches RESULTs to door presses, and it learns how
 * the clip went from its own writer. */
#define OPENDOOR_TALK_START_MS 25000

static long long talk_start_ms(void) {
  const char *e = getenv("OPENDOOR_TALK_START_MS");
  return (e && *e) ? atoll(e) : OPENDOOR_TALK_START_MS;
}

/* Once per call, when media runs: the open-audio digit, if configured. */
static void talk_send_digit(void) {
  if (g_talk_digit_sent || !g_call || !g_streams) return;
  g_talk_digit_sent = 1;
  const char *d = getenv("OPENDOOR_TALK_DTMF");
  if (!d || !*d) {
    printf("[opendoor] announce: no open-audio digit configured (sending none)\n");
  } else {
    LinphoneStatus st = linphone_call_send_dtmf(g_call, d[0]);
    printf("[opendoor] announce: sent open-audio DTMF '%c' (SIP INFO) -> %s\n", d[0],
           st == 0 ? "ok" : "FAILED");
  }
  fflush(stdout);
}

/* Log what the announcement request finds (and whether it has to place a call). */
static void talk_log_request(long long now, long long call_placed_at) {
  if (!g_call)
    printf("[opendoor] announce: requested -> placing a call to the station\n");
  else if (!g_streams)
    printf("[opendoor] announce: requested -> call already being placed (%lld ms ago)\n",
           now - call_placed_at);
  else
    printf("[opendoor] announce: requested -> riding the call already up\n");
  fflush(stdout);
}

/* THE command loop: hold the auto_insertion call up for `keepalive_ms` after the last tone and send
 * follow-up tones on the SAME call (instant repeat, e.g. door then gate), then BYE on idle to release
 * the 2Voice bus/monitor. Reads commands from stdin (see the usage text / src/helperProtocol.ts);
 * reports RESULT per tone. */
static void keepalive_loop(LinphoneCore *lc, LinphoneFactory *factory, const char *out_uri,
                           long long keepalive_ms) {
  long long last_activity = 0, call_placed_at = 0;
  long long warm_deadline = 0; /* a 'W' pre-warm holds the call up until here even with no tone yet */
  long long prewarm_hold = OPENDOOR_PREWARM_HOLD_MS;
  if (getenv("OPENDOOR_PREWARM_HOLD_MS")) prewarm_hold = atoll(getenv("OPENDOOR_PREWARM_HOLD_MS"));
  char queue[8]; /* tones waiting for StreamsRunning (the command that placed the call) */
  int qn = 0;
  int release_req = 0; /* an 'H' arrived: BYE the held call once no tone is still waiting to go out */
  /* Announcement: hold the call for a clip until talk_deadline (it must START by then); while it
   * plays the call is busy; after it ends, the keep-alive idle counts from the clip's end. */
  long long talk_deadline = 0, talk_requested_at = 0;
  int talk_waiting = 0;   /* a 'T' is waiting for its clip to start */
  int talk_media_logged = 0;
  long talk_clips = g_talk_clips;
  const long long talk_start = talk_start_ms();

  while (g_running) {
    linphone_core_iterate(lc);
    usleep(50 * 1000);
    const long long now = now_ms();

    /* Drain stdin. */
    for (;;) {
      char c;
      ssize_t n = read(STDIN_FILENO, &c, 1);
      if (n == 0) { g_running = 0; break; } /* stdin closed -> exit */
      if (n < 0) break;                     /* EAGAIN: nothing more right now */
      if (c == 'W') {
        /* Pre-warm (doorbell ring): open the auto_insertion call NOW, no tone, so the unlock press
         * moments later rides an already-established call (instant). Hold it for
         * prewarm_hold; if no tone comes, the idle check below releases the bus. */
        warm_deadline = now + prewarm_hold;
        if (!g_call) {
          if (place_call(lc, factory, out_uri, NULL)) {
            call_placed_at = now;
            printf("[opendoor] pre-warm: opening call (hold %llds)\n", prewarm_hold / 1000);
            fflush(stdout);
          }
        }
        continue;
      }
      if (c == 'T') {
        /* Announcement: open/hold the call; the clip arrives on OPENDOOR_AUDIO_IN (talkout.h). */
        talk_log_request(now, call_placed_at);
        if (!g_call) {
          if (!place_call(lc, factory, out_uri, "announcement")) continue;
          call_placed_at = now;
        }
        talk_requested_at = now;
        talk_waiting = 1;
        talk_media_logged = 0;
        talk_deadline = now + OPENDOOR_STREAMS_TIMEOUT_MS + talk_start;
        continue;
      }
      if (c == 'V') {
        handle_camera_command();
        continue;
      }
      if (c == 'H') {
        /* Release (hang up): the user pressed "hang up", or the camera is about to place ITS call
         * to this station and a held pre-warm/keep-alive call of ours would collide with it. A tone
         * already queued for this call still goes out first (checked below); nothing is lost. */
        release_req = 1;
        warm_deadline = 0;
        if (g_talk_active) {
          printf("[opendoor] announce: hang-up requested while a clip plays -> cutting it short\n");
          fflush(stdout);
        }
        talk_waiting = 0;
        talk_deadline = 0;
        continue;
      }
      if (c != '1' && c != '2') continue;
      if (g_call && g_streams) {
        send_tone(c, &last_activity, now); /* call up -> instant */
      } else {
        if (qn < (int)sizeof queue) queue[qn++] = c; /* queue until media */
        if (!g_call) {
          if (place_call(lc, factory, out_uri, c == '1' ? "door" : "gate")) call_placed_at = now;
          else { for (int i = 0; i < qn; i++) printf("[opendoor] RESULT %c fail\n", queue[i]); qn = 0; fflush(stdout); }
        }
      }
    }

    /* Call reached media -> flush queued tones. */
    if (g_call && g_streams && qn > 0) {
      for (int i = 0; i < qn; i++) send_tone(queue[i], &last_activity, now);
      qn = 0;
    }
    /* Announcement bookkeeping. */
    if (talk_waiting && g_call && g_streams) {
      if (!talk_media_logged) {
        talk_media_logged = 1;
        printf("[opendoor] announce: call ready %lld ms after the request; waiting for the clip\n",
               now - talk_requested_at);
        fflush(stdout);
        talk_deadline = now + talk_start; /* the clip must start within talk_start from here */
      }
      talk_send_digit();
    }
    if (g_talk_active) {
      talk_waiting = 0;
      talk_deadline = 0;
      last_activity = now; /* busy while it plays; the idle hang-up counts from the clip's end */
    }
    if (g_talk_clips != talk_clips) {
      talk_clips = g_talk_clips;
      last_activity = now;
      if (g_call) log_audio_rtp(g_call, "after the clip");
      if (keepalive_ms > 0) {
        printf("[opendoor] announce: done; holding the call %llds for a follow-up\n",
               keepalive_ms / 1000);
        fflush(stdout);
      }
    }
    if (talk_waiting && talk_deadline && now > talk_deadline) {
      printf("[opendoor] announce: no audio arrived within %llds of the call coming up; "
             "releasing the hold\n", talk_start / 1000);
      fflush(stdout);
      talk_waiting = 0;
      talk_deadline = 0;
    }
    /* Release requested and no tone is waiting on this call any more -> BYE now (not on idle). */
    if (release_req && qn == 0) {
      release_req = 0;
      if (g_call) {
        printf("[opendoor] release requested -> hanging up\n");
        fflush(stdout);
        bye_call(lc);
      }
    }
    /* Placed but no media in time -> fail queued + tear down. */
    if (g_call && !g_streams && now - call_placed_at > OPENDOOR_STREAMS_TIMEOUT_MS) {
      fprintf(stderr, "[opendoor] no media within %ds (station busy / rejected?)\n",
              OPENDOOR_STREAMS_TIMEOUT_MS / 1000);
      for (int i = 0; i < qn; i++) printf("[opendoor] RESULT %c fail\n", queue[i]);
      qn = 0; fflush(stdout);
      if (talk_waiting) { printf("[opendoor] announce: FAILED -- the call never came up\n"); fflush(stdout); }
      talk_waiting = 0;
      talk_deadline = 0;
      bye_call(lc);
    }
    /* Station ended the call on its own. */
    if (g_ended) {
      for (int i = 0; i < qn; i++) printf("[opendoor] RESULT %c fail\n", queue[i]);
      if (qn > 0) fflush(stdout);
      qn = 0;
      if (talk_waiting || g_talk_active) {
        printf("[opendoor] announce: the station ended the call%s\n",
               g_talk_active ? " mid-clip" : " before the clip started");
        fflush(stdout);
      }
      talk_waiting = 0;
      talk_deadline = 0;
      bye_call(lc);
    }
    /* Idle -> release the bus/monitor. A pre-warm holds the call up until warm_deadline even with no
     * tone yet (last_activity stays 0), so require both the keep-alive idle AND the warm window past. */
    /* An answered ring that feeds the camera stays up while someone watches (its FIFO drains), like
     * the camera's own call (recv's RECV_IDLE_SECONDS). */
    const int cam_watched = g_cam_on && g_call_is_ring && g_last_drain && time(NULL) - g_last_drain < 10;
    if (g_call && g_streams && !g_talk_active && !cam_watched && now - last_activity > keepalive_ms &&
        now > warm_deadline && now > talk_deadline) {
      printf("[opendoor] keep-alive idle -> hanging up\n");
      fflush(stdout);
      bye_call(lc);
    }
  }
  bye_call(lc);
}

int main(int argc, char **argv) {
  if (argc < 4) {
    fprintf(stderr,
            "usage: %s <in-username> <in-password> <out-sip-uri>\n"
            "  Registers ONCE, then reads commands from stdin, one per line, until stdin closes:\n"
            "    '1' / '2'  open the door / gate: a tone on the station call (placed if none is up);\n"
            "               answered with 'RESULT <d> ok|fail' on stdout, in the order received\n"
            "    'W'        pre-warm: open the call now, no tone (held OPENDOOR_PREWARM_HOLD_MS)\n"
            "    'H'        release: hang up a held call now\n"
            "    'T'        announcement: hold a call for a clip read from OPENDOOR_AUDIO_IN (s16le 8 kHz\n"
            "               mono PCM); OPENDOOR_TALK_DTMF = open-audio digit to send first (empty = none),\n"
            "               OPENDOOR_TALK_START_MS = how long the clip may take to start\n"
            "    'V <h264 fifo> <pcm fifo>'  show the held doorbell ring on the camera (early media, like\n"
            "               the app); answered with 'CAMERA ok|fail <why>', later 'CAMERA end'\n"
            "  OPENDOOR_KEEPALIVE_MS: keep the call up this long after the last tone so a follow-up tone\n"
            "    rides the same call (below 500 ms the call is still held 500 ms for the INFO to land).\n"
            "  OPENDOOR_ANSWER_RING=1: hold a doorbell ring unanswered ('RING held' / 'RING gone' on\n"
            "    stdout); an announcement or door press during it answers it (the station refuses new\n"
            "    calls while it rings).\n"
            "  env: OPENDOOR_DATA_DIR=<dir> (unique per place), OPENDOOR_UUID, OPENDOOR_MAC (phase-B\n"
            "    station: dial with a `mac` header, audio only), OPENDOOR_DEBUG=1 (SIP trace)\n",
            argv[0]);
    return 2;
  }
  const char *in_user = argv[1];
  const char *in_pass = argv[2];
  const char *out_uri = argv[3];

  const char *domain = "sip.urmet.com";
  const char *server = "sip:sip.urmet.com:5061;transport=tls";

  signal(SIGINT, on_sig);
  signal(SIGTERM, on_sig);

  LinphoneFactory *factory = linphone_factory_get();
  if (getenv("OPENDOOR_DEBUG")) {
    LinphoneLoggingService *ls = linphone_logging_service_get();
    linphone_logging_service_set_log_level(ls, LinphoneLogLevelDebug);
  }

  /* Writable, UNIQUE data dir (per place) - a shared sqlite DB corrupts account state. */
  const char *datadir = getenv("OPENDOOR_DATA_DIR");
  if (!datadir || !*datadir) datadir = "/tmp/lp_2v";
  linphone_factory_set_data_dir(factory, datadir);
  linphone_factory_set_config_dir(factory, datadir);
  linphone_factory_set_cache_dir(factory, datadir);

  LinphoneCore *lc = linphone_factory_create_core_3(factory, NULL, NULL, NULL);

  LinphoneCoreCbs *cbs = linphone_factory_create_core_cbs(factory);
  linphone_core_cbs_set_call_state_changed(cbs, on_call_state);
  linphone_core_cbs_set_registration_state_changed(cbs, on_reg_state);
  linphone_core_add_callbacks(lc, cbs);
  linphone_core_cbs_unref(cbs);

  /* TLS-only transport on a random local port (a fresh in-memory core disables TLS by default). */
  LinphoneTransports *tr = linphone_factory_create_transports(factory);
  linphone_transports_set_udp_port(tr, 0);
  linphone_transports_set_tcp_port(tr, 0);
  linphone_transports_set_tls_port(tr, -1 /* random */);
  linphone_core_set_transports(lc, tr);
  linphone_transports_unref(tr);

  /* Use the expected User-Agent -- some Urmet logic keys off it, and the station may gate on it. */
  linphone_core_set_user_agent(lc, "UrmetCallForwarding-Android", NULL);

  /* Offer VIDEO on the door-open call unless this is a phase-B station (OPENDOOR_MAC). A cloud-listed
   * 2Voice unit is a video door station and `auto_insertion` means "insert into the video entry call"
   * -- some panels (observed on a 1760/16) 403 an audio-only INVITE. We only RECEIVE video (recvonly,
   * discarded via the headless MSExtDisplay sink); enabling capture+display is required or liblinphone
   * marks the video stream inactive and never builds the graph. Phase-B accepts audio-only (confirmed
   * on a 1083/58A), so skip the H.264 graph there -- it is unused and expensive on 1 GB hosts. */
  /* Always the headless sink: if a station starts video anyway, this keeps mediastreamer off the
   * (non-existent) X display instead of "Could not open display :0". */
  linphone_core_set_video_display_filter(lc, "MSExtDisplay");
  const int want_video = !phase_b();
  linphone_core_enable_video_capture(lc, want_video);
  linphone_core_enable_video_display(lc, want_video);
  LinphoneVideoActivationPolicy *vap =
      linphone_factory_create_video_activation_policy(factory);
  /* Phase-B: refuse video outright, including a station's re-INVITE offering it. */
  linphone_video_activation_policy_set_automatically_accept(vap, want_video);
  linphone_video_activation_policy_set_automatically_initiate(vap, want_video);
  linphone_core_set_video_activation_policy(lc, vap);
  linphone_video_activation_policy_unref(vap);

  /* DTMF as SIP INFO, not RFC2833 (use_info=1, use_rfc2833=0) -- what the station expects for the
   * door-open tone. */
  linphone_core_set_use_info_for_dtmf(lc, TRUE);
  linphone_core_set_use_rfc2833_for_dtmf(lc, FALSE);

  /* Register the null sound card so an audio stream can negotiate headless (see the card above). */
  g_factory = linphone_core_get_ms_factory(lc);
  ms_snd_card_manager_register_desc(ms_factory_get_snd_card_manager(g_factory), &null_card_desc);
  /* Our H264 tap as the decoder (prepended, so it wins over openh264; see h264tap.h). */
  ms_factory_register_filter(g_factory, &tap_desc);
  load_black_frame();

  /* The station's TLS cert chain isn't ours to validate. */
  linphone_core_verify_server_certificates(lc, FALSE);
  linphone_core_verify_server_cn(lc, FALSE);

  /* STABLE RFC 5626 instance id. liblinphone keeps its `+sip.instance` UUID in `[misc] uuid` and
   * generates a random one when it is missing -- and our config lives in a per-place /tmp dir that
   * the container wipes, so every restart registered a NEW binding on the shared account instead of
   * replacing the old one. They then linger for the full 3600s expiry, and the registrar forks
   * incoming calls to all of them. A caller-supplied, deterministic uuid makes re-registration
   * replace our own binding. Must be set BEFORE linphone_core_start. */
  const char *uuid = getenv("OPENDOOR_UUID");
  if (uuid && *uuid)
    linphone_config_set_string(linphone_core_get_config(lc), "misc", "uuid", uuid);

  linphone_core_start(lc);
  /* A held ring must outlast the station's own ring (~60 s); liblinphone's default would give up on
   * it after 30 s. */
  linphone_core_set_inc_timeout(lc, 120);

  /* Point playback + capture at our null card. */
  {
    linphone_core_reload_sound_devices(lc);
    const char **snd = linphone_core_get_sound_devices(lc);
    for (int i = 0; snd && snd[i]; i++) {
      if (strstr(snd[i], "nullcard")) {
        linphone_core_set_playback_device(lc, snd[i]);
        linphone_core_set_capture_device(lc, snd[i]);
        break;
      }
    }
  }

  /* Force a single G.711 codec so a small, deterministic audio stream negotiates (matches recv.c
   * and the station's offer; the actual samples are silence and discarded). */
  {
    bctbx_list_t *pts = linphone_core_get_audio_payload_types(lc);
    for (bctbx_list_t *it = pts; it; it = it->next) {
      LinphonePayloadType *pt = (LinphonePayloadType *)it->data;
      const char *mime = linphone_payload_type_get_mime_type(pt);
      int keep = mime && (strcasecmp(mime, "PCMU") == 0 || strcasecmp(mime, "PCMA") == 0);
      linphone_payload_type_enable(pt, keep);
    }
    bctbx_list_free(pts);
  }

  /* Auth + registration for the INCOMING/channel account (identity = IN user). */
  LinphoneAuthInfo *ai = linphone_factory_create_auth_info(
      factory, in_user, NULL /*userid*/, in_pass, NULL /*ha1*/, NULL /*realm*/, domain);
  linphone_core_add_auth_info(lc, ai);
  linphone_auth_info_unref(ai);

  char identity[256];
  snprintf(identity, sizeof identity, "sip:%s@%s", in_user, domain);
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

  printf("[opendoor] registering %s -> %s\n", identity, out_uri);
  fflush(stdout);

  /* Wait for registration (bounded). It happens ONCE at startup, so later presses skip it. */
  {
    long long t0 = now_ms();
    while (g_running && !g_reg_ok && !g_reg_failed && now_ms() - t0 < 15000) {
      linphone_core_iterate(lc);
      usleep(50 * 1000);
    }
  }
  if (!g_reg_ok) {
    fprintf(stderr, "[opendoor] not registered -> aborting\n");
    linphone_core_stop(lc);
    linphone_core_unref(lc);
    return 1;
  }

  /* Stay registered and serve commands from stdin without re-registering -- each press then pays only
   * the call-setup time, not the ~2-3 s register. */
  long long keepalive_ms = 0;
  if (getenv("OPENDOOR_KEEPALIVE_MS")) keepalive_ms = atoll(getenv("OPENDOOR_KEEPALIVE_MS"));
  /* The add-on's `0` means "a fresh call per press"; the call is still held 500 ms after the tone so
   * the INFO lands before the BYE (what the former single-shot path did). */
  if (keepalive_ms < 500) keepalive_ms = 500;
  int fl = fcntl(STDIN_FILENO, F_GETFL, 0);
  fcntl(STDIN_FILENO, F_SETFL, fl | O_NONBLOCK);
  printf("[opendoor] registered (keep-alive %lld ms), waiting for commands on stdin\n", keepalive_ms);
  fflush(stdout);
  keepalive_loop(lc, factory, out_uri, keepalive_ms);

  linphone_core_stop(lc);
  linphone_core_unref(lc);
  return 0;
}
