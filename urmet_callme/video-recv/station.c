/* SPDX-License-Identifier: GPL-3.0-or-later (links liblinphone, GPLv3) */
/*
 * station.c - the ONE liblinphone helper per 2Voice place. Compiled into the image next to recv (see
 * ../Dockerfile) and spawned once per place by src/twoVoiceStation.ts, which drives it over stdin (one
 * command letter per line) and reads its replies on stdout. The command alphabet is spelled out in
 * src/helperProtocol.ts and in the usage text below.
 *
 * On 2Voice the camera call IS the door call: the station streams its H.264 on the same auto-insertion
 * call that carries the unlock tone, and it serves one such call at a time. So one process owns the
 * single call to the station and does everything on it:
 *   - door / gate: an in-call DTMF tone (DOOR_DTMF='1', GATE_DTMF='2', as SIP INFO), on the call
 *     that is up or on one placed for it (register once at startup; each press then pays only the
 *     call-setup time)
 *   - camera: tap the call's H.264 (h264tap.h) and decoded audio (lpcommon.h) into the FIFOs the
 *     control plane names, on the call that is up or on one placed for it; priming black frames and
 *     keyframe nudges until the first IDR; the call ends on an idle timeout when no reader drains
 *   - next camera: DTMF '3' on the live call while its audio is still closed; with the audio open the
 *     station ignores it, so the call is re-placed and the '3's sent before the audio is reopened
 *   - open audio: DTMF '4' (announcements, or the entrance sound on every camera call)
 *   - announcements: a clip read from the talk FIFO (talkout.h) goes out as the call's audio
 *   - doorbell ring: held unanswered; a door press / announcement during it answers it (the station
 *     refuses new calls while ringing); the camera shows it with early media, as the app does
 * Before 2026-11 this was two processes (opendoor for the door, recv in outgoing mode for the camera),
 * each registering the channel account, coordinated from Node; the logic is theirs, merged.
 *
 * Headers on the call (the app sends one or the other):
 *   door/warm/announcement: `auto_insertion: true` + audio and video recvonly (a cloud-listed 2Voice
 *     unit is a video door station; some 403 an audio-only offer), or `mac: <MAC>` + audio only for a
 *     phase-B station (STATION_MAC; it answers 486 to auto_insertion)
 *   camera: `mac: <MAC>` for phase-B, NO header for a cloud-listed station (the app's callCCTV), audio
 *     sendrecv + video recvonly
 *
 * Usage: station <in-username> <in-password> <out-sip-uri>
 *   env: STATION_DATA_DIR (writable, unique per place), STATION_UUID (stable +sip.instance id),
 *        STATION_KEEPALIVE_MS, STATION_PREWARM_HOLD_MS, STATION_IDLE_SECONDS, STATION_MAC,
 *        STATION_AUDIO_IN, STATION_TALK_DTMF, STATION_TALK_START_MS, STATION_ANSWER_RING,
 *        STATION_OPEN_AUDIO_AT_START, STATION_SWITCH_GAP_MS, STATION_CAM_CYCLE,
 *        STATION_REDIAL_DELAY_MS, STATION_DEBUG, STATION_TRACE, SIP_REALM, RECV_BLACK_FRAME (h264tap.h)
 */
#include <stdarg.h>
#include <stdio.h>
#include <time.h>

static void slog(const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  vprintf(fmt, ap);
  va_end(ap);
  fflush(stdout);
}
#define TAP_LOG slog
#include "lpcommon.h"

/* ---- camera targets: the FIFO pair the control plane named with 'V' ("" = no camera) ---- */
static char g_cam_audio[256] = "";
static void lp_atap_target(char *out, size_t outsz) { snprintf(out, outsz, "%s", g_cam_audio); }

/* ---- state ---- */
static LinphoneCall *g_call = NULL;
static volatile sig_atomic_t g_running = 1;
static volatile int g_reg_ok = 0;     /* registration succeeded */
static volatile int g_reg_failed = 0; /* registration failed (bad creds / server) */
static int g_streams = 0;    /* the call reached StreamsRunning (media up) -> safe to send DTMF */
static int g_ended = 0;      /* the call ended (End/Error/Released) */
static int g_call_is_ring = 0;   /* g_call is a ring we answered (not a call we placed) */
static int g_call_is_camera = 0; /* g_call was placed with the camera offer/header */
/* Doorbell ring held unanswered (STATION_ANSWER_RING). While a station rings it answers 486 Busy to
 * every new call, so an announcement or door press during the ring can't place its own call; it
 * answers this one instead (answer_ring). NULL = no ring, or not holding rings. */
static LinphoneCall *g_ring = NULL;
static int g_cam_on = 0;        /* taps targeted at the camera FIFOs (CAMERA ok sent, no end yet) */
static int g_cam_live = 0;      /* CAMERA live sent for this picture (first keyframe) */
static int g_talk_waiting = 0; /* a 'T' arrived and its clip has not started yet (talkout.h: g_talk_active) */
static int g_cam_pending = 0;   /* camera asked for while an audio-only call was up: place one after it */
static int g_audio_opened = 0;  /* the open-audio DTMF went out on this call */
static int g_audio_want = 0;    /* open the audio on this call (at start, or asked by 'A'/'T') */
static int g_audio_at_start = 0; /* STATION_OPEN_AUDIO_AT_START: open it on every camera call */
static time_t g_video_deadline = 0; /* nudge for a keyframe until this time; give up if none (0=off) */
static time_t g_last_vfu = 0;       /* last keyframe nudge, to rate-limit to ~1/s */
static int g_idle_seconds = 10;     /* STATION_IDLE_SECONDS: camera off when no reader drains this long */

/* Next camera (issue #20). The station cycles its entrance panels on the in-call DTMF '3', but only
 * while the call's audio is still closed: the app hides its next-camera button once the audio is
 * opened ('4'), and the station ignores a '3' after it. So, like the app, a camera call keeps the audio
 * closed (unless STATION_OPEN_AUDIO_AT_START asks for the entrance sound) and a switch is one '3' on the
 * live call: no new call, no relay clicks at the station. Once the audio is open (that option, or an
 * announcement on this call), a switch has to RE-DIAL: BYE the call, place it again (a new call starts
 * on the first panel), send '3' up to the next position while the audio is still closed, then reopen
 * the audio if wanted. */
