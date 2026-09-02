#!/bin/bash
#
# Map the AirPlay sender's volume onto the HTP-1's own volume control.
#
# Called by shairport-sync from general.run_this_when_volume_is_set as:
#     airplay-volume.sh <volume>
# where <volume> is the raw AirPlay value: nominally 0.0 (loudest) down to
# -30.0, and -144.0 for mute.
#
# This is the AirPlay equivalent of Roon's "volume": {"type": "mso"} -- the
# stream stays untouched (shairport runs with ignore_volume_control, so no
# lossy software attenuation) and the level is set downstream in the DSP and
# analog stage, where the HTP-1 does it properly.
#
# MAPPING. The first attempt was 1:1 in dB anchored at the unit's own maximum,
# assuming senders use the full -30..0 range. They do not: on an iPhone the
# slider bottomed out around -19 dB, so with vph = -7 the quietest reachable
# setting was about -26 -- far too loud. The sender's range is now stretched
# over SPAN_DB ending at vph. Measured values from a real sweep: -22.5 to
# -29.6, plus -144 for mute, and the slider is not linear in dB.
#
# See volume-common.sh for why this only acts when it is the active receiver,
# and why volume and unmute go out as one ordered patch.

set -u

# shellcheck source=/dev/null
. /var/lib/olympia/addons/receiver-core/bin/volume-common.sh

VOL="${1:-}"
[[ -z "$VOL" ]] && exit 0

SENDER_MIN=-30.0
SPAN_DB=60.0

# Ignore volume from a sender that is merely connected. Without this, nudging
# the volume in an AirPlay app would change the level of whatever is actually
# playing on another input.
receiver_is_active airplay || exit 0

log() {
    [[ "${AIRPLAY_VOLUME_DEBUG:-0}" == "1" ]] || return 0
    echo "$(date +%H:%M:%S) airplay=$VOL -> mso=${1:-mute}" >> /var/log/olympia/airplay-volume.log
}

# -144 is AirPlay's mute. Mute without changing the volume, so unmuting later
# comes back at the same level rather than the floor.
if awk "BEGIN{exit !($VOL <= -144)}"; then
    log
    set_muted
    exit 0
fi

FRAC=$(awk "BEGIN{ f = ($VOL - ($SENDER_MIN)) / (0 - ($SENDER_MIN)); printf \"%.6f\", f }")
TARGET=$(map_fraction_to_volume "$FRAC" "$SPAN_DB")

log "$TARGET"
set_volume_unmuted "$TARGET"
