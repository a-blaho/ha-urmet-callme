/* SPDX-License-Identifier: GPL-3.0-or-later (links liblinphone, GPLv3) */
/*
 * recv.c - the embedded liblinphone receiver for IPERCOM cameras. Compiled into the add-on image (see
 * ../Dockerfile) and spawned ONCE by src/video.ts (the VideoService): a single receiver serves every
 * camera, one call at a time. (2Voice cameras are served by station.c, which places its own calls.)
 *
 * liblinphone (mediastreamer2) is the ONLY stack that made the Urmet relay actually stream the panel's
 * H.264 - pure-Node and baresip both got 0 media. So the media leg embeds real liblinphone here, driven
 * by the Node/TS control plane. This program registers the shared dedicated SIP account B, auto-answers
 * the panel's INVITE, and taps the received media WITHOUT decoding/re-encoding:
 *   - H.264: a custom mediastreamer "decoder" filter depacketizes (rfc3984) to Annex-B and writes the
 *     byte stream to a FIFO (h264tap.h; line 0 of RECV_TARGET_FILE)
 *   - audio: a custom mediastreamer sound card writes the decoded PCM (s16le) to a FIFO (lpcommon.h;
 *     line 1 of RECV_TARGET_FILE); a single G.711 codec is forced so the PCM is 8 kHz mono
 * ffmpeg (in stream.sh) reads both FIFOs and hands them to go2rtc -> HA.
 *
 * Announcements (issue #24): a 'T' on stdin opens the call's audio the way the official app's
 * "open audio" does on Ipercom -- a re-INVITE with audio SendRecv (LinphoneSipCallActionPerformer
 * .openAudio) -- on the call that is up, or on the next one once its media runs. The capture side
 * then plays the clip the control plane writes into RECV_AUDIO_IN (talkout.h), in place of silence.
 *
 * Doorbell rings (issue #24): a panel that is ringing ignores camera calls, so an announcement during
 * a ring has to go out on the ring itself. recv therefore also registers the places' doorbell (channel)
 * accounts (RECV_RING_ACCOUNTS; the registrar forks the ring here and to the Node doorbell listener and
 * the phones), holds the ring unanswered ("RECV RING held <panel>" on stdout) and answers it on an 'R'
 * on stdin, the way the app answers (audio SendRecv, video RecvOnly). Answering takes the call, so the
 * phones stop ringing. An 'E' instead shows the ring on the camera without answering it: early media,
 * as the app's "view camera" on its incoming-call screen, so the phones keep ringing.
 *
 * The call is placed by the control plane (src/callme.ts, from account A) via call_device_req with
 * uri_to_call/response_uri pointed at account B, so the gateway routes the panel INVITE here. This
 * program only registers + answers + taps; teardown is an in-dialog BYE, on SIGUSR1 from the control
 * plane (a camera switch or the "hang up" button) or after an idle timeout (no FIFO reader for
 * RECV_IDLE_SECONDS). It stays registered for the next call.
 *
 * Usage: recv <B-username> <B-password>   (see the env vars documented at main()).
 */
#include <stdarg.h>
#include <stdio.h>
#include <sys/time.h>
#include <time.h>

/* Timestamped log line. The control plane stamps every line and liblinphone stamps its own, so without
 * a stamp here the order of "audio started", "first keyframe" and "ffmpeg attached" could not be told
 * from a user's log. Everything goes to STDOUT ([atap]/[tap] included), so lines stay in order. */
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
#define TAP_LOG rlog
#include "lpcommon.h"
#include <fcntl.h>

/* The PCM FIFO for the CURRENT call: line 1 of RECV_TARGET_FILE, read when the per-call graph starts
 * (the control plane writes the file before placing each call; see h264tap.h read_target_line). */
static void lp_atap_target(char *out, size_t outsz) { read_target_line(out, outsz, 1); }

/* Fire-and-forget an HTTP GET to the URL in env var `name` (if set), backgrounded (`&`) so it never
 * blocks the media loop. Used to ping the control plane: call connected / over / please hang up. */
