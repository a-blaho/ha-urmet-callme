/*
 * opendoor.c - a single-shot liblinphone helper that opens a 2Voice (or other non-IPERCOM CallMe)
 * door. Auto-enabled whenever a 2Voice system is detected on the account; compiled into the image
 * next to recv (see ../Dockerfile) and spawned per unlock by src/door2voice.ts.
 *
 * WHY a separate binary (not the pure-Node open_door_req path): IPERCOM opens a door with a cloud
 * MESSAGE (open_door_req to the gateway). 2Voice has NO such command - the door is opened by placing
 * a real SIP CALL to the door station and sending an in-call DTMF tone (DOOR_DTMF='1', GATE_DTMF='2',
 * sent as a SIP INFO, not RFC2833). That couples door-open to liblinphone/media, so we reuse the
 * embedded stack here rather than hand-rolling a media call in Node.
 *
 * Flow (the 2Voice auto-insertion door-open, non-SER_PHASE_B families):
 *   1. register the place's INCOMING/channel account (argv IN user/pass) over TLS to sip.urmet.com
 *   2. place an OUTGOING audio INVITE to the OUTGOING account username (argv OUT uri) with a custom
 *      header `auto_insertion: true` so the station auto-answers without ringing the indoor monitor
 *   3. on StreamsRunning, send the DTMF digit (argv: '1' door / '2' gate) via SIP INFO
 *   4. hold briefly so the INFO lands, then hang up (BYE) and exit
 * Exit code 0 = the tone was delivered (door presumably opened); non-zero = register/answer/timeout
 * failure. No media is tapped - a void capture (silence) + null playback just satisfy liblinphone's
 * device lookup so a media stream negotiates and StreamsRunning fires.
 *
 * Usage: opendoor <in-username> <in-password> <out-sip-uri> <dtmf-digit>
 *   env: OPENDOOR_DATA_DIR (writable, unique per place - liblinphone's sqlite/config),
 *        OPENDOOR_UUID (stable +sip.instance id, so a restart REPLACES our registrar binding),
 *        OPENDOOR_TIMEOUT (overall seconds, default 40), OPENDOOR_DEBUG=1 (SIP trace).
 * Targets the same liblinphone C API (Debian trixie: liblinphone-dev) as recv.c.
 */
#include <linphone/core.h>
#include <mediastreamer2/msfilter.h>
#include <mediastreamer2/msfactory.h>
#include <mediastreamer2/msqueue.h>
#include <mediastreamer2/mssndcard.h>
#include <ortp/str_utils.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <time.h>
#include <unistd.h>

/* ---- A minimal sound card so an audio stream negotiates in a headless container. liblinphone
 * validates a capture AND a playback device at audio-stream setup even when we neither send nor
 * play real audio; without one it aborts the stream ("Failed to find audio device..."). The reader
 * is a void source (silence); the writer is a null sink that discards. This is the same trick recv.c
 * uses, minus the FIFO tap (door-open needs no audio content, only that a stream runs). ---- */
static MSFactory *g_factory = NULL;

typedef struct {
  int rate;
  int nch;
} NullSink;

static void nullsink_init(MSFilter *f) {
  NullSink *s = ms_new0(NullSink, 1);
  s->rate = 8000;
  s->nch = 1;
  f->data = s;
}
static void nullsink_process(MSFilter *f) {
  mblk_t *im;
  while ((im = ms_queue_get(f->inputs[0])) != NULL) freemsg(im); /* discard: no speaker */
}
static void nullsink_uninit(MSFilter *f) { ms_free(f->data); }
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
 * (silent) RTP cuts through immediately, as a live mic would. ---- */
