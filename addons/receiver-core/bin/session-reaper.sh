#!/bin/bash
#
# Runs "session-arbiter.sh reap" every 30 seconds, for session-reap.service.
#
# The lease is 90 s (LEASE_SECS); a 30 s cadence bounds how long a crashed
# receiver can pin the CPU shield at ~2 minutes, without meaningful load: the
# arbiter takes the lock, finds nothing expired and exits in milliseconds. The
# first pass waits out one lease period -- nothing can have expired before
# then, and boot is busy enough already.

ARB="$(dirname "$(readlink -f "$0")")/session-arbiter.sh"

sleep 90
while :; do
    "$ARB" reap
    sleep 30
done
