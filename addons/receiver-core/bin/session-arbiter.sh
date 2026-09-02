#!/bin/bash
#
# Session arbiter for the network receivers.
#
# Three receivers run continuously and each used to power on, select its own
# input and toggle the CPU shield independently. That raced in several ways,
# and the first version of this file only fixed some of them. What it now does:
#
#   OWNERSHIP. Exactly one receiver owns the output at a time, recorded in
#   OWNER. Two receivers starting together no longer both select themselves
#   with the last write winning; the first to take ownership keeps it, and a
#   later arrival does NOT steal the input. (It still plays into the shared
#   ALSA device if it can open it -- arbitrating the device itself is the
#   receivers' business -- but it cannot hijack the processor's input.)
#
#   LEASES, CHECKED AGAINST LIVENESS. Each session marker carries an expiry. An
#   earlier version relied on "renew" to push that expiry out, which was wrong:
#   neither shairport-sync nor librespot has a periodic hook, so nothing ever
#   called it and every session expired 90 seconds in -- mid-listen -- letting a
#   later receiver take the input from one still playing. Expiry is now only a
#   trigger to ASK: a receiver still holding /dev/snd is playing and gets
#   extended; one that is not is reaped. So a crashed receiver is still cleaned
#   up, and a long stream is not. Expiry used to be checked only when some
#   receiver event happened to invoke this script, so a crashed receiver could
#   sit unreaped for as long as the box stayed quiet; receiver-core/units/session-reap.timer
#   now runs "reap" every 30 seconds to bound that.
#
#   REF-COUNTED SHIELD. Raised on the first live session, dropped only when
#   none remain -- an ending AirPlay session must not remove the isolated core
#   from a Spotify stream still playing. Reaping drops it too, so a receiver
#   that died without sending "end" no longer pins the isolated core up.
#
#   PROMOTION, HOWEVER A SESSION LEAVES. Reaping a dead owner hands ownership
#   to a surviving session exactly like a polite "end" does. Without that, the
#   survivor played on with no owner recorded: its volume events were refused
#   by the guard in volume-common.sh and the input stayed parked on the dead
#   receiver until the survivor's NEXT session began.
#
#   A RE-BEGIN IS A LEASE REFRESH. librespot fires "playing" on every track
#   change and unpause, and shairport re-fires its begin hook on resume. While
#   this receiver's session is already live, that must not re-run the full
#   begin: it would re-send power and re-select this input even after the user
#   manually switched away -- exactly the steal this file exists to prevent.
#
#   NO LATE INPUT STEAL. A session that ends inside its own settle window does
#   not then select itself afterwards.
#
#   PENDING. Between "begin" and the input switch actually landing there is a
#   window where this receiver is the owner but is not yet the selected input.
#   The volume hooks need to accept events during that window and refuse them
#   afterwards, so it is published rather than inferred from ownership -- see
#   the guard in receiver-core/bin/volume-common.sh.
#
# Usage:
#   session-arbiter.sh begin <name>       # airplay | spotify | upnp
#   session-arbiter.sh end   <name>
#   session-arbiter.sh renew <name>       # refresh the lease (optional)
#   session-arbiter.sh reap               # expire dead sessions (the timer's verb)
#   session-arbiter.sh owner              # print the current owner, if any
#   session-arbiter.sh pending            # print the owner awaiting its switch
#
# State lives in tmpfs, so it cannot survive a reboot half-written.

set -u

STATE_DIR=/dev/shm/htp1-sessions
OWNER=/dev/shm/htp1-session-owner
PENDING=/dev/shm/htp1-session-pending
LOCK=/dev/shm/htp1-sessions.lock
API="http://127.0.0.1/webapi"
LEASE_SECS=90
SETTLE_SECS=3

ACTION="${1:-}"
NAME="${2:-}"
[[ -z "$ACTION" ]] && exit 0

mkdir -p "$STATE_DIR"

exec 9>"$LOCK"
flock -w 10 9 || exit 0

send() { curl -s --max-time 5 -X POST --data-urlencode "cmd=$1" "$API" >/dev/null 2>&1; }
now()  { date +%s; }