static void fire_url(const char *name) {
  const char *url = getenv(name);
  if (!url || !*url) return;
  char cmd[512];
  snprintf(cmd, sizeof cmd, "curl -fsS -m 5 '%s' >/dev/null 2>&1 &", url);
  (void)!system(cmd);
}

static LinphoneCall *g_call = NULL; /* the active call, if any */
static volatile sig_atomic_t g_running = 1;
static volatile int g_reg_ok = 0;
static volatile int g_reg_failed = 0;
static int g_idle_seconds = 10;     /* RECV_IDLE_SECONDS: hang up if no reader drains this long */
static time_t g_video_deadline = 0; /* nudge for a keyframe until this time; give up if none (0=off) */
static time_t g_last_vfu = 0;       /* last keyframe nudge, to rate-limit to ~1/s */
/* SIGUSR1: end the CURRENT call now (in-dialog BYE) but keep the process registered for the next one.
 * This is how the control plane (src/video.ts) switches/closes cameras: a clean in-dialog BYE from
 * account B to the door station (a BYE only -- no gateway cancel_call_req). */
static volatile sig_atomic_t g_hangup_req = 0;
/* SIGUSR2: a NEW reader just attached to a call that is already streaming (the control plane reused
 * the live call instead of re-calling -- the instant flip-back). Ask the panel for a keyframe so the
 * new reader decodes now rather than at the panel's next periodic IDR. */
static volatile sig_atomic_t g_vfu_req = 0;

/* Announcement state (stdin 'T'). g_talk_want: a clip is expected on this call (or the next one):
 * open its audio once media runs and keep the call up until the clip has played. g_talk_seq counts
 * the 'T's received; RECV_TALK_DONE_URL carries it so the control plane can tell this announcement's
 * end from a stale one. */
static int g_talk_want = 0;
static long g_talk_seq = 0;
static long long g_talk_deadline = 0; /* give up waiting for the clip at this monotonic ms */
static int g_audio_opening = 0;       /* re-INVITE (audio SendRecv) sent on this call */
static int g_streams_seen = 0;        /* first StreamsRunning of this call happened */
static int g_hold_fd[2] = {-1, -1};   /* extra writers on this call's FIFOs (see hold_fifos) */
#define TALK_CALL_WAIT_MS 20000       /* 'T' with no call: the panel's INVITE + media must come by then */
#define TALK_START_MS 25000           /* after the audio is open, the clip must start within this */

/* While the audio is renegotiated, liblinphone may rebuild the call's audio graph: the PCM tap closes
 * its FIFO and opens it again. With no other writer, ffmpeg (stream.sh) would read EOF in between and
 * drop the viewer's audio. Hold a writer on both of the call's FIFOs for the rest of the call. */
static void hold_fifos(int on) {
  for (int k = 0; k < 2; k++) {
    if (on && g_hold_fd[k] < 0) {
      char path[256];
      read_target_line(path, sizeof path, k);
      if (path[0]) g_hold_fd[k] = open(path, O_RDWR | O_NONBLOCK);
    } else if (!on && g_hold_fd[k] >= 0) {
      close(g_hold_fd[k]);
      g_hold_fd[k] = -1;
    }
  }
}

/* The announcement is over (played, given up, or its call ended): tell the control plane. */
static void talk_done(const char *why) {
  if (!g_talk_want && !g_talk_active) return;
  rlog("[recv] announce: %s\n", why);
  g_talk_want = 0;
  g_talk_deadline = 0;
  const char *url = getenv("RECV_TALK_DONE_URL");
  if (url && *url) {
    char cmd[512];
    snprintf(cmd, sizeof cmd, "curl -fsS -m 5 '%s?seq=%ld' >/dev/null 2>&1 &", url, g_talk_seq);
    (void)!system(cmd);
  }
}

