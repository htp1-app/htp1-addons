#!/bin/bash
#
# Shared helpers for the receiver volume hooks (AirPlay, Spotify, and any
# future one). Sourced, not executed.
#
# Two things here exist because of a review finding, and both matter:
#
# GUARD. A receiver's volume hook fires whenever its sender moves a slider,
# whether or not that receiver is the input the processor is actually playing.
# Without a guard, someone nudging the volume in a Spotify app that is merely
# *connected* would change the level of whatever is playing on HDMI. The guard
# accepts the event only when this receiver is genuinely the active source --
# either it is the selected input, or it currently holds the shared ALSA
# device, which covers the window during session start before the wake hook has
# switched the input.
#
# ATOMICITY AND ORDER. Volume and unmute must land as ONE patch, with the
# volume first. Sent as two requests with unmute first, the box unmutes at the
# PREVIOUS level and only then attenuates -- a burst at whatever the last
# listener had set, which on this hardware can be a great deal louder. The
# webapi sends each op as its own changemso, so it cannot do this; port 1799
# hands the Commander a single array that it applies in one pass.

API="http://127.0.0.1/webapi"
VERB_PORT=1799

# Read a top-level MSO value. $1 = key.
#
# The key and any MSO-derived value are passed as ARGUMENTS, never interpolated
# into the Python source. These hooks run as root, and an input code is
# attacker-influenceable MSO data -- a code containing a quote could otherwise
# close the string literal and execute arbitrary code on the next volume event.
mso_get() {
    curl -s --max-time 4 http://127.0.0.1/config.json 2>/dev/null         | python3 -c 'import json,sys
try:
    print(json.load(sys.stdin).get(sys.argv[1], ""))
except Exception:
    pass' "$1" 2>/dev/null
}

# The audio source an input code resolves to: itself for an ordinary input, the
# audio half for a virtual one. $1 = input code, passed as an argument.
mso_resolved_audio() {
    [[ -z "${1:-}" ]] && return 0
    curl -s --max-time 4 http://127.0.0.1/config.json 2>/dev/null         | python3 -c 'import json,sys
try:
    code = sys.argv[1]
    d = json.load(sys.stdin)
    e = d.get("inputs", {}).get(code) or {}
    v = e.get("virtual") or {}
    print(v.get("audio") or code)
except Exception:
    pass' "$1" 2>/dev/null
}

# Is this receiver the source the processor is actually playing?
#   $1 = our receiver name (airplay|spotify|upnp)
#
# Ownership alone is NOT enough. Arbiter ownership is not cleared when the user
# manually selects another input, so treating "owner" as sufficient let a
# sender's slider keep changing -- and unmuting -- the volume of whatever the
# user had switched to. Ownership therefore only bypasses the input check while
# the initial switch is genuinely PENDING; once the arbiter has applied it, the
# selected input must actually resolve to this receiver.
receiver_is_active() {
    local mine="$1" cur
    cur=$(mso_get input)

    # Normal case: the selected input is us, or a virtual input backed by us.
    [[ "$cur" == "$mine" ]] && return 0
    [[ "$(mso_resolved_audio "$cur")" == "$mine" ]] && return 0

    # Session start only: we own the session AND the arbiter has not yet
    # applied the input switch. Once it has, the checks above decide.
    if [[ "$(/var/lib/olympia/addons/receiver-core/bin/session-arbiter.sh owner 2>/dev/null)" == "$mine" ]]        && [[ "$(/var/lib/olympia/addons/receiver-core/bin/session-arbiter.sh pending 2>/dev/null)" == "$mine" ]]; then
        return 0
    fi

    return 1
}

# Apply volume and unmute as a single ordered patch. $1 = target volume.
set_volume_unmuted() {
    printf '%s' "changemso [{\"op\":\"replace\",\"path\":\"/volume\",\"value\":$1},{\"op\":\"replace\",\"path\":\"/muted\",\"value\":false}]" \
        | nc -w 2 127.0.0.1 "$VERB_PORT" >/dev/null 2>&1
}

# Mute without touching the volume, so unmuting later returns to the same level.
set_muted() {
    curl -s --max-time 4 -X POST --data-urlencode \
        'cmd=[{"op":"replace","path":"/muted","value":true}]' "$API" >/dev/null 2>&1
}

# Map a 0..1 fraction of a sender's range onto the unit's own volume scale.
# Reads /cal/vph and /cal/vpl live, so it fits whatever the owner configured
# rather than any one bench's values.
map_fraction_to_volume() {
    local frac="$1" span="${2:-60}" conf vph vpl
    conf=$(curl -s --max-time 4 http://127.0.0.1/config.json 2>/dev/null)
    vph=$(echo "$conf" | sed -n 's/.*"vph"[: ]*\(-\?[0-9.]*\).*/\1/p' | head -1)
    vpl=$(echo "$conf" | sed -n 's/.*"vpl"[: ]*\(-\?[0-9.]*\).*/\1/p' | head -1)
    [[ -z "$vph" ]] && vph=-20
    [[ -z "$vpl" ]] && vpl=-100
    awk "BEGIN{
        floor = $vph - $span;
        if (floor < $vpl) floor = $vpl;
        f = $frac; if (f < 0) f = 0; if (f > 1) f = 1;
        v = floor + f * ($vph - floor);
        if (v < $vpl) v = $vpl;
        if (v > $vph) v = $vph;
        printf \"%.0f\", v
    }"
}