# The audio source the currently selected input RESOLVES to: itself for an
# ordinary input, the audio half for a virtual one (the same resolution
# volume-common.sh does). The raw code is not enough: a virtual input backed
# by a receiver must count as "sitting on" that receiver, or ending a session
# under v1{audio:airplay} leaves the box on a silent input with the promoted
# owner's volume events refused. Nothing MSO-derived is interpolated into the
# Python source -- this runs as root and MSO is not trusted input; everything
# is read out of the document inside the interpreter.
resolved_input() {
    curl -s --max-time 4 http://127.0.0.1/config.json 2>/dev/null         | python3 -c 'import json,sys
try:
    d = json.load(sys.stdin)
    cur = d.get("input", "")
    e = (d.get("inputs") or {}).get(cur) or {}
    v = e.get("virtual") or {}
    print((v.get("audio") or cur) if isinstance(v, dict) else cur)
except Exception:
    pass' 2>/dev/null
}

# Process name for a receiver, from the manifest of the addon that owns its input code.
proc_for() {
    python3 - "${ADDONS_DIR:-/var/lib/olympia/addons}" "$1" <<'PY' 2>/dev/null
import glob, json, sys
for f in glob.glob(sys.argv[1] + "/*/addon.json"):
    try:
        d = json.load(open(f))
    except Exception:
        continue
    if (d.get("input") or {}).get("code") == sys.argv[2]:
        print((d.get("service") or {}).get("process", ""))
        break
PY
}

# Is that receiver still holding a sound device? This is the liveness test that
# keeps a long session alive: nothing calls renew from shairport or librespot
# (neither offers a periodic hook), so a fixed lease would expire mid-listen and
# let a later receiver steal the input. A receiver holding /dev/snd is playing,
# full stop.
still_playing() {
    local proc pid
    proc=$(proc_for "$1")
    [[ -z "$proc" ]] && return 1
    pid=$(pgrep -x "$proc" | head -1)
    [[ -n "$pid" ]] || return 1
    ls -l "/proc/$pid/fd" 2>/dev/null | grep -q '/dev/snd/'
}

# Hand things over after a session leaves, however it left. If the departure
# removed the owner, promote a surviving session so its volume events are
# accepted and a later "begin" from it is not a no-op; a standing live owner
# is kept. Either way, follow with the input ONLY if the box is still sitting
# on the receiver that went away -- resolved through virtual inputs, so a
# virtual entry backed by it counts. If the user has since selected something
# else, leave it: they made that choice more recently than either receiver
# did, and stealing the input back is the behaviour this whole file exists to
# prevent. Shared by "end" and reap(): a dead owner must hand over exactly
# the way a polite one does. $1 = the receiver that went away.
promote_next() {
    local gone="$1" next
    next=$(cat "$OWNER" 2>/dev/null)
    if [[ -z "$next" ]]; then
        next=$(ls -1 "$STATE_DIR" 2>/dev/null | head -1)
        [[ -z "$next" ]] && return 0
        echo "$next" > "$OWNER"
    fi
    if [[ "$(resolved_input)" == "$gone" ]]; then
        send "[{\"op\":\"replace\",\"path\":\"/input\",\"value\":\"${next}\"}]"
    fi
    return 0
}