/* The app's Ipercom "open audio": re-INVITE the call with audio SendRecv, everything else as is. */
static void open_audio(LinphoneCore *lc, LinphoneCall *call) {
  g_audio_opening = 1;
  const LinphoneCallParams *cp = linphone_call_get_current_params(call);
  if (cp && linphone_call_params_get_audio_direction(cp) == LinphoneMediaDirectionSendRecv) {
    rlog("[recv] announce: the call's audio is already open (sendrecv)\n");
    return;
  }
  hold_fifos(1);
  LinphoneCallParams *p = linphone_core_create_call_params(lc, call);
  linphone_call_params_set_audio_direction(p, LinphoneMediaDirectionSendRecv);
  LinphoneStatus st = linphone_call_update(call, p);
  linphone_call_params_unref(p);
  rlog("[recv] announce: opening the call's audio (re-INVITE, audio sendrecv) -> %s\n",
       st == 0 ? "sent" : "FAILED");
}

/* The doorbell accounts (RECV_RING_ACCOUNTS) and the ring held unanswered on one of them, if any. */
#define MAX_RING_ACCOUNTS 8
static const char *g_ring_users[MAX_RING_ACCOUNTS];
static int g_n_ring_users = 0;
static LinphoneCall *g_ring = NULL;
static int g_ring_early = 0; /* the held ring is streaming early media to the camera FIFOs */

static int is_ring_account(const char *user) {
  for (int i = 0; user && i < g_n_ring_users; i++)
    if (strcmp(g_ring_users[i], user) == 0) return 1;
  return 0;
}

/* Show the held ring on the camera without answering it, the app's check and call
 * (LinphoneSipCallActionPerformer.acceptEarlyMedia). The FIFOs come from RECV_TARGET_FILE, which the
 * control plane wrote first. The ring may end or be answered at any time, and answering can rebuild the
 * graphs, so hold a writer on the FIFOs until then. */
static void ring_picture(void) {
  if (!g_ring) {
    rlog("[recv] ring: camera asked for the ring, but none is held\n");
    printf("RECV RING gone\n");
    fflush(stdout);
    return;
  }
  if (g_ring_early) {
    rlog("[recv] ring: already streaming it\n");
    return;
  }
  /* The panel's own offer, as the app's remoteSendVideo: our current params are empty before an answer. */
  const LinphoneCallParams *rp = linphone_call_get_remote_params(g_ring);
  LinphoneMediaDirection vd = rp && linphone_call_params_video_enabled(rp)
                                  ? linphone_call_params_get_video_direction(rp)
                                  : LinphoneMediaDirectionInactive;
  if (vd != LinphoneMediaDirectionSendOnly && vd != LinphoneMediaDirectionSendRecv) {
    rlog("[recv] ring: the panel sends no video on this ring (%s)\n", dir_name(vd));
    return;
  }
  hold_fifos(1);
  g_keyframe_seen = 0;
  LinphoneStatus st = linphone_call_accept_early_media(g_ring);
  g_ring_early = st == 0;
  rlog("[recv] ring: showing it on the camera (early media; the phones keep ringing) -> %s\n",
       st == 0 ? "ok" : "FAILED");
  if (st != 0) hold_fifos(0);
}

/* Answer the held ring like the app answers a ring (LinphoneSipCallActionPerformer.accept: audio
 * SendRecv, video RecvOnly) and make it THE call. 1 = answered. */
static int answer_ring(LinphoneCore *lc) {
  if (!g_ring || g_call) return 0;
  LinphoneCall *c = g_ring;
  g_ring = NULL;
  g_ring_early = 0; /* its FIFO hold, if any, now ends with the call (or below, on a failure) */
  printf("RECV RING gone\n"); /* no longer held, whatever happens below */
  fflush(stdout);
  LinphoneCallState st = linphone_call_get_state(c);
  if (st != LinphoneCallIncomingReceived && st != LinphoneCallIncomingEarlyMedia) {
    hold_fifos(0);
    linphone_call_unref(c);
    return 0;
  }
  LinphoneCallParams *p = linphone_core_create_call_params(lc, c);
  linphone_call_params_enable_audio(p, TRUE);
  linphone_call_params_set_audio_direction(p, LinphoneMediaDirectionSendRecv);
  linphone_call_params_enable_video(p, TRUE);
  linphone_call_params_set_video_direction(p, LinphoneMediaDirectionRecvOnly);
  /* Per-call state BEFORE accepting: the media comes up inside the accept (see the camera answer). */
  g_call = c;
  g_keyframe_seen = 0;
  g_streams_seen = 0;
  g_audio_opening = 0;
  LinphoneStatus rc = linphone_call_accept_with_params(c, p);
  linphone_call_params_unref(p);
  rlog("[recv] ring: answering the doorbell call for the announcement (%s)\n",
       rc == 0 ? "ok; the phones stop ringing" : "FAILED, declining it");
  if (rc != 0) {
    g_call = NULL;
    hold_fifos(0);
    linphone_call_decline(c, LinphoneReasonBusy);
  }
  linphone_call_unref(c); /* the core keeps a live call; g_call is a plain pointer, as for a camera call */
  return rc == 0;
}