static int g_cam_pos = 0;          /* panel position the station shows: '3's sent since the call began */
static int g_cam_steps = 0;        /* '3's to send on the re-placed call (re-dial only) */
static int g_redial_req = 0;       /* a switch asked for the current call to end and be re-placed */
static int g_redialing = 0;        /* the re-placed call is on its way (not yet StreamsRunning) */
static int g_switching = 0;        /* on the re-placed call: sending the '3's, audio still closed */
static int g_switch_left = 0;      /* '3's still to send on this call */
static long long g_switch_next_ms = 0; /* when the next '3' (or the closing '4') may go out */
static int g_n_waiting = 0;        /* 'N' commands awaiting their RESULT line */
static time_t g_switch_vfu_until = 0; /* keyframe nudges for the new panel's picture until then */
static int g_hold_fd[2] = {-1, -1};   /* our own writer on the FIFOs across a re-dial */
static long long g_redial_at_ms = 0;  /* don't place the re-dial before this */
static int g_redial_tries = 0;        /* re-dial attempts left for this switch */
#define REDIAL_TRIES 3

static long long env_ms(const char *name, long long dflt) {
  const char *e = getenv(name);
  return (e && *e) ? atoll(e) : dflt;
}
/* Gap between the '3's and before the closing '4'. The app's '3' is a button press, so a person's
 * pace; the station needs a moment to swap the picture before the next one. */
static long long switch_gap_ms(void) { return env_ms("STATION_SWITCH_GAP_MS", 1500); }
/* Positions the station's '3' cycles through before it is back on the first panel. A 1760/16U with
 * two cameras cycled four (two of them empty; issue #20), so a re-dial wraps there instead of adding
 * a '3' per press forever. */
static int cam_cycle(void) {
  int n = (int)env_ms("STATION_CAM_CYCLE", 4);
  return n > 0 ? n : 4;
}
/* Pause between the BYE's answer and the re-dial. The station declines a call placed ~100 ms after
 * the previous one ended (it hasn't released the line yet; issue #20, 1.0.18), and declines again if
 * we retry too soon, so each retry waits one more pause. */
static long long redial_delay_ms(void) { return env_ms("STATION_REDIAL_DELAY_MS", 2500); }

/* Phase-B (1083/58A family) is identified by STATION_MAC. Those stations accept an audio-only INVITE
 * with a `mac` header; cloud-listed 2Voice panels 403 an audio-only offer (observed on a 1760/16) and
 * keep the video graph. */
static const char *phase_b_mac(void) {
  const char *mac = getenv("STATION_MAC");
  return (mac && *mac) ? mac : NULL;
}

static void on_sig(int _s) { (void)_s; g_running = 0; }

/* Announcement diagnostics: the NEGOTIATED audio (codec + direction, ours and the station's). An
 * announcement only reaches the station when our side may send: "sendrecv"/"sendonly" here. A
 * station answering "sendonly" (from its side) puts us on recvonly, and nothing we play gets out. */
static void log_audio_media(LinphoneCall *call, const char *when) {
  const LinphoneCallParams *cp = linphone_call_get_current_params(call);
  const LinphoneCallParams *rp = linphone_call_get_remote_params(call);
  const LinphonePayloadType *pt = cp ? linphone_call_params_get_used_audio_payload_type(cp) : NULL;
  slog("[station] audio (%s): %s/%d, our direction %s, station offered %s\n", when,
       pt ? linphone_payload_type_get_mime_type(pt) : "?",
       pt ? linphone_payload_type_get_clock_rate(pt) : 0,
       cp ? dir_name(linphone_call_params_get_audio_direction(cp)) : "?",
       rp ? dir_name(linphone_call_params_get_audio_direction(rp)) : "?");
}

/* Audio RTP counters for the call so far: "sent" rising while a clip plays = it left for the station;
 * "recv" = the station sends audio back (its microphone is open). */
static void log_audio_rtp(LinphoneCall *call, const char *when) {
  LinphoneCallStats *st = linphone_call_get_audio_stats(call);
  if (!st) return;
  const rtp_stats_t *r = linphone_call_stats_get_rtp_stats(st);
  slog("[station] audio rtp (%s): sent %llu pkts (%llu B), recv %llu pkts, lost %lld\n", when,
       (unsigned long long)r->packet_sent, (unsigned long long)r->sent,
       (unsigned long long)r->packet_recv, (long long)r->cum_packet_loss);
  linphone_call_stats_unref(st);
}

static void on_reg_state(LinphoneCore *lc, LinphoneProxyConfig *cfg,
                         LinphoneRegistrationState state, const char *message) {
  (void)lc; (void)cfg;
  slog("[station] registration: %s (%s)\n",
       linphone_registration_state_to_string(state), message ? message : "");
  if (state == LinphoneRegistrationOk) g_reg_ok = 1;
  else if (state == LinphoneRegistrationFailed) g_reg_failed = 1;
}

/* ---- camera on/off ---- */

static void nudge_keyframe(LinphoneCall *call, const char *why) {
  linphone_call_send_vfu_request(call);
  send_pfu_info(call);
  slog("[station] requesting keyframe (VFU + INFO) %s\n", why);
}

/* Open the keyframe window for the picture now expected on `call`: nudge ~1/s until the tap sees an
 * IDR (the panel does not always emit a start-of-call one), give up after ~12 s. */
static void expect_picture(void) {
  g_keyframe_seen = 0;
  g_cam_live = 0;
  g_last_drain = 0;
  g_video_deadline = time(NULL) + 12;
  g_last_vfu = 0;
}

/* The camera's picture stopped (call ended, idle viewer, no keyframe): tell the control plane and
 * forget the targets. The next 'V' starts over. */
static void camera_off(const char *why) {
  if (!g_cam_on) return;
  g_cam_on = 0;
  g_cam_live = 0;
  tap_targets_lock();
  g_tap_target[0] = '\0';
  g_cam_audio[0] = '\0';
  g_tap_gen++; /* the taps on a call that stays up close their FIFOs */
  tap_targets_unlock();
  g_video_deadline = 0;
  g_switch_vfu_until = 0;
  g_last_drain = 0;
  slog("[station] camera: %s\nCAMERA end\n", why);
}

static void camera_fail(const char *why) {
  g_cam_on = 0;
  tap_targets_lock();
  g_tap_target[0] = '\0';
  g_cam_audio[0] = '\0';
  g_tap_gen++;
  tap_targets_unlock();
  slog("[station] camera: %s\nCAMERA fail %s\n", why, why);
}

