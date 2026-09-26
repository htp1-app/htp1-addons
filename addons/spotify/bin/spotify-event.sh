#!/bin/bash
#
# librespot's --onevent. With --emit-sink-events librespot runs this and waits for it just before
# it opens the I2S device, for a new stream, a resume or a track it had not preloaded:
# PLAYER_EVENT=sink SINK_STATUS=running. That is when the unit selects Spotify and frees the
# device. A start for the input already playing changes nothing, so every open may ask.
#
# Every other event is fire-and-forget. VOLUME (0-65535) goes to the unit as a fraction; the unit
# moves its own volume by each change, and 0 mutes. "playing" is not a session start: librespot
# also sends it on resume, seek and whenever playback catches up after a stall.

case "${PLAYER_EVENT:-}" in
    sink)
        [[ "${SINK_STATUS:-}" == "running" ]] && exec /opt/olympia/addon-source start spotify
        ;;
    volume_set)
        [[ "${VOLUME:-}" =~ ^[0-9]+$ ]] || exit 0
        [[ "$VOLUME" -eq 0 ]] && exec /opt/olympia/addon-source mute spotify
        exec /opt/olympia/addon-source volume spotify "$(awk "BEGIN { f = $VOLUME / 65535; if (f > 1) f = 1; printf \"%.4f\", f }")"
        ;;
esac
exit 0