static void on_sigint(int _sig) { (void)_sig; g_running = 0; }
static void on_sigusr1(int _sig) { (void)_sig; g_hangup_req = 1; }
static void on_sigusr2(int _sig) { (void)_sig; g_vfu_req = 1; }

static void on_reg_state(LinphoneCore *lc, LinphoneProxyConfig *cfg,
                         LinphoneRegistrationState state, const char *message) {
  (void)lc; (void)cfg;
  rlog("[recv] registration: %s (%s)\n",
       linphone_registration_state_to_string(state), message ? message : "");
  if (state == LinphoneRegistrationOk) g_reg_ok = 1;
  else if (state == LinphoneRegistrationFailed) g_reg_failed = 1;
}

static void on_global_state(LinphoneCore *lc, LinphoneGlobalState state, const char *message) {
  (void)lc;
  rlog("[recv] global state: %s (%s)\n",
       linphone_global_state_to_string(state), message ? message : "");
}

static void on_call_state(LinphoneCore *lc, LinphoneCall *call,
                          LinphoneCallState state, const char *message) {
  rlog("[recv] call state: %s\n", linphone_call_state_to_string(state));
  /* The held ring ended before anyone needed it (answered elsewhere, or the panel gave up). */
  if (call == g_ring &&
      (state == LinphoneCallEnd || state == LinphoneCallError || state == LinphoneCallReleased)) {
    rlog("[recv] ring: ended (%s)\n", message ? message : "");
    linphone_call_unref(g_ring);
    g_ring = NULL;
    g_ring_early = 0;
    g_last_drain = 0;
    hold_fifos(0); /* the viewer's ffmpeg sees the end of the picture */
    printf("RECV RING gone\n");
    fflush(stdout);
    return;
  }
  switch (state) {
  case LinphoneCallIncomingReceived: {
    /* A doorbell ring on a channel account (the camera calls come to account B). Hold ONE, ringing
     * like the phones and the Node listener; otherwise decline it for us only (486 is a 4xx, so the
     * registrar keeps forking to the other bindings). */
    const LinphoneAddress *to = linphone_call_get_to_address(call);
    if (to && is_ring_account(linphone_address_get_username(to))) {
      const LinphoneAddress *rf = linphone_call_get_remote_address(call);
      const char *panel = rf ? linphone_address_get_username(rf) : NULL;
      if (!g_ring && !g_call) {
        g_ring = linphone_call_ref(call);
        rlog("[recv] ring: holding the doorbell call from %s unanswered (an announcement to this "
             "panel answers it)\n", panel ? panel : "?");
        printf("RECV RING held %s\n", panel ? panel : "?");
        fflush(stdout);
      } else {
        rlog("[recv] ring: from %s while %s -> leaving it to the phones\n", panel ? panel : "?",
             g_ring ? "another ring is held" : "a call is up");
        linphone_call_decline(call, LinphoneReasonBusy);
      }
      break;
    }
    /* ONE call at a time. If a call is still up, the control plane failed to end it before placing
     * the next one (it waits for our RECV_ENDED_URL ping, so this should not happen). Accepting
     * would make liblinphone PAUSE the live call: the panel then holds a zombie on-hold call that
     * blocks every later camera request until its session timer expires (minutes). Decline
     * instead, loudly -- a failed view is recoverable, a zombie call is not. */
    if (g_call) {
      rlog("[recv] DECLINING inbound INVITE: a call is already up (control plane did not BYE it)\n");
      linphone_call_decline(call, LinphoneReasonBusy);
      break;
    }
    /* Diagnostic: which physical panel (INVITE From = its topological code) is calling which of
     * our streams (identified by the H264 FIFO). If a stream ever answers an INVITE From the WRONG
     * panel, the gateway/panel crossed the split-account routing (the feed-swap bug). */
    const LinphoneAddress *from = linphone_call_get_remote_address(call);
    const char *fromu = from ? linphone_address_get_username(from) : NULL;
    char outfifo[256];
    read_target_line(outfifo, sizeof outfifo, 0);
    rlog("[recv] INVITE FROM %s -> stream %s\n", fromu ? fromu : "?", outfifo[0] ? outfifo : "?");
    {
      const LinphoneCallParams *rp = linphone_call_get_remote_params(call);
      rlog("[recv] panel's audio offer: %s\n",
           rp ? dir_name(linphone_call_params_get_audio_direction(rp)) : "?");
    }
    rlog("[recv] incoming call -> answering (audio+video recvonly, H264 tap + PCM tap)\n");
    /* Per-call state is set BEFORE accepting: accept_with_params runs the Connected and
     * StreamsRunning callbacks synchronously, nested in this one, and they use it. */
    g_call = call;
    g_keyframe_seen = 0; /* reset per call; gate output until this call's first IDR (tap `started`) */
    g_streams_seen = 0;
    g_audio_opening = 0;
    LinphoneCallParams *p = linphone_core_create_call_params(lc, call);
    linphone_call_params_enable_audio(p, TRUE);
    linphone_call_params_set_audio_direction(p, LinphoneMediaDirectionRecvOnly);
    linphone_call_params_enable_video(p, TRUE);
    linphone_call_params_set_video_direction(p, LinphoneMediaDirectionRecvOnly);
    linphone_call_accept_with_params(call, p);
    linphone_call_params_unref(p);
    break;
  }
  case LinphoneCallStreamsRunning: {
    {
      const LinphoneCallParams *cp = linphone_call_get_current_params(call);
      const LinphoneCallParams *rp = linphone_call_get_remote_params(call);
      rlog("[recv] negotiated audio direction: %s (remote %s), video %s\n",
           cp ? dir_name(linphone_call_params_get_audio_direction(cp)) : "?",
           rp ? dir_name(linphone_call_params_get_audio_direction(rp)) : "?",
           cp ? dir_name(linphone_call_params_get_video_direction(cp)) : "?");
    }
    /* A re-INVITE we sent (open audio) lands here again: the call was already set up, so none of
     * the per-call start below applies. */
    if (g_streams_seen) {
      rlog("[recv] streams running again (call updated)\n");
      break;
    }
    g_streams_seen = 1;
    rlog("[recv] streams running -> tapping H264\n");
    /* Do NOT start the reader-idle clock yet. With tap-gating we write NOTHING until the first
     * keyframe, so counting this pre-keyframe wait as "no reader" would tear the call down before
     * it ever streams (esp. with a short RECV_IDLE_SECONDS). The idle clock starts on the first
     * actual write (tap_write, or when g_keyframe_seen fires in the main loop). */
    g_last_drain = 0;
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
    /* Not THE call (a ring we declined): nothing of the call that is up may change. */
    if (call != g_call) {
      rlog("[recv] other call ended: %s\n", message ? message : "");
      break;
    }
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
    if (g_call == call) {
      g_call = NULL;
      hold_fifos(0);
      g_streams_seen = 0;
      g_audio_opening = 0;
      talk_done("the call ended");
    }
    g_last_drain = 0;
    g_video_deadline = 0;
    /* Tell the control plane the dialog is really over (our BYE was answered, or the panel hung
     * up). A camera SWITCH waits for this before placing the next call, like the app does (BYE ->
     * 200 OK -> next call_device_req), instead of racing the BYE with the new request. */
    fire_url("RECV_ENDED_URL");
    break;
  }
  case LinphoneCallPausedByRemote:
  case LinphoneCallUpdatedByRemote:
  case LinphoneCallPaused:
  case LinphoneCallResuming:
  case LinphoneCallUpdating: {
    const LinphoneCallParams *rp = linphone_call_get_remote_params(call);
    rlog("[recv]   remote now offers audio %s, video %s\n",
         rp ? dir_name(linphone_call_params_get_audio_direction(rp)) : "?",
         rp ? dir_name(linphone_call_params_get_video_direction(rp)) : "?");
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
            "  env (set by src/video.ts): RECV_TARGET_FILE=<file> (line 0 = the H.264 FIFO, line 1 = "
            "the PCM FIFO; s16le 8k mono), RECV_DATA_DIR=<dir> (per-recv, MUST be unique), "
            "RECV_UUID=<uuid> (stable +sip.instance id so a restart replaces our binding), "
            "RECV_HANGUP_URL=<url> (pinged on the idle hang-up), "
            "RECV_CONNECTED_URL=<url> (pinged at StreamsRunning), "
            "RECV_ENDED_URL=<url> (pinged when the call is over), "
            "RECV_IDLE_SECONDS=<n> (default 10), RECV_AUDIO_IN=<fifo> (announcement PCM, s16le 8k "
            "mono), RECV_TALK_WARMUP_MS=<ms> (silence before the clip once the audio is open: the panel's "
            "speaker comes on late; default 0), "
            "RECV_TALK_DONE_URL=<url> (pinged with ?seq=<n> when an announcement is over), "
            "RECV_RING_ACCOUNTS=<user pass, a line each> (doorbell accounts: hold their rings), "
            "SIP_REALM, RECV_DEBUG=1 (per-second audio level, "
            "RTP counters, liblinphone warnings), RECV_TRACE=1 (liblinphone's full trace)\n"
            "  SIGUSR1 ends the current call (in-dialog BYE) and stays registered; SIGUSR2 asks the "
            "panel for a keyframe (a reader re-attached to the live call).\n"
            "  stdin, one letter per line: T = announcement: open the audio of the call that is up "
            "(or of the next one) and hold it until the clip from RECV_AUDIO_IN has played; R = the "
            "same on the held doorbell ring, answering it; E = show the held ring on the camera without "
            "answering it (early media). stdin closing is ignored.\n"
            "  stdout machine lines: RECV RING held <panel> | RECV RING gone.\n",
            argv[0]);
    return 2;
  }
  const char *user = argv[1];
  const char *pass = argv[2];
  if (getenv("RECV_IDLE_SECONDS")) g_idle_seconds = atoi(getenv("RECV_IDLE_SECONDS"));
  load_black_frame(); /* canned keyframe for early track advertisement (see g_black) */
  lp_talk_env = "RECV_AUDIO_IN"; /* the capture side plays announcements from this FIFO */
  if (getenv("RECV_TALK_WARMUP_MS")) g_talk_warmup_ms = atoll(getenv("RECV_TALK_WARMUP_MS"));
  int stdin_open = 1;
  {
    int fl = fcntl(STDIN_FILENO, F_GETFL, 0);
    if (fl < 0 || fcntl(STDIN_FILENO, F_SETFL, fl | O_NONBLOCK) < 0) stdin_open = 0;
  }
  long talk_clips = g_talk_clips;

  signal(SIGINT, on_sigint);
  signal(SIGTERM, on_sigint);
  signal(SIGUSR1, on_sigusr1); /* control plane: hang up the current call, stay registered */
  signal(SIGUSR2, on_sigusr2); /* control plane: new reader on the live call -> request a keyframe */

  LinphoneCoreCbs *cbs = linphone_factory_create_core_cbs(linphone_factory_get());
  linphone_core_cbs_set_call_state_changed(cbs, on_call_state);
  linphone_core_cbs_set_registration_state_changed(cbs, on_reg_state);
  linphone_core_cbs_set_global_state_changed(cbs, on_global_state);
  LpSetup setup = {
      .tag = "[recv]",
      .user = user,
      .pass = pass,
      .data_dir = getenv("RECV_DATA_DIR"),
      .uuid = getenv("RECV_UUID"),
      .want_video = 1,
      .accept_video = 1,
      .auto_initiate = 0, /* inbound only: accept the panel's video, never offer */
      .debug = getenv("RECV_DEBUG") != NULL,
      .trace = getenv("RECV_TRACE") != NULL,
  };
  LinphoneCore *lc = lp_create_core(&setup, cbs);
  linphone_core_cbs_unref(cbs);

  /* The doorbell accounts, next to our own (never the default: we place no calls). */
  if (getenv("RECV_RING_ACCOUNTS")) {
    char *list = strdup(getenv("RECV_RING_ACCOUNTS")); /* kept: g_ring_users points into it */
    for (char *line = strtok(list, "\n"); line && g_n_ring_users < MAX_RING_ACCOUNTS;
         line = strtok(NULL, "\n")) {
      char *sp = strchr(line, ' ');
      if (!sp) continue;
      *sp = '\0';
      g_ring_users[g_n_ring_users++] = line;
      lp_add_account(lc, "[recv]", line, sp + 1, 0);
    }
  }

  while (g_running) {
    linphone_core_iterate(lc);
    usleep(50 * 1000);
    /* Commands from the control plane (src/video.ts). */
    while (stdin_open) {
      char c;
      ssize_t n = read(STDIN_FILENO, &c, 1);
      if (n == 0) { stdin_open = 0; break; } /* no control plane on stdin (run by hand): ignore */
      if (n < 0) break;                      /* EAGAIN: nothing more right now */
      if (c == 'E') {
        ring_picture();
        continue;
      }
      if (c != 'T' && c != 'R') continue;
      g_talk_seq++;
      g_talk_want = 1;
      g_talk_deadline = talk_now_ms() + TALK_CALL_WAIT_MS + TALK_START_MS;
      if (c == 'R') {
        if (answer_ring(lc))
          rlog("[recv] announce #%ld: requested -> on the doorbell call\n", g_talk_seq);
        else
          talk_done("the doorbell call could not be answered (the ring is over, or a call is up)");
      } else if (!g_call)
        rlog("[recv] announce #%ld: requested -> waiting for the panel's call\n", g_talk_seq);
      else if (!g_streams_seen)
        rlog("[recv] announce #%ld: requested -> the call is being set up\n", g_talk_seq);
      else
        rlog("[recv] announce #%ld: requested -> riding the call already up\n", g_talk_seq);
    }
    /* Announcement: open the audio once the call's media runs (not mid-update), then hold the call
     * until the clip has played. */
    if (g_talk_want && g_call && g_streams_seen && !g_audio_opening) {
      /* Any settled state will do; only a renegotiation or teardown in progress must be waited out
       * (the state reported after StreamsRunning is not always StreamsRunning itself). */
      const LinphoneCallState cs = linphone_call_get_state(g_call);
      const int busy = cs == LinphoneCallUpdating || cs == LinphoneCallUpdatedByRemote ||
                       cs == LinphoneCallPausing || cs == LinphoneCallResuming ||
                       cs == LinphoneCallPaused || cs == LinphoneCallPausedByRemote ||
                       cs == LinphoneCallEnd || cs == LinphoneCallError || cs == LinphoneCallReleased;
      static LinphoneCallState logged = LinphoneCallIdle;
      if (!busy) {
        rlog("[recv] announce: call state %s -> opening its audio\n", linphone_call_state_to_string(cs));
        open_audio(lc, g_call);
        g_talk_deadline = talk_now_ms() + TALK_START_MS; /* the clip must start within this from here */
        logged = LinphoneCallIdle;
      } else if (cs != logged) {
        logged = cs;
        rlog("[recv] announce: waiting for the call to settle (state %s)\n", linphone_call_state_to_string(cs));
      }
    }
    if (g_talk_active) g_talk_deadline = 0; /* playing: no deadline until it ends */
    if (g_talk_clips != talk_clips) {
      talk_clips = g_talk_clips;
      talk_done("clip played");
      /* With no viewer, the idle hang-up counts from the clip's end (also when no keyframe ever came,
       * which left the idle clock unstarted). */
      if (g_call) g_last_drain = time(NULL);
    }
    if (g_talk_want && !g_talk_active && g_talk_deadline && talk_now_ms() > g_talk_deadline) {
      talk_done(g_call ? "no audio arrived in time; giving up" : "no call came up; giving up");
      if (g_call) g_last_drain = time(NULL);
    }
    /* While a clip is wanted or playing the call is in use, viewer or not. */
    const int talking = g_talk_want || g_talk_active;
    if (talking && g_call && g_last_drain) g_last_drain = time(NULL);
    /* Control plane asked us to end the current call (camera switch / viewer closed). Terminate
     * the dialog -- liblinphone sends the in-dialog BYE to the door station -- and stay registered.
     * Do NOT fire RECV_HANGUP_URL here: the control plane initiated this, and pinging it back would
     * loop. The natural reader-idle timeout still covers the case where the viewer just vanishes. */
    if (g_hangup_req) {
      g_hangup_req = 0;
      if (g_call) {
        rlog("[recv] SIGUSR1 -> terminating current call (in-dialog BYE)\n");
        linphone_call_terminate(g_call);
        g_last_drain = 0;
        g_video_deadline = 0;
      } else {
        rlog("[recv] SIGUSR1 with no call up -> nothing to end\n");
      }
    }
    /* A reader re-attached to the live call (flip-back): one keyframe nudge so it decodes at once. */
    if (g_vfu_req) {
      g_vfu_req = 0;
      if (g_call) {
        linphone_call_send_vfu_request(g_call);
        send_pfu_info(g_call);
        rlog("[recv] SIGUSR2 -> keyframe requested for the re-attached reader\n");
      }
    }
    /* Nudge for a keyframe until the tap reports an IDR. On the IDR, start the reader-idle clock.
     * If none arrives within the window, give up so go2rtc retries from a clean state instead of
     * holding a black channel (nothing was written, so the idle clock never started on its own). */
    if (g_call && g_video_deadline) {
      time_t now = time(NULL);
      if (g_keyframe_seen) {
        rlog("[recv] keyframe received -> video started\n");
        g_video_deadline = 0;
        if (!g_last_drain) g_last_drain = now;
      } else if (talking) {
        /* An announcement holds this call: no picture is no reason to drop it. */
        if (now >= g_video_deadline) {
          rlog("[recv] no keyframe yet; keeping the call for the announcement\n");
          g_video_deadline = 0;
        }
      } else if (now >= g_video_deadline) {
        rlog("[recv] no keyframe within window -> hanging up (panel busy?)\n");
        g_video_deadline = 0;
        linphone_call_terminate(g_call);
        fire_url("RECV_HANGUP_URL");
      } else if (now != g_last_vfu) { /* rate-limit to ~1/s */
        g_last_vfu = now;
        linphone_call_send_vfu_request(g_call); /* liblinphone's RTCP path */
        send_pfu_info(g_call);                  /* explicit SIP INFO media_control+xml (what lands) */
        rlog("[recv] requesting keyframe (VFU + INFO) -- no IDR yet\n");
      }
    }
    /* End the call (stay registered for the next one) only when NO reader has drained the FIFO for
     * g_idle_seconds -- i.e. the viewer is really gone, not just a go2rtc probe / WebRTC reconnect
     * blip. The in-dialog BYE is the teardown the official app uses and it does free the station;
     * RECV_HANGUP_URL only tells the control plane to drop its slot bookkeeping (and, for a call that
     * never connected, to cancel the ringing request at the gateway). */
    if (g_call && g_last_drain && time(NULL) - g_last_drain >= g_idle_seconds) {
      rlog("[recv] no FIFO reader for %ds -> hanging up\n", g_idle_seconds);
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
          linphone_call_stats_unref(st);
        }
      }
    }
  }

  if (g_ring) linphone_call_unref(g_ring);
  /* Hang up cleanly (BYE) so the door station frees the video channel; otherwise it stays "busy"
   * and won't ring again until its session timer expires. */
  if (g_call) {
    rlog("[recv] terminating active call (BYE)\n");
    linphone_call_terminate(g_call);
    for (int i = 0; i < 40 && g_call; i++) { /* pump iterate so the BYE actually goes out */
      linphone_core_iterate(lc);
      usleep(25 * 1000);
    }
  }
  rlog("[recv] shutting down\n");
  linphone_core_stop(lc);
  linphone_core_unref(lc);
  return 0;
}