/* ---- the ring ---- */

/* The ring call is gone (ended while held, or the answered ring ended). */
static void ring_gone(void) {
  if (g_cam_on && (g_ring == NULL) && (!g_call || g_call_is_ring)) camera_off("the ring call ended, so did its picture");
  slog("RING gone\n");
}

/* ---- call state ---- */
static void on_call_state(LinphoneCore *lc, LinphoneCall *call,
                          LinphoneCallState state, const char *message) {
  (void)lc;
  slog("[station] call state: %s\n", linphone_call_state_to_string(state));
  switch (state) {
  case LinphoneCallIncomingReceived:
    /* A doorbell ring forks here too (we are registered on the channel account). The Node doorbell
     * listener handles the ring itself. With STATION_ANSWER_RING we hold ONE ring unanswered (ringing,
     * like the listener and the phone app) so an announcement / door press during it can answer it
     * (answer_ring: the station refuses new calls while it rings) and the camera can show it (early
     * media); otherwise, and for a second ring, decline (486 is a 4xx, so Flexisip keeps forking to
     * the other bindings; it just drops us from this call). */
    if (!g_ring && getenv("STATION_ANSWER_RING")) {
      g_ring = linphone_call_ref(call);
      slog("[station] ring: holding the doorbell call unanswered (an announcement or door press "
           "during the ring answers it; the camera shows it without answering)\nRING held\n");
    } else {
      linphone_call_decline(call, LinphoneReasonBusy);
    }
    break;
  case LinphoneCallStreamsRunning: {
    if (call != g_call) break;
    const LinphoneCallParams *cur = linphone_call_get_current_params(call);
    const LinphoneCallParams *rp = linphone_call_get_remote_params(call);
    slog("[station] media up: audio%s; negotiated audio %s (remote %s), video %s\n",
         (cur && linphone_call_params_video_enabled(cur)) ? "+video" : " only",
         cur ? dir_name(linphone_call_params_get_audio_direction(cur)) : "?",
         rp ? dir_name(linphone_call_params_get_audio_direction(rp)) : "?",
         cur ? dir_name(linphone_call_params_get_video_direction(cur)) : "?");
    log_audio_media(call, "media up");
    g_streams = 1;
    g_cam_pos = 0; /* every call starts on the first panel */
    if (g_redialing || g_n_waiting) {
      /* A re-placed call, or a switch asked for during setup: the '3's go out first, from the main
       * loop, with the audio still closed; the audio and the queued tones follow the last one. */
      g_redialing = 0;
      g_switching = 1;
      g_switch_left = g_cam_steps;
      g_cam_steps = 0;
      g_switch_next_ms = g_switch_left ? now_ms() + switch_gap_ms() : now_ms();
    }
    if (g_cam_on) expect_picture();
    break;
  }
  case LinphoneCallPausedByRemote:
  case LinphoneCallUpdatedByRemote:
    /* The station changed the media mid-call (e.g. put us on hold) -- this can stop an announcement. */
    if (call == g_call) log_audio_media(call, linphone_call_state_to_string(state));
    break;
  case LinphoneCallError: {
    if (call == g_ring) { /* the ring ended before anyone needed it (answered elsewhere / gave up) */
      slog("[station] ring: ended (%s)\n", message ? message : "");
      linphone_call_unref(g_ring);
      g_ring = NULL;
      ring_gone();
      break;
    }
    /* DIAGNOSTIC (58A support): the SIP status the station returned. A `486 Busy Here` here means
     * the station rejected our header (the 58A rejects `auto_insertion`; a cloud-listed station
     * rejects `mac`) -- this is how we tell "wrong header" apart from "no media / timeout". */
    const LinphoneErrorInfo *ei = linphone_call_get_error_info(call);
    slog("[station] call error: %d %s (%s)\n",
         ei ? linphone_error_info_get_protocol_code(ei) : 0,
         (ei && linphone_error_info_get_phrase(ei)) ? linphone_error_info_get_phrase(ei) : "",
         message ? message : "");
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
      slog("[station] ring: ended (%s)\n", message ? message : "");
      linphone_call_unref(g_ring);
      g_ring = NULL;
      ring_gone();
      break;
    }
    if (state == LinphoneCallEnd && call == g_call) log_audio_rtp(call, "call ended");
    if (g_call == call && g_call_is_ring) {
      g_call_is_ring = 0;
      ring_gone();
    }
    slog("[station] call finished: %s\n", message ? message : "");
    if (g_call == call) g_ended = 1;
    break;
  default:
    break;
  }
}

#define STREAMS_TIMEOUT_MS 20000 /* after the INVITE, wait this long for media */
#define PREWARM_HOLD_MS_DEFAULT 15000

/* A doorbell ring is held (g_ring): the station refuses new calls while it rings (486 Busy), and the
 * held ring has our sound device, so liblinphone would not even place our own call. Answer the ring
 * instead and make it g_call, so it carries the announcement / tone / picture. Answering takes the
 * call, so the phone app stops ringing. No open-audio digit on it: a ring answered like the app
 * answers it has the audio open already. Returns 1 when the ring is now g_call; on failure the ring
 * is declined (freeing the sound device) so the caller can still try its own call. */
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
  if (phase_b_mac()) {
    linphone_call_params_enable_video(p, FALSE);
  } else {
    linphone_call_params_enable_video(p, TRUE); /* receive only; tapped when the camera is on */
    linphone_call_params_set_video_direction(p, LinphoneMediaDirectionRecvOnly);
  }
  /* Make it g_call BEFORE accepting: the media of an incoming call comes up inside the accept
   * (StreamsRunning fires synchronously), so clearing g_streams afterwards lost it and a queued door
   * tone waited forever for media that was already up (#19). */
  g_call = c; /* keeps the ref taken when the ring arrived */
  g_call_is_ring = 1;
  g_call_is_camera = 0;
  g_streams = 0;
  g_ended = 0;
  g_audio_opened = 1; /* an answered ring has its audio open already */
  LinphoneStatus rc = linphone_call_accept_with_params(c, p);
  linphone_call_params_unref(p);
  slog("[station] ring: the station is ringing -> answering the ring call for the %s (%s)\n",
       what, rc == 0 ? "ok; the phone app stops ringing" : "FAILED, declining it");
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