typedef struct { int rate; int nch; } SilenceSrc;
static void silence_init(MSFilter *f) {
  SilenceSrc *s = ms_new0(SilenceSrc, 1);
  s->rate = 8000; /* G.711 forced -> 8 kHz mono; SET handlers below confirm */
  s->nch = 1;
  f->data = s;
}
static void silence_uninit(MSFilter *f) { ms_free(f->data); }
static void silence_process(MSFilter *f) {
  SilenceSrc *s = (SilenceSrc *)f->data;
  const int nsamp = s->rate / 100; /* ~10 ms per tick (mediastreamer default ticker) */
  const int bytes = nsamp * s->nch * 2; /* s16le */
  mblk_t *m = allocb(bytes, 0);
  memset(m->b_wptr, 0, bytes);
  m->b_wptr += bytes;
  ms_queue_put(f->outputs[0], m);
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
    .flags = 0,
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

static void on_sig(int _s) { (void)_s; g_running = 0; }

static void on_reg_state(LinphoneCore *lc, LinphoneProxyConfig *cfg,
                         LinphoneRegistrationState state, const char *message) {
  (void)lc; (void)cfg;
  printf("[opendoor] registration: %s (%s)\n",
         linphone_registration_state_to_string(state), message ? message : "");
  fflush(stdout);
  if (state == LinphoneRegistrationOk) g_reg_ok = 1;
  else if (state == LinphoneRegistrationFailed) g_reg_failed = 1;
}

static void on_call_state(LinphoneCore *lc, LinphoneCall *call,
                          LinphoneCallState state, const char *message) {
  (void)lc;
  printf("[opendoor] call state: %s\n", linphone_call_state_to_string(state));
  fflush(stdout);
  switch (state) {
  case LinphoneCallIncomingReceived:
    /* Persistent mode stays registered on the channel account, so a doorbell ring forks here too.
     * Decline (Busy) so we never answer -- the Node doorbell listener handles rings. (486 is a 4xx,
     * so Flexisip keeps forking to the listener's binding; it just drops us from this call.) */
    linphone_call_decline(call, LinphoneReasonBusy);
    break;
  case LinphoneCallStreamsRunning: {
    /* Report the NEGOTIATED media, not what we asked for -- a station can still answer with video. */
    const LinphoneCallParams *cur = linphone_call_get_current_params(call);
    printf("[opendoor] media up: audio%s\n",
           (cur && linphone_call_params_video_enabled(cur)) ? "+video" : " only");
    fflush(stdout);
    g_streams = 1;
    break;
  }
  case LinphoneCallError: {
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
    break;
  }
  case LinphoneCallEnd:
  case LinphoneCallReleased:
    printf("[opendoor] call finished: %s\n", message ? message : "");
    fflush(stdout);
    if (g_call == call) g_ended = 1;
    break;
  default:
    break;
  }
}

/* Monotonic milliseconds. */
static long long now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
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

/* Place an auto_insertion call to out_uri. Resets g_streams/g_ended, sets g_call (refed).
 * Uses the expected offer (UA + SRTP configured on the core). Returns the call or NULL. */
static LinphoneCall *place_call(LinphoneCore *lc, LinphoneFactory *factory, const char *out_uri) {
  g_streams = 0;
  g_ended = 0;
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
  }
  g_ended = 0; /* consume: place_call sets it fresh for the next call */
}

/* SINGLE-SHOT open: place a call, send DTMF on StreamsRunning, brief hold, BYE. Returns 0 if the tone
 * was delivered. (Persistent keep-alive mode calls place_call/bye_call directly -- see keepalive_loop.) */
static int run_open(LinphoneCore *lc, LinphoneFactory *factory, const char *out_uri, char digit,
                    int report) {
  if (!place_call(lc, factory, out_uri)) {
    if (report) { printf("[opendoor] RESULT %c fail\n", digit); fflush(stdout); }
    return 1;
  }
  const long long start = now_ms();
  const long long HOLD_AFTER_DTMF_MS = 500; /* the tone is out (door opens); brief settle then BYE */
  const long long OVERALL_MS = 40000;
  int dtmf_sent = 0;
  long long dtmf_at = 0;

  while (g_running) {
    linphone_core_iterate(lc);
    usleep(50 * 1000);
    const long long now = now_ms();
    if (!dtmf_sent && g_streams) {
      LinphoneStatus st = linphone_call_send_dtmf(g_call, digit);
      dtmf_sent = 1;
      dtmf_at = now;
      printf("[opendoor] streams running -> sent DTMF '%c' (status %d)\n", digit, (int)st);
      /* Report done as soon as the tone is out -- the door/gate opens now; the hold+BYE is teardown. */
      if (report) printf("[opendoor] RESULT %c ok\n", digit);
      fflush(stdout);
    }
    if (!dtmf_sent && now - start > OPENDOOR_STREAMS_TIMEOUT_MS) {
      fprintf(stderr, "[opendoor] no media within %ds (station busy / rejected?)\n",
              OPENDOOR_STREAMS_TIMEOUT_MS / 1000);
      break;
    }
    if (dtmf_sent && now - dtmf_at > HOLD_AFTER_DTMF_MS) { printf("[opendoor] done -> hanging up\n"); fflush(stdout); break; }
    if (g_ended && dtmf_sent) break;
    if (g_ended && !dtmf_sent) { fprintf(stderr, "[opendoor] call ended before media\n"); break; }
    if (now - start > OVERALL_MS) { fprintf(stderr, "[opendoor] overall timeout\n"); break; }
  }
  bye_call(lc);
  if (report && !dtmf_sent) { printf("[opendoor] RESULT %c fail\n", digit); fflush(stdout); }
  return dtmf_sent ? 0 : 1;
}

