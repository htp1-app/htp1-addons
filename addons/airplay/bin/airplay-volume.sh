#!/bin/bash
#
# shairport-sync's run_this_when_volume_is_set, with the AirPlay volume: 0.0 at the top of the
# sender's slider down to -30.0, and -144.0 for mute. The unit takes it as a fraction of that
# range and moves its own volume by each change, so the stream is never attenuated in software
# (shairport runs with ignore_volume_control) and starting playback never changes the level.
#
# Senders do not use the whole range evenly -- an iPhone's slider bottoms out well above -30 --
# which matters little here: only the change between reports moves the unit.

VOL="${1:-}"
[[ "$VOL" =~ ^-?[0-9]+(\.[0-9]+)?$ ]] || exit 0

if awk "BEGIN { exit !($VOL <= -144) }"; then
    exec /opt/olympia/addon-source mute airplay
fi
exec /opt/olympia/addon-source volume airplay "$(awk "BEGIN { f = ($VOL + 30) / 30; if (f < 0) f = 0; if (f > 1) f = 1; printf \"%.4f\", f }")"
