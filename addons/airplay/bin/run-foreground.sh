#!/bin/bash

# Run the AirPlay receiver BY HAND, for debugging: a restart loop with output
# tee'd to its own log under /var/log/olympia. Formerly start-airplay.sh in
# the firmware tree.
#
# In normal operation shairport-sync is run by airplay.service, which starts
# at boot and stays up so the unit remains discoverable -- wake-on-play needs
# the receiver advertising before any input is selected -- and which sets up
# the RT scheduling budget shairport wants. It is NOT started and stopped
# with the input the way bluealsa-aplay and usbaudio are. This script exists
# only for running the same binary and config manually; it refuses to start
# a second copy against the service, because two instances fight over
# default:I2S and the Avahi name.

if systemctl is-active --quiet airplay 2>/dev/null; then
    echo "airplay.service is running; stop it first: systemctl stop airplay" >&2
    exit 1
fi

echo '############' >> /var/log/olympia/airplay.log
echo run-foreground.sh started >> /var/log/olympia/airplay.log
date +%dT%H%M%S.%N | sed -E 's/\.([0-9][0-9][0-9]).*/.\1/g' >> /var/log/olympia/airplay.log

SPS=/var/lib/olympia/addons/airplay/bin/shairport-sync
CONF=/var/lib/olympia/addons/airplay/etc/shairport-sync.conf

# Advertise under the name the owner gave the unit rather than a generic one.
# Node-RED writes this file; fall back if it is missing or empty.
NAME="$(tr -d '\000-\037' < /var/lib/olympia/unitname.txt 2>/dev/null)"
[[ -z "$NAME" ]] && NAME="HTP-1"

while [[ 1 ]]; do
    echo "restarting shairport-sync as \"$NAME\"" >> /var/log/olympia/airplay.log
    # -a overrides the name in the config file.
    nice -n 1 "$SPS" --configfile="$CONF" -a "$NAME" 2>&1 | tee -a /var/log/olympia/airplay.log
    sleep 1
done