/* Send one tone on the active (already-running) call and report it. */
static void send_tone(char c, long long *last_activity, long long now) {
  LinphoneStatus st = linphone_call_send_dtmf(g_call, c);
  printf("[opendoor] sent DTMF '%c' (status %d)\n", c, (int)st);
  printf("[opendoor] RESULT %c ok\n", c);
  fflush(stdout);
  *last_activity = now;
}

/* PERSISTENT KEEP-ALIVE loop: hold the auto_insertion call up for `keepalive_ms` after the last tone
 * and send follow-up tones on the SAME call (instant repeat, e.g. door then gate),
 * then BYE on idle to release the 2Voice bus/monitor. Reads digits from stdin; reports RESULT per
 * command. keepalive_ms<=0 uses the simpler per-press path (see main). */
static void keepalive_loop(LinphoneCore *lc, LinphoneFactory *factory, const char *out_uri,
                           long long keepalive_ms) {
  long long last_activity = 0, call_placed_at = 0;
  long long warm_deadline = 0; /* a 'W' pre-warm holds the call up until here even with no tone yet */
  long long prewarm_hold = OPENDOOR_PREWARM_HOLD_MS;
  if (getenv("OPENDOOR_PREWARM_HOLD_MS")) prewarm_hold = atoll(getenv("OPENDOOR_PREWARM_HOLD_MS"));
  char queue[8]; /* tones waiting for StreamsRunning (the command that placed the call) */
  int qn = 0;

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
          if (place_call(lc, factory, out_uri)) {
            call_placed_at = now;
            printf("[opendoor] pre-warm: opening call (hold %llds)\n", prewarm_hold / 1000);
            fflush(stdout);
          }
        }
        continue;
      }
      if (c != '1' && c != '2') continue;
      if (g_call && g_streams) {
        send_tone(c, &last_activity, now); /* call up -> instant */
      } else {
        if (qn < (int)sizeof queue) queue[qn++] = c; /* queue until media */
        if (!g_call) {
          if (place_call(lc, factory, out_uri)) call_placed_at = now;
          else { for (int i = 0; i < qn; i++) printf("[opendoor] RESULT %c fail\n", queue[i]); qn = 0; fflush(stdout); }
        }
      }
    }

    /* Call reached media -> flush queued tones. */
    if (g_call && g_streams && qn > 0) {
      for (int i = 0; i < qn; i++) send_tone(queue[i], &last_activity, now);
      qn = 0;
    }
    /* Placed but no media in time -> fail queued + tear down. */
    if (g_call && !g_streams && now - call_placed_at > OPENDOOR_STREAMS_TIMEOUT_MS) {
      fprintf(stderr, "[opendoor] no media within %ds (station busy / rejected?)\n",
              OPENDOOR_STREAMS_TIMEOUT_MS / 1000);
      for (int i = 0; i < qn; i++) printf("[opendoor] RESULT %c fail\n", queue[i]);
      qn = 0; fflush(stdout);
      bye_call(lc);
    }
    /* Station ended the call on its own. */
    if (g_ended) {
      for (int i = 0; i < qn; i++) printf("[opendoor] RESULT %c fail\n", queue[i]);
      if (qn > 0) fflush(stdout);
      qn = 0;
      bye_call(lc);
    }
    /* Idle -> release the bus/monitor. A pre-warm holds the call up until warm_deadline even with no
     * tone yet (last_activity stays 0), so require both the keep-alive idle AND the warm window past. */
    if (g_call && g_streams && now - last_activity > keepalive_ms && now > warm_deadline) {
      printf("[opendoor] keep-alive idle -> hanging up\n");
      fflush(stdout);
      bye_call(lc);
    }
  }
  bye_call(lc);
}