# Drop sessions whose lease has expired AND that are demonstrably not playing.
# Lowering the shield here matters: a receiver that crashed without sending
# "end" used to pin the isolated core up until another session happened to end.
reap() {
    local f name exp before after
    before=$(ls -1 "$STATE_DIR" 2>/dev/null | wc -l)
    for f in "$STATE_DIR"/*; do
        [[ -e "$f" ]] || continue
        name=$(basename "$f")
        exp=$(cat "$f" 2>/dev/null || echo 0)
        [[ "$exp" -ge "$(now)" ]] && continue
        if still_playing "$name"; then
            # Alive after all -- extend rather than reap.
            echo "$(( $(now) + LEASE_SECS ))" > "$f"
            continue
        fi
        rm -f "$f"
        if [[ "$(cat "$OWNER" 2>/dev/null)" == "$name" ]]; then
            rm -f "$OWNER"
            [[ "$(cat "$PENDING" 2>/dev/null)" == "$name" ]] && rm -f "$PENDING"
            promote_next "$name"
        fi
    done
    after=$(ls -1 "$STATE_DIR" 2>/dev/null | wc -l)
    if [[ "$before" -gt 0 ]] && [[ "$after" -eq 0 ]]; then
        /opt/olympia/setup_shield.sh off >/dev/null 2>&1
    fi
}

live_count() { reap; ls -1 "$STATE_DIR" 2>/dev/null | wc -l; }

case "$ACTION" in
  owner)
    reap
    cat "$OWNER" 2>/dev/null
    ;;

  pending)
    # Non-empty only between "begin" and the input switch actually landing.
    cat "$PENDING" 2>/dev/null
    ;;

  renew)
    [[ -z "$NAME" ]] && exit 0
    [[ -e "$STATE_DIR/$NAME" ]] && echo "$(( $(now) + LEASE_SECS ))" > "$STATE_DIR/$NAME"
    ;;

  begin)
    [[ -z "$NAME" ]] && exit 0
    reap

    # A re-"begin" from a receiver whose session is already live is a lease
    # refresh, not a new session -- see the header. Only short-circuit when no
    # switch of ours is pending, so a begin racing its own settle window still
    # goes through the re-check below.
    if [[ -e "$STATE_DIR/$NAME" ]] && [[ "$(cat "$PENDING" 2>/dev/null)" != "$NAME" ]]; then
        echo "$(( $(now) + LEASE_SECS ))" > "$STATE_DIR/$NAME"
        exit 0
    fi

    echo "$(( $(now) + LEASE_SECS ))" > "$STATE_DIR/$NAME"

    # First live session raises the shield; later ones inherit it.
    [[ "$(ls -1 "$STATE_DIR" | wc -l)" -eq 1 ]] && /opt/olympia/setup_shield.sh on >/dev/null 2>&1

    # Claim ownership only if nobody holds it. A second receiver starting while
    # one is already playing does NOT take the input away.
    if [[ -s "$OWNER" ]] && [[ "$(cat "$OWNER")" != "$NAME" ]]; then
        exit 0
    fi
    echo "$NAME" > "$OWNER"
    echo "$NAME" > "$PENDING"

    # Power first: an input change while the unit is in standby is dropped by
    # handle_input_commands, which ignores them unless the AVR power state is
    # ON or STANDBY_to_ON.
    send '[{"op":"replace","path":"/powerIsOn","value":true}]'

    # Release the lock across the settle wait so an "end" arriving meanwhile is
    # not blocked behind us -- that is exactly the race being guarded.
    flock -u 9
    sleep "$SETTLE_SECS"
    if ! flock -w 10 9; then
        # Bail, but never leave PENDING behind: it holds the volume guard's
        # ownership bypass open (volume-common.sh) long after any switch could
        # still be coming, letting a merely-connected sender keep driving --
        # and unmuting -- the volume. Only our own marker, though: another
        # receiver may have begun during the wait.
        [[ "$(cat "$PENDING" 2>/dev/null)" == "$NAME" ]] && rm -f "$PENDING"
        exit 0
    fi

    # Re-check both: the session may have ended, or ownership may have moved,
    # during the wait. Either way, do not steal the input.
    if [[ ! -e "$STATE_DIR/$NAME" ]] || [[ "$(cat "$OWNER" 2>/dev/null)" != "$NAME" ]]; then
        [[ "$(cat "$PENDING" 2>/dev/null)" == "$NAME" ]] && rm -f "$PENDING"
        exit 0
    fi

    send "[{\"op\":\"replace\",\"path\":\"/input\",\"value\":\"${NAME}\"}]"
    rm -f "$PENDING"
    ;;

  end)
    [[ -z "$NAME" ]] && exit 0
    rm -f "$STATE_DIR/$NAME"
    [[ "$(cat "$PENDING" 2>/dev/null)" == "$NAME" ]] && rm -f "$PENDING"
    [[ "$(cat "$OWNER" 2>/dev/null)" == "$NAME" ]] && rm -f "$OWNER"

    if [[ "$(live_count)" -gt 0 ]]; then
        promote_next "$NAME"
    else
        /opt/olympia/setup_shield.sh off >/dev/null 2>&1
    fi

    ;;

  reap)
    # The timer's verb (receiver-core/units/session-reap.timer). Reaping used to happen
    # only when some receiver event invoked this script, so a receiver that
    # crashed without its "end" hook pinned the CPU shield -- and held a stale
    # owner -- until the next event, possibly forever on a box left on HDMI.
    # The timer gives expiry an upper bound.
    reap
    ;;
esac

exit 0