/* Place a call to the station: the door offer (auto_insertion / mac, see the file header) or, with
 * `camera`, the app's camera offer. While a ring is held it is answered instead (see answer_ring);
 * `what` = what the call is for; NULL (a pre-warm) never answers a ring: nothing needs the call yet,
 * and answering would stop the phone app ringing. Resets g_streams/g_ended, sets g_call (refed).
 * Returns the call or NULL. */
static LinphoneCall *place_call(LinphoneCore *lc, const char *out_uri, const char *what, int camera) {
  if (g_ring) {
    if (!what) {
      slog("[station] a doorbell ring is in progress; not opening a call now\n");
      return NULL;
    }
    if (answer_ring(lc, what)) return g_call;
  }
  g_call_is_ring = 0;
  g_call_is_camera = camera;
  g_streams = 0;
  g_ended = 0;
  g_audio_opened = 0;
  g_audio_want = camera ? g_audio_at_start : 0; /* per call: 'T'/'A' set it again for theirs */
  const char *mac = phase_b_mac();
  LinphoneAddress *to = linphone_factory_create_address(linphone_factory_get(), out_uri);
  if (!to) { slog("[station] bad OUT uri %s\n", out_uri); return NULL; }
  LinphoneCallParams *p = linphone_core_create_call_params(lc, NULL);
  linphone_call_params_enable_audio(p, TRUE);
  if (camera) {
    /* Audio SENDRECV, as the app offers it (UCFCallManager.inviteAddress never touches the audio
     * direction). Offering recvonly made the station answer sendonly, which liblinphone reports as
     * PausedByRemote right after Connected, and the station then never sent audio RTP (the "video
     * works, PCM is silence" report). Our capture side is silence, so the station gets silent G.711. */
    linphone_call_params_set_audio_direction(p, LinphoneMediaDirectionSendRecv);
    linphone_call_params_enable_video(p, TRUE);
    linphone_call_params_set_video_direction(p, LinphoneMediaDirectionRecvOnly);
  } else if (mac) {
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
  /* The headers: phase-B stations want `mac` and reject `auto_insertion` with 486 Busy; a cloud-listed
   * station wants `auto_insertion: true` on the door call and NO header on the camera call (the app's
   * callCCTV). */
  const char *header = "none";
  if (mac) { linphone_call_params_add_custom_header(p, "mac", mac); header = "mac"; }
  else if (!camera) { linphone_call_params_add_custom_header(p, "auto_insertion", "true"); header = "auto_insertion"; }
  slog("[station] outgoing header: %s (%s call)\n", header, camera ? "camera" : "door");
  LinphoneCall *call = linphone_core_invite_address_with_params(lc, to, p);
  linphone_call_params_unref(p);
  linphone_address_unref(to);
  if (!call) { slog("[station] invite failed to start\n"); return NULL; }
  linphone_call_ref(call);
  g_call = call;
  slog("[station] call placed, offering %s -> waiting for media\n",
       camera ? "audio+video (camera)" : mac ? "audio only" : "audio+video");
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
    g_call_is_camera = 0;
  }
  g_streams = 0;
  g_ended = 0; /* consume: place_call sets it fresh for the next call */
  g_audio_opened = 0;
  /* A camera switch re-dial and a camera call pending after an audio-only one keep the camera on and
   * its targets: the next call carries the picture. The pending one waits the re-dial pause from
   * here: the station declines a call placed right after the last one ended. */
  if (g_cam_pending) g_redial_at_ms = now_ms() + redial_delay_ms();
  if (g_cam_on && !g_redial_req && !g_redialing && !g_cam_pending)
    camera_off("the call carrying the picture ended");
}

/* Keep the camera's FIFOs open across a re-dial. The per-call taps close theirs when the call ends,
 * and with no writer left the reader (stream.sh's ffmpeg) would see EOF and end the go2rtc stream,
 * making every viewer reconnect. O_RDWR|O_NONBLOCK like the taps: never blocks, never EPIPEs. */
static void hold_fifos(int on) {
  const char *paths[2] = {g_tap_target, g_cam_audio};
  for (int k = 0; k < 2; k++) {
    if (on && g_hold_fd[k] < 0) {
      if (paths[k][0]) g_hold_fd[k] = open(paths[k], O_RDWR | O_NONBLOCK);
    } else if (!on && g_hold_fd[k] >= 0) {
      close(g_hold_fd[k]);
      g_hold_fd[k] = -1;
    }
  }
}

/* Feed the held FIFOs while a switch has no call carrying media: black frames at ~25 fps and
 * silence at 8 kHz s16le. With nothing on its inputs ffmpeg stops sending to go2rtc, which drops
 * the idle publisher after a few seconds, and the viewer's card freezes until a reload (issue #20).
 * Only while no call is past ringing, so this never writes into a FIFO the new call's taps already
 * write to. */
static long long g_fill_ms = 0;
static void feed_switch_gap(void) {
  int media = g_call && linphone_call_get_state(g_call) != LinphoneCallOutgoingInit &&
              linphone_call_get_state(g_call) != LinphoneCallOutgoingProgress &&
              linphone_call_get_state(g_call) != LinphoneCallOutgoingRinging;
  if (!g_redialing || media || g_hold_fd[0] < 0) { g_fill_ms = 0; return; }
  long long now = now_ms();
  if (g_fill_ms == 0) {
    g_fill_ms = now;
    slog("[station] camera switch: feeding black + silence until the new call's media\n");
    if (g_black) (void)!write(g_hold_fd[0], g_black, g_black_len);
    return;
  }
  long long ms = now - g_fill_ms;
  if (ms < 40) return;
  g_fill_ms = now;
  if (g_black) (void)!write(g_hold_fd[0], g_black, g_black_len); /* drop on EAGAIN, like the tap */
  if (g_hold_fd[1] >= 0) {
    static const unsigned char zero[4096];
    size_t n = (size_t)(ms * 16); /* 8000 samples/s * 2 bytes */
    if (n > sizeof zero) n = sizeof zero;
    (void)!write(g_hold_fd[1], zero, n);
  }
}

static void answer_switches(const char *result, const char *why) {
  for (; g_n_waiting > 0; g_n_waiting--)
    slog("RESULT N %s%s%s%s\n", result, why ? " (" : "", why ? why : "", why ? ")" : "");
}

/* The open-audio digit ('4', the app's OPEN_AUDIO_DTMF), once per call, when its media runs.
 * `talk` = asked by an announcement: STATION_TALK_DTMF then names the digit ("" = send none, the
 * announce_open_audio option off); a camera asks with the fixed '4'. */