int main(int argc, char **argv) {
  int persistent = getenv("OPENDOOR_PERSISTENT") != NULL;
  if (argc < (persistent ? 4 : 5)) {
    fprintf(stderr,
            "usage: %s <in-username> <in-password> <out-sip-uri> [<dtmf-digit>]\n"
            "  single-shot: place one call, send <dtmf-digit> (1=door / 2=gate), exit.\n"
            "  OPENDOOR_PERSISTENT=1: register ONCE, then read digits ('1'/'2') from stdin, one open\n"
            "    per line, printing 'RESULT <d> ok|fail'; exit when stdin closes. (Faster: each press\n"
            "    skips the SIP register.)\n"
            "  env: OPENDOOR_DATA_DIR=<dir> (unique per place), OPENDOOR_DEBUG=1 (SIP trace)\n",
            argv[0]);
    return 2;
  }
  const char *in_user = argv[1];
  const char *in_pass = argv[2];
  const char *out_uri = argv[3];
  char digit = persistent ? 0 : argv[4][0];
  if (!persistent && digit != '1' && digit != '2') {
    fprintf(stderr, "[opendoor] bad DTMF digit '%c' (expected 1=door / 2=gate)\n", digit);
    return 2;
  }

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

  printf("[opendoor] registering %s (mode=%s) -> %s\n",
         identity, persistent ? "persistent" : "single-shot", out_uri);
  fflush(stdout);

  /* Wait for registration (bounded). Both modes need the account registered before calling; in
   * persistent mode this happens ONCE at startup, so later presses skip it. */
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

  int rc = 0;
  if (persistent) {
    /* Stay registered and serve open commands from stdin ('1'/'2', one per line) without
     * re-registering -- each press then pays only the call-setup time, not the ~2-3s register. */
    long long keepalive_ms = 0;
    if (getenv("OPENDOOR_KEEPALIVE_MS")) keepalive_ms = atoll(getenv("OPENDOOR_KEEPALIVE_MS"));
    int fl = fcntl(STDIN_FILENO, F_GETFL, 0);
    fcntl(STDIN_FILENO, F_SETFL, fl | O_NONBLOCK);
    if (keepalive_ms > 0) {
      /* Keep the call up for keepalive_ms and send follow-up tones on it (instant door-then-gate). */
      printf("[opendoor] persistent (keep-alive %llds): registered, waiting for commands on stdin\n",
             keepalive_ms / 1000);
      fflush(stdout);
      keepalive_loop(lc, factory, out_uri, keepalive_ms);
    } else {
      /* Simple: one call per press, BYE each time (keepalive disabled). */
      printf("[opendoor] persistent: registered, waiting for commands on stdin\n");
      fflush(stdout);
      while (g_running) {
        linphone_core_iterate(lc); /* refreshes the registration while idle */
        usleep(50 * 1000);
        char c;
        ssize_t n = read(STDIN_FILENO, &c, 1);
        if (n == 0) break; /* stdin closed -> the control plane stopped us -> exit */
        if (n == 1 && (c == '1' || c == '2'))
          run_open(lc, factory, out_uri, c, 1); /* prints RESULT (ok as soon as the tone is out) */
      }
    }
  } else {
    rc = run_open(lc, factory, out_uri, digit, 0);
    if (rc == 0)
      printf("[opendoor] SUCCESS: %s tone delivered\n", digit == '1' ? "door" : "gate");
    else
      fprintf(stderr, "[opendoor] FAILED: tone not delivered\n");
    fflush(stdout);
  }

  linphone_core_stop(lc);
  linphone_core_unref(lc);
  return rc;
}
