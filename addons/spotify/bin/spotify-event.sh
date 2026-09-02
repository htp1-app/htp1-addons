#!/bin/bash
#
# librespot event hook: wake-on-play, and volume mapping.
#
# Called by librespot via --onevent. librespot passes state in the environment
# rather than as arguments:
#     PLAYER_EVENT   "volume_set", "playing", "paused", "stopped", ...
#     VOLUME         0 - 65535 (on volume_set)
#
# WAKE-ON-PLAY. librespot runs continuously so it stays discoverable in the
# Spotify picker -- a sender can only wake a device it can see. On the first
# audio of a session this powers the unit up and selects the Spotify input,
# which is what moves the DSP onto I2S and makes the front panel and web UI
# show what is actually playing. The CPU shield is raised here rather than in
# the systemd unit, so the isolated core is reserved only while audio flows,
# as alsaloop_start.sh does for USB gadget audio.
#
# VOLUME. librespot runs with --volume-range 1, so it applies at most -1 dB of
# its own and the stream reaches the DSP essentially untouched; the level is
# set downstream in the DSP and analog stage. This is the Spotify counterpart
# of airplay/bin/airplay-volume.sh, and deliberately maps through the same
# 60 dB span via the shared map_fraction_to_volume so the two feel alike and
# cannot drift apart: full slider gives the unit's own configured maximum
# (/cal/vph), and the bottom of the slider sits 60 dB below it, clamped to
# the unit's floor (/cal/vpl).

set -u

# shellcheck source=/dev/null
. /var/lib/olympia/addons/receiver-core/bin/volume-common.sh

send() { curl -s --max-time 5 -X POST --data-urlencode "cmd=$1" "$API" >/dev/null 2>&1; }

# Trace every event with the volume before and after, so an unexpected level on
# wake can be attributed instead of guessed at. One line per event into a small
# file; /var/log is a 50 MB tmpfs, so it is rotated by hand if it ever matters.
LOG=/var/log/olympia/spotify-event.log
vol_now() { curl -s --max-time 3 http://127.0.0.1/config.json 2>/dev/null     | python3 -c 'import json,sys; d=json.load(sys.stdin); print("%s/%s" % (d["volume"], d["powerIsOn"]))' 2>/dev/null; }
trace() { echo "$(date +%H:%M:%S) event=${PLAYER_EVENT:-?} VOLUME=${VOLUME:-} vol/power_before=$1 after=$2 $3" >> "$LOG"; }

case "${PLAYER_EVENT:-}" in
  playing)
      # Power, input and shield are the arbiter's job; doing it per-receiver
      # raced the other two. See receiver-core/bin/session-arbiter.sh.
      B=$(vol_now)
      /var/lib/olympia/addons/receiver-core/bin/session-arbiter.sh begin spotify
      trace "$B" "$(vol_now)" "(wake)"
      exit 0
      ;;
  stopped)
      /var/lib/olympia/addons/receiver-core/bin/session-arbiter.sh end spotify
      exit 0
      ;;
  volume_set)
      ;;
  *)
      exit 0
      ;;
esac

V="${VOLUME:-}"
[[ -z "$V" ]] && exit 0

# Slider at the bottom mutes rather than driving the processor to its floor.
if [[ "$V" -le 0 ]]; then
    receiver_is_active spotify || exit 0
    set_muted
    exit 0
fi

# 0..65535 -> a 60 dB window ending at vph, through the SHARED mapper
# (volume-common.sh) that airplay-volume.sh uses, so the two cannot drift
# apart; it reads /cal/vph and /cal/vpl live and clamps to them.
#
# The top of the slider reaches the unit's own configured maximum (/cal/vph).
# Deliberately turning the controlling device all the way up is the owner's
# call; the safety lives in the DEFAULT instead -- see --initial-volume in
# spotify.service, which is low, so that a Connect device applying its
# remembered volume on selection cannot start playback at full tilt.
FRAC=$(awk "BEGIN{ printf \"%.6f\", $V / 65535.0 }")
TARGET=$(map_fraction_to_volume "$FRAC" 60)

# Ignore volume from a sender that is merely connected -- without this,
# nudging the slider in a connected Spotify app would change the level of
# whatever is actually playing on another input.
receiver_is_active spotify || exit 0

B=$(vol_now)
# One ordered patch: volume first, then unmute. Sent separately with unmute
# first, the box unmutes at the PREVIOUS level before attenuating.
set_volume_unmuted "$TARGET"
sleep 1
trace "$B" "$(vol_now)" "(mapped target=$TARGET)"
