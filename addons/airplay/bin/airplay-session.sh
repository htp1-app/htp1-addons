#!/bin/bash
#
# Wake-on-play for AirPlay.
#
# Called by shairport-sync from general.run_this_before_play_begins and
# run_this_after_play_ends, with "begin" or "end" as the argument.
#
# The receivers now run continuously so they stay discoverable -- a sender can
# only wake a device it can see, and previously each receiver was started and
# stopped with its input, so AirPlay was not even advertising unless it was
# already the selected input.
#
# On the first audio of a session this powers the unit up and selects the
# AirPlay input. Selecting the input is what moves the DSP onto I2S; it also
# means the front panel and the web UI show what is actually playing.
#
# The CPU shield is raised here rather than in the systemd unit, so the
# isolated core is reserved only while audio is actually flowing -- the same
# thing alsaloop_start.sh does for USB gadget audio. Leaving it up permanently
# would confine avController, Dirac and Node-RED to one core for no reason.

set -u

ACTION="${1:-begin}"
INPUT="airplay"
API="http://127.0.0.1/webapi"

send() { curl -s --max-time 5 -X POST --data-urlencode "cmd=$1" "$API" >/dev/null 2>&1; }

# All of the power/input/shield logic now lives in the arbiter, because doing
# it per-receiver raced: see receiver-core/bin/session-arbiter.sh.
case "$ACTION" in
  begin) /var/lib/olympia/addons/receiver-core/bin/session-arbiter.sh begin airplay ;;
  end)   /var/lib/olympia/addons/receiver-core/bin/session-arbiter.sh end   airplay ;;
esac

exit 0
