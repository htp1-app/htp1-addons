#!/bin/bash
#
# Wake-on-play for the UPnP/DLNA renderer.
#
# AirPlay and Spotify each have a session hook -- shairport's
# run_this_before_play_begins, librespot's --onevent -- so they can announce
# the start of a session and the wake logic hangs off that. gmediarender has no
# equivalent: it exposes no script hook at all. So playback is detected the only
# way available from outside, by watching whether it holds the ALSA device.
#
# GStreamer's alsasink opens default:I2S when playback starts and releases it
# when it stops, so an edge on that is a reliable proxy for a session. Polling
# /proc/<pid>/fd is cheap -- a couple of readlinks every two seconds.

set -u

INPUT="upnp"
API="http://127.0.0.1/webapi"
POLL=2

send() { curl -s --max-time 5 -X POST --data-urlencode "cmd=$1" "$API" >/dev/null 2>&1; }

# True while gmediarender has a sound device open.
playing() {
    local pid
    pid=$(pgrep -x gmediarender | head -1) || return 1
    [[ -n "$pid" ]] || return 1
    ls -l "/proc/$pid/fd" 2>/dev/null | grep -q '/dev/snd/'
}

was=0
while true; do
    if playing; then
        if [[ "$was" -eq 0 ]]; then
            was=1
            # Power, input and shield are the arbiter's job; doing it
            # per-receiver raced the other two. See receiver-core/bin/session-arbiter.sh.
            /var/lib/olympia/addons/receiver-core/bin/session-arbiter.sh begin upnp
        fi
    else
        if [[ "$was" -eq 1 ]]; then
            was=0
            /var/lib/olympia/addons/receiver-core/bin/session-arbiter.sh end upnp
        fi
    fi
    sleep "$POLL"
done