static void open_audio_now(LinphoneCall *call, int talk) {
  if (g_audio_opened || !g_streams) return;
  g_audio_opened = 1;
  const char *d = talk ? getenv("STATION_TALK_DTMF") : "4";
  if (!d || !*d) {
    slog("[station] announce: no open-audio digit configured (sending none)\n");
    return;
  }
  LinphoneStatus st = linphone_call_send_dtmf(call, d[0]);
  slog("[station] open-audio DTMF '%c' sent (SIP INFO) -> %s\n", d[0], st == 0 ? "ok" : "FAILED");
}

/* Send one tone on the active (already-running) call and report it. */
static void send_tone(char c, long long *last_activity, long long now) {
  LinphoneStatus st = linphone_call_send_dtmf(g_call, c);
  slog("[station] sent DTMF '%c' (status %d)\nRESULT %c %s\n", c, (int)st, c, st == 0 ? "ok" : "fail");
  *last_activity = now;
}

#define TALK_START_MS_DEFAULT 25000
static long long talk_start_ms(void) { return env_ms("STATION_TALK_START_MS", TALK_START_MS_DEFAULT); }

/* Log what the announcement request finds (and whether it has to place a call). */
static void talk_log_request(long long now, long long call_placed_at) {
  if (!g_call)
    slog("[station] announce: requested -> placing a call to the station\n");
  else if (!g_streams)
    slog("[station] announce: requested -> call already being placed (%lld ms ago)\n", now - call_placed_at);
  else
    slog("[station] announce: requested -> riding the call already up\n");
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

/* 'V <h264 fifo> <pcm fifo>': the camera wants the picture. On the held ring: early media (the
 * station streams while the call keeps ringing, so the phones keep ringing too; only when its video is
 * recvonly/sendrecv for us -- the app's isEarlyMediaAllowed check). On a call that is up and carries
 * video (an answered ring, a camera call, a cloud-listed door call): adopt it, the taps pick the
 * targets up at the next keyframe. On an audio-only call (phase-B door): it ends and a camera call
 * follows. With no call: place the camera call. Replies CAMERA ok, or CAMERA fail <why>. */
static void camera_on(LinphoneCore *lc, const char *out_uri, long long now, long long *call_placed_at) {
  char line[600], h264[256] = "", pcm[256] = "";
  read_rest_of_line(line, sizeof line);
  if (sscanf(line, " %255s %255s", h264, pcm) < 2) {
    camera_fail("no FIFO paths given");
    return;
  }
  tap_targets_lock();
  snprintf(g_tap_target, sizeof g_tap_target, "%s", h264);
  snprintf(g_cam_audio, sizeof g_cam_audio, "%s", pcm);
  g_tap_gen++; /* the taps of a call already up reopen on these paths and gate on a fresh keyframe */
  tap_targets_unlock();
  g_cam_on = 1;
  g_cam_live = 0;
  g_cam_pending = 0;
  if (g_ring) {
    /* The station's own offer, as the app's remoteSendVideo: our current params are empty before an
     * answer (on an Ipercom panel they read "inactive" on a ring offering sendonly video). */
    const LinphoneCallParams *rp = linphone_call_get_remote_params(g_ring);
    LinphoneMediaDirection vd =
        rp && linphone_call_params_video_enabled(rp) ? linphone_call_params_get_video_direction(rp)
                                                     : LinphoneMediaDirectionInactive;
    if (vd != LinphoneMediaDirectionSendOnly && vd != LinphoneMediaDirectionSendRecv) {
      slog("[station] camera: the ring call offers no video for us (station sends: %s)\n", dir_name(vd));
      camera_fail("no video on the ring call");
      return;
    }
    LinphoneStatus st = linphone_call_accept_early_media(g_ring);
    slog("[station] camera: showing the ringing call (early media, as the app's \"view camera\"; "
         "the phones keep ringing) -> %s\n", st == 0 ? "ok" : "FAILED");
    if (st != 0) { camera_fail("early media refused"); return; }
    slog("CAMERA ok\n");
    return;
  }
  if (g_call) {
    /* Negotiated params once the media runs; before that (a door call still in setup) our own offer,
     * so an audio-only phase-B door call is not mistaken for one that will carry a picture. */
    const LinphoneCallParams *cp =
        g_streams ? linphone_call_get_current_params(g_call) : linphone_call_get_params(g_call);
    int has_video = cp && linphone_call_params_video_enabled(cp) &&
                    linphone_call_params_get_video_direction(cp) != LinphoneMediaDirectionInactive;
    if (g_call_is_ring || g_call_is_camera || has_video) {
      slog("[station] camera: showing the call already up (%s%s)\n",
           g_call_is_ring ? "answered ring" : g_call_is_camera ? "camera call" : "door call with video",
           g_streams ? "" : ", media not up yet");
      if (g_streams) {
        expect_picture();
        nudge_keyframe(g_call, "for the camera joining a live call");
      }
      /* The entrance sound option applies to the camera's call whether placed for it or adopted. */
      if (g_audio_at_start) g_audio_want = 1;
      slog("CAMERA ok\n");
      return;
    }
    /* An audio-only call (phase-B door call): no picture on it. End it and place a camera call. */
    if (g_talk_active || g_talk_waiting) {
      /* ...unless an announcement rides it: that finishes first (ending the call now would cut the
       * clip and break its ffmpeg). The keep-alive releases the call after the clip and the pending
       * camera call follows; the viewer's stream.sh waits for it. */
      slog("[station] camera: the call up is audio only and carries an announcement -> the camera call follows it\n");
      g_cam_pending = 1; /* bye_call (keep-alive idle, after the clip) schedules the camera call */
      slog("CAMERA ok\n");
      return;
    }
    slog("[station] camera: the call up is audio only -> ending it and placing a camera call\n");
    g_cam_pending = 1; /* keeps the camera on and its targets through bye_call, which schedules it */
    bye_call(lc);
    slog("CAMERA ok\n");
    return;
  }
  if (!place_call(lc, out_uri, "camera", 1)) { camera_fail("the station call could not be placed"); return; }
  *call_placed_at = now;
  slog("CAMERA ok\n");
}

/* THE command loop (50 ms ticks). */
static void command_loop(LinphoneCore *lc, const char *out_uri, long long keepalive_ms) {
  long long last_activity = 0, call_placed_at = 0;
  long long warm_deadline = 0; /* a 'W' pre-warm holds the call up until here even with no tone yet */
  long long prewarm_hold = env_ms("STATION_PREWARM_HOLD_MS", PREWARM_HOLD_MS_DEFAULT);
  char queue[8]; /* tones waiting for StreamsRunning (the command that placed the call) */
  int qn = 0;
  int release_req = 0; /* an 'H' arrived: BYE the held call once no tone is still waiting to go out */
  /* Announcement: hold the call for a clip until talk_deadline (it must START by then); while it
   * plays the call is busy; after it ends, the keep-alive idle counts from the clip's end. */
  long long talk_deadline = 0, talk_requested_at = 0;
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
        /* Pre-warm (doorbell ring): open the call NOW, no tone, so the unlock press moments later
         * rides an already-established call (instant). Hold it for prewarm_hold; if no tone comes,
         * the idle check below releases the bus. */
        warm_deadline = now + prewarm_hold;
        if (!g_call && !g_redial_req && !g_redialing) {
          if (place_call(lc, out_uri, NULL, 0)) {
            call_placed_at = now;
            slog("[station] pre-warm: opening call (hold %llds)\n", prewarm_hold / 1000);
          }
        } else slog("[station] pre-warm: a call is already up\n");
        continue;
      }
      if (c == 'T') {
        /* Announcement: open/hold the call; the clip arrives on STATION_AUDIO_IN (talkout.h). */
        talk_log_request(now, call_placed_at);
        if (!g_call && !g_redial_req && !g_redialing) {
          if (!place_call(lc, out_uri, "announcement", 0)) continue;
          call_placed_at = now;
        }
        g_audio_want = 1;
        talk_requested_at = now;
        g_talk_waiting = 1;
        talk_media_logged = 0;
        talk_deadline = now + STREAMS_TIMEOUT_MS + talk_start;
        continue;
      }
      if (c == 'A') { /* open the audio now (an announcement is about to play on this call) */
        g_audio_want = 1;
        if (g_call && g_streams && !g_switching) open_audio_now(g_call, 1);
        else slog("[station] open audio requested -> once the call's media is up\n");
        continue;
      }
      if (c == 'V') {
        camera_on(lc, out_uri, now, &call_placed_at);
        continue;
      }
      if (c == 'H') {
        /* Release (hang up): the "hang up" button. A tone already queued for this call still goes out
         * first (checked below); a camera switch in flight is abandoned. */
        release_req = 1;
        warm_deadline = 0;
        if (g_talk_active) slog("[station] announce: hang-up requested while a clip plays -> cutting it short\n");
        g_talk_waiting = 0;
        talk_deadline = 0;
        if (g_redial_req || g_redialing || g_switching) {
          g_redial_req = g_redialing = g_switching = 0;
          g_cam_steps = 0;
          answer_switches("fail", "hung up");
          hold_fifos(0);
        }
        g_cam_pending = 0;
        camera_off("hung up");
        continue;
      }
      if (c == 'N') { /* next camera (see g_cam_pos) */
        if (!g_call && !g_redial_req && !g_redialing) {
          slog("RESULT N fail (no call up)\n");
          continue;
        }
        g_n_waiting++;
        if (g_redial_req || g_redialing || g_switching) {
          /* A switch is already under way: one more position on top of it. */
          if (g_switching) g_switch_left++;
          else g_cam_steps = (g_cam_steps + 1) % cam_cycle();
          slog("[station] next camera requested during a switch -> one more '3'\n");
          continue;
        }
        if (!g_audio_opened) {
          if (g_streams) {
            LinphoneStatus st = linphone_call_send_dtmf(g_call, '3');
            g_cam_pos = (g_cam_pos + 1) % cam_cycle();
            slog("[station] next-camera DTMF '3' sent on the live call (SIP INFO) -> %s\n",
                 st == 0 ? "ok" : "FAILED");
            answer_switches(st == 0 ? "ok" : "fail", st == 0 ? NULL : "DTMF not sent");
            g_switch_vfu_until = time(NULL) + 5;
            last_activity = now;
          } else {
            /* The call is still being set up: its '3' goes out once the media runs (main loop). */
            g_cam_steps = (g_cam_steps + 1) % cam_cycle();
            slog("[station] next camera requested while the call is set up -> '3' once the media runs\n");
          }
          continue;
        }
        g_cam_steps = (g_cam_pos + 1) % cam_cycle();
        g_audio_want = g_audio_at_start; /* an announcement's open audio ends with its call */
        slog("[station] next camera requested with the audio open -> re-dialing to send '3' x%d first\n",
             g_cam_steps);
        g_redial_req = 1;
        hold_fifos(1);
        if (g_call) linphone_call_terminate(g_call);
        continue;
      }
      if (c != '1' && c != '2') continue;
      if (g_call && g_streams && !g_switching) {
        send_tone(c, &last_activity, now); /* call up -> instant */
      } else {
        if (qn < (int)sizeof queue) queue[qn++] = c; /* queue until media */
        /* A re-dial in flight counts as a call coming: the re-placed call carries the tone. */
        if (!g_call && !g_redial_req && !g_redialing) {
          if (place_call(lc, out_uri, c == '1' ? "door" : "gate", 0)) call_placed_at = now;
          else { for (int i = 0; i < qn; i++) slog("RESULT %c fail\n", queue[i]); qn = 0; }
        }
      }
    }

    /* Re-dial (camera switch with the audio open) or a camera call pending after an audio-only call:
     * place it once the station has released the line. */
    if (!g_call && g_reg_ok && (g_redialing || g_cam_pending) && now >= g_redial_at_ms) {
      if (g_cam_pending && g_ring && phase_b_mac()) {
        /* place_call would answer the held ring, which a phase-B station carries audio only: say so
         * now instead of showing nothing until the keyframe deadline. */
        g_cam_pending = 0;
        camera_fail("the station is ringing (a phase-B ring carries no video)");
      } else if (place_call(lc, out_uri, "camera", 1)) {
        call_placed_at = now;
        if (g_cam_pending) {
          /* From here it is a re-dial with no '3' to send: a decline before media (the station still
           * releasing the line) is retried like a switch's instead of ending the camera. */
          g_cam_pending = 0;
          g_redialing = 1;
          g_redial_tries = REDIAL_TRIES;
          g_cam_steps = 0;
          slog("[station] camera: call placed after the audio-only one\n");
        }
      } else {
        g_redialing = 0;
        g_cam_pending = 0;
        answer_switches("fail", "the call could not be placed");
        hold_fifos(0);
        camera_fail("the station call could not be placed");
      }
    }

    /* Call reached media -> the '3's of a switch, then the audio and the queued tones. */
    if (g_call && g_streams && g_switching && now >= g_switch_next_ms) {
      if (g_switch_left > 0) {
        LinphoneStatus st = linphone_call_send_dtmf(g_call, '3');
        slog("[station] next-camera DTMF '3' sent (SIP INFO) -> %s (%d left)\n",
             st == 0 ? "ok" : "FAILED", g_switch_left - 1);
        g_switch_left--;
        g_cam_pos = (g_cam_pos + 1) % cam_cycle();
        g_switch_next_ms = now + switch_gap_ms();
      } else {
        g_switching = 0;
        answer_switches("ok", NULL);
        hold_fifos(0); /* the new call's taps have long had their own writers */
        g_switch_vfu_until = time(NULL) + 5;
        last_activity = now;
      }
    }
    if (g_call && g_streams && !g_switching) {
      if (g_audio_want && !g_audio_opened) open_audio_now(g_call, g_talk_waiting || g_talk_active);
      if (qn > 0) {
        for (int i = 0; i < qn; i++) send_tone(queue[i], &last_activity, now);
        qn = 0;
      }
    }
    /* Announcement bookkeeping. */
    if (g_talk_waiting && g_call && g_streams) {
      if (!talk_media_logged) {
        talk_media_logged = 1;
        slog("[station] announce: call ready %lld ms after the request; waiting for the clip\n",
             now - talk_requested_at);
        talk_deadline = now + talk_start; /* the clip must start within talk_start from here */
      }
    }
    if (g_talk_active) {
      g_talk_waiting = 0;
      talk_deadline = 0;
      last_activity = now; /* busy while it plays; the idle hang-up counts from the clip's end */
    }
    if (g_talk_clips != talk_clips) {
      talk_clips = g_talk_clips;
      last_activity = now;
      if (g_call) log_audio_rtp(g_call, "after the clip");
      slog("[station] announce: done; holding the call %llds for a follow-up\n", keepalive_ms / 1000);
    }
    if (g_talk_waiting && talk_deadline && now > talk_deadline) {
      slog("[station] announce: no audio arrived within %llds of the call coming up; releasing the hold\n",
           talk_start / 1000);
      g_talk_waiting = 0;
      talk_deadline = 0;
    }
    /* Release requested and no tone is waiting on this call any more -> BYE now (not on idle). */
    if (release_req && qn == 0) {
      release_req = 0;
      if (g_call) {
        slog("[station] release requested -> hanging up\n");
        bye_call(lc);
      }
    }
    /* Placed but no media in time -> fail queued + tear down. */
    if (g_call && !g_streams && now - call_placed_at > STREAMS_TIMEOUT_MS) {
      slog("[station] no media within %ds (station busy / rejected?)\n", STREAMS_TIMEOUT_MS / 1000);
      for (int i = 0; i < qn; i++) slog("RESULT %c fail\n", queue[i]);
      qn = 0;
      if (g_talk_waiting) slog("[station] announce: FAILED -- the call never came up\n");
      g_talk_waiting = 0;
      talk_deadline = 0;
      if (g_redialing || g_switching) { g_redialing = g_switching = 0; answer_switches("fail", "no media"); hold_fifos(0); }
      bye_call(lc);
    }
    /* Station ended the call on its own (or our BYE for a switch was answered). */
    if (g_ended) {
      if (g_redial_req) {
        /* Our BYE for a camera switch was answered: place the call again (above) instead of giving
         * up. Queued door/gate tones and the FIFO hold carry over to the new call. */
        g_redial_req = 0;
        g_redialing = 1;
        g_redial_tries = REDIAL_TRIES;
        g_redial_at_ms = now + redial_delay_ms();
        slog("[station] camera switch: call ended -> placing it again in %lld ms\n", redial_delay_ms());
        bye_call(lc); /* releases the ref; g_cam_on stays (redial in progress) */
      } else if (g_redialing && g_redial_tries > 1) {
        /* The re-placed call was declined (station still busy with the last one): wait longer, retry. */
        g_redial_tries--;
        long long wait = redial_delay_ms() * (REDIAL_TRIES - g_redial_tries + 1);
        g_redial_at_ms = now + wait;
        slog("[station] camera switch: re-placed call ended before media -> retrying in %lld ms (%d left)\n",
             wait, g_redial_tries);
        bye_call(lc);
      } else {
        for (int i = 0; i < qn; i++) slog("RESULT %c fail\n", queue[i]);
        qn = 0;
        if (g_talk_waiting || g_talk_active)
          slog("[station] announce: the station ended the call%s\n",
               g_talk_active ? " mid-clip" : " before the clip started");
        g_talk_waiting = 0;
        talk_deadline = 0;
        if (g_redialing || g_switching) {
          g_redialing = g_switching = 0;
          answer_switches("fail", "the call ended before the switch");
          hold_fifos(0);
        }
        bye_call(lc);
      }
    }
    feed_switch_gap();
    /* After a camera switch: keyframe nudges for the new panel's picture. Its first frames may be
     * P-frames of a stream we hold no keyframe for. Never hangs up: the call is fine either way. */
    if (g_call && g_streams && g_cam_on && g_switch_vfu_until) {
      time_t tnow = time(NULL);
      if (tnow >= g_switch_vfu_until) g_switch_vfu_until = 0;
      else if (tnow != g_last_vfu) { /* rate-limit to ~1/s */
        g_last_vfu = tnow;
        nudge_keyframe(g_call, "after the camera switch");
      }
    }
    /* Nudge for a keyframe until the tap reports an IDR. The panel does not always emit a start-of-
     * call IDR, and without the nudge the tap gates output forever (black). On the IDR, start the
     * reader-idle clock and tell the control plane. If none arrives within the window, give up so
     * go2rtc retries from a clean state instead of holding a black channel. */
    if (g_call && g_streams && g_cam_on && g_video_deadline) {
      time_t tnow = time(NULL);
      if (g_keyframe_seen) {
        g_video_deadline = 0;
        if (!g_last_drain) g_last_drain = tnow;
        if (!g_cam_live) { g_cam_live = 1; slog("[station] keyframe received -> video started\nCAMERA live\n"); }
      } else if (tnow >= g_video_deadline) {
        g_video_deadline = 0;
        if (g_call_is_camera) {
          slog("[station] no keyframe within window -> hanging up (panel busy?)\n");
          bye_call(lc);
        } else camera_off("no keyframe within the window on this call");
      } else if (tnow != g_last_vfu) { /* rate-limit to ~1/s */
        g_last_vfu = tnow;
        nudge_keyframe(g_call, "-- no IDR yet");
      }
    }
    /* Camera idle: no reader drained the FIFO for g_idle_seconds -- the viewer is really gone, not
     * just a go2rtc probe / WebRTC reconnect blip. The picture stops; a camera call then ends after
     * the keep-alive (a viewer coming straight back rides it: instant flip-back). */
    const int cam_watched = g_cam_on && g_last_drain && time(NULL) - g_last_drain < g_idle_seconds;
    if (g_cam_on && g_last_drain && !cam_watched) {
      camera_off("no FIFO reader for a while");
      last_activity = now;
    }
    /* Idle -> release the bus/monitor. A pre-warm holds the call up until warm_deadline even with no
     * tone yet (last_activity stays 0), so require both the keep-alive idle AND the warm window past.
     * A watched camera keeps its call up; a camera call waiting for its first picture too. */
    const int cam_pending_picture = g_cam_on && g_call_is_camera && !g_cam_live;
    if (g_call && g_streams && !g_talk_active && !cam_watched && !cam_pending_picture &&
        now - last_activity > keepalive_ms && now > warm_deadline && now > talk_deadline) {
      slog("[station] keep-alive idle -> hanging up\n");
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
            "    'N'        next camera: '3' on the live call (or a re-dial when its audio is open);\n"
            "               answered with 'RESULT N ok|fail'\n"
            "    'A'        open the station's audio ('4') on the call, once its media runs\n"
            "    'W'        pre-warm: open the call now, no tone (held STATION_PREWARM_HOLD_MS)\n"
            "    'H'        release: hang up the call now (and stop the camera)\n"
            "    'T'        announcement: hold a call for a clip read from STATION_AUDIO_IN (s16le 8 kHz\n"
            "               mono PCM); STATION_TALK_DTMF = open-audio digit to send first (empty = none),\n"
            "               STATION_TALK_START_MS = how long the clip may take to start\n"
            "    'V <h264 fifo> <pcm fifo>'  camera: tap the call's video/audio into those FIFOs (on the\n"
            "               held ring with early media, on the call up, or on a camera call placed for\n"
            "               it); answered with 'CAMERA ok|fail <why>', then 'CAMERA live' at the first\n"
            "               keyframe and 'CAMERA end' when the picture stops\n"
            "  STATION_KEEPALIVE_MS: keep the call up this long after the last activity (min 500 ms).\n"
            "  STATION_IDLE_SECONDS: the camera stops when no reader drains its FIFO this long (10).\n"
            "  STATION_ANSWER_RING=1: hold a doorbell ring unanswered ('RING held' / 'RING gone');\n"
            "    an announcement or door press during it answers it.\n"
            "  STATION_OPEN_AUDIO_AT_START=1: open the audio on every camera call (the entrance sound;\n"
            "    next camera then re-dials). STATION_MAC: phase-B station (dial with a `mac` header).\n"
            "  env: STATION_DATA_DIR=<dir> (unique per place), STATION_UUID, SIP_REALM, STATION_DEBUG=1\n"
            "    (per-second audio level + liblinphone warnings), STATION_TRACE=1 (liblinphone's full trace)\n",
            argv[0]);
    return 2;
  }
  const char *in_user = argv[1];
  const char *in_pass = argv[2];
  const char *out_uri = argv[3];
  g_idle_seconds = (int)env_ms("STATION_IDLE_SECONDS", 10);
  g_audio_at_start = getenv("STATION_OPEN_AUDIO_AT_START") != NULL;
  lp_talk_env = "STATION_AUDIO_IN";
  lp_atap_adopt = 1; /* the camera FIFO can be named while a call is already up */

  signal(SIGINT, on_sig);
  signal(SIGTERM, on_sig);

  load_black_frame();

  LinphoneCoreCbs *cbs = linphone_factory_create_core_cbs(linphone_factory_get());
  linphone_core_cbs_set_call_state_changed(cbs, on_call_state);
  linphone_core_cbs_set_registration_state_changed(cbs, on_reg_state);
  LpSetup setup = {
      .tag = "[station]",
      .user = in_user,
      .pass = in_pass,
      .data_dir = getenv("STATION_DATA_DIR"),
      .uuid = getenv("STATION_UUID"),
      /* The graphs are always built: the camera call needs them on every station (the phase-B camera
       * used to be recv's, with video). A phase-B door call is audio only (place_call disables video
       * on it) and a video stream such a station adds by re-INVITE is answered inactive. */
      .want_video = 1,
      .accept_video = phase_b_mac() == NULL,
      .auto_initiate = 1,
      .debug = getenv("STATION_DEBUG") != NULL,
      .trace = getenv("STATION_TRACE") != NULL,
  };
  LinphoneCore *lc = lp_create_core(&setup, cbs);
  linphone_core_cbs_unref(cbs);
  /* A held ring must outlast the station's own ring (~60 s); liblinphone's default would give up on
   * it after 30 s. */
  linphone_core_set_inc_timeout(lc, 120);

  if (!lp_wait_registered(lc, &g_reg_ok, &g_reg_failed, &g_running, 15000)) {
    slog("[station] not registered -> aborting\n");
    linphone_core_stop(lc);
    linphone_core_unref(lc);
    return 1;
  }

  /* Stay registered and serve commands from stdin -- each press pays only the call-setup time. */
  long long keepalive_ms = env_ms("STATION_KEEPALIVE_MS", 0);
  /* The add-on's `0` means "a fresh call per press"; the call is still held 500 ms after the tone so
   * the INFO lands before the BYE. */
  if (keepalive_ms < 500) keepalive_ms = 500;
  int fl = fcntl(STDIN_FILENO, F_GETFL, 0);
  fcntl(STDIN_FILENO, F_SETFL, fl | O_NONBLOCK);
  slog("[station] registered (keep-alive %lld ms), waiting for commands on stdin\n", keepalive_ms);
  command_loop(lc, out_uri, keepalive_ms);

  linphone_core_stop(lc);
  linphone_core_unref(lc);
  return 0;
}
