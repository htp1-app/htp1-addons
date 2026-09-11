#!/bin/bash
# Exercise the REAL receiver-core/bin/session-arbiter.sh in a Linux container.
#
# Only the two things it reaches outside itself are stubbed: setup_shield.sh
# (logged, so the ref-count can be asserted) and curl (serves a fake config.json
# and logs every webapi patch). The liveness probe is NOT stubbed -- the test
# creates real processes named librespot/shairport-sync holding a real fd under
# /dev/snd, so pgrep -x and the /proc/PID/fd read are the production ones.

set -u
ARB=/var/lib/olympia/addons/receiver-core/bin/session-arbiter.sh
SHIELDLOG=/tmp/shield.log
SENDLOG=/tmp/send.log
PASS=0; FAIL=0

mkdir -p /var/lib/olympia/addons/receiver-core/bin /opt/olympia /dev/snd
# The repo root is mounted at /work, so this runs the file that ships, not a copy.
cp /work/addons/receiver-core/bin/session-arbiter.sh "$ARB"
chmod +x "$ARB"
for a in airplay spotify dlna; do
  mkdir -p "/var/lib/olympia/addons/$a"
  cp "/work/addons/$a/addon.json" "/var/lib/olympia/addons/$a/"
done

cat > /opt/olympia/setup_shield.sh <<'EOF'
#!/bin/bash
echo "$1" >> /tmp/shield.log
EOF
chmod +x /opt/olympia/setup_shield.sh

# curl stub: serves config.json, logs webapi patches.
cat > /usr/local/bin/curl <<'EOF'
#!/bin/bash
for a in "$@"; do
  case "$a" in
    *config.json) cat /tmp/config.json; exit 0 ;;
    cmd=*)        echo "${a#cmd=}" >> /tmp/send.log ;;
  esac
done
exit 0
EOF
chmod +x /usr/local/bin/curl

setinput() { printf '{"input":"%s","inputs":{"airplay":{},"spotify":{},"upnp":{},"h1":{}}}' "$1" > /tmp/config.json; }
reset() { rm -rf /dev/shm/htp1-* ; : > "$SHIELDLOG"; : > "$SENDLOG"; setinput h1; }

ck() { # ck <label> <expected> <actual>
  if [[ "$2" == "$3" ]]; then echo "  PASS $1"; PASS=$((PASS+1))
  else echo "  FAIL $1"; echo "        expected: [$2]"; echo "        actual:   [$3]"; FAIL=$((FAIL+1)); fi
}

# A real process named like a receiver, holding a real fd under /dev/snd.
start_fake() { # start_fake <procname>
  cp /bin/sleep "/tmp/$1" 2>/dev/null
  touch /dev/snd/pcmC0D0p
  "/tmp/$1" 300 3</dev/snd/pcmC0D0p >/dev/null 2>&1 &
  echo $!
}
start_fake_silent() { # running, but NOT holding /dev/snd
  cp /bin/sleep "/tmp/$1" 2>/dev/null
  "/tmp/$1" 300 >/dev/null 2>&1 &
  echo $!
}
expire() { echo 1 > "/dev/shm/htp1-sessions/$1"; }

echo "=== 1. begin: claims ownership, raises shield, publishes then clears pending"
reset
"$ARB" begin airplay &
BG=$!
sleep 1
ck "pending during the settle window" "airplay" "$("$ARB" pending)"
ck "owner during the settle window"   "airplay" "$("$ARB" owner)"
wait $BG
ck "pending cleared after the switch"  ""        "$("$ARB" pending)"
ck "owner retained after the switch"   "airplay" "$("$ARB" owner)"
ck "shield raised once"                "on"      "$(cat $SHIELDLOG)"
ck "sent power then input"             '[{"op":"replace","path":"/powerIsOn","value":true}] [{"op":"replace","path":"/input","value":"airplay"}]' "$(tr '\n' ' ' < $SENDLOG | sed 's/ $//')"

echo
echo "=== 2. a second receiver does NOT steal the input"
setinput airplay
: > "$SENDLOG"
"$ARB" begin spotify
ck "owner unchanged"                   "airplay" "$("$ARB" owner)"
ck "spotify sent no input patch"       ""        "$(grep -c '"value":"spotify"' $SENDLOG | grep -v '^0$')"
ck "shield not raised twice"           "on"      "$(cat $SHIELDLOG)"

echo
echo "=== 3. reap keeps a receiver that still holds /dev/snd"
PID=$(start_fake librespot)
sleep 0.3
expire spotify
ck "expired-but-playing spotify survives" "spotify" "$(ls /dev/shm/htp1-sessions | grep spotify)"
kill $PID 2>/dev/null; wait $PID 2>/dev/null

echo
echo "=== 4. reap drops a receiver that is running but silent, and lowers the shield"
reset
"$ARB" begin upnp >/dev/null 2>&1
PID=$(start_fake_silent gmediarender)
sleep 0.3
expire upnp
"$ARB" owner >/dev/null            # any invocation reaps; production also has
                                   # session-reaper.sh driving "reap" directly
ck "silent upnp is reaped"             ""        "$(ls /dev/shm/htp1-sessions)"
ck "owner cleared by reap"             ""        "$("$ARB" owner)"
ck "shield lowered by reap"            "on off"  "$(tr '\n' ' ' < $SHIELDLOG | sed 's/ $//')"
kill $PID 2>/dev/null; wait $PID 2>/dev/null

echo
echo "=== 5. handoff follows the input when the box is on the receiver that ended"
reset
"$ARB" begin airplay >/dev/null 2>&1
"$ARB" begin spotify >/dev/null 2>&1
setinput airplay
: > "$SENDLOG"
"$ARB" end airplay
ck "ownership handed to spotify"       "spotify" "$("$ARB" owner)"
ck "input followed to spotify"         '[{"op":"replace","path":"/input","value":"spotify"}]' "$(cat $SENDLOG)"
ck "shield still up for spotify"       "on"      "$(tr '\n' ' ' < $SHIELDLOG | sed 's/ $//')"

echo
echo "=== 6. handoff does NOT override a manual selection"
reset
"$ARB" begin airplay >/dev/null 2>&1
"$ARB" begin spotify >/dev/null 2>&1
setinput h1                      # user picked HDMI 1 by hand
: > "$SENDLOG"
"$ARB" end airplay
ck "ownership still handed over"       "spotify" "$("$ARB" owner)"
ck "input left on the manual choice"   ""        "$(cat $SENDLOG)"

echo
echo "=== 7. last session out lowers the shield"
: > "$SHIELDLOG"
"$ARB" end spotify
ck "shield lowered"                    "off"     "$(cat $SHIELDLOG)"
ck "owner cleared"                     ""        "$("$ARB" owner)"

echo
echo "=== 8. a session ending inside its own settle window does not select itself"
reset
"$ARB" begin airplay &
BG=$!
sleep 1
"$ARB" end airplay
: > "$SENDLOG"
wait $BG
ck "no late input steal"               ""        "$(cat $SENDLOG)"
ck "pending cleared on the way out"    ""        "$("$ARB" pending)"

echo
echo "=== 9. an input code carrying a quote cannot break out of the Python"
reset
printf '{"input":"h1\\" or __import__(\u0027os\u0027).system(\u0027touch /tmp/PWNED\u0027) or \\"","inputs":{}}' > /tmp/config.json
"$ARB" begin airplay >/dev/null 2>&1
"$ARB" end airplay
ck "no code execution from MSO input"  "no"      "$([[ -e /tmp/PWNED ]] && echo yes || echo no)"

echo
echo "=== 10. the volume guard: which receiver may move the volume"
# receiver_is_active is what stops a merely-connected sender from changing the
# level of whatever someone else is listening to. It now depends on the
# arbiter's "pending", so the two are tested together rather than apart.
cp /work/addons/receiver-core/bin/volume-common.sh /var/lib/olympia/addons/receiver-core/bin/
# shellcheck source=/dev/null
. /var/lib/olympia/addons/receiver-core/bin/volume-common.sh

reset
setinput airplay
ck "selected input may set volume"       "yes" "$(receiver_is_active airplay && echo yes || echo no)"
ck "a different receiver may not"        "no"  "$(receiver_is_active spotify && echo yes || echo no)"

setinput h1
ck "nobody drives volume on HDMI"        "no"  "$(receiver_is_active airplay && echo yes || echo no)"

# A virtual input whose audio half is a receiver: that receiver IS the source.
printf '{"input":"v1","inputs":{"v1":{"virtual":{"video":"h1","audio":"spotify"}},"airplay":{},"spotify":{}}}' > /tmp/config.json
ck "virtual input resolves to its audio" "yes" "$(receiver_is_active spotify && echo yes || echo no)"
ck "and not to the other receiver"       "no"  "$(receiver_is_active airplay && echo yes || echo no)"

# The window between "begin" and the input switch landing: owner but not yet
# selected. Volume must be accepted here or the first slider move is dropped.
reset
setinput h1
"$ARB" begin airplay &
BG=$!
sleep 1
ck "accepted while the switch is pending" "yes" "$(receiver_is_active airplay && echo yes || echo no)"
wait $BG
setinput h1                       # arbiter switched, but user moved away after
ck "refused once pending has cleared"     "no"  "$(receiver_is_active airplay && echo yes || echo no)"
ck "  (this is the ownership bypass)"     "airplay" "$("$ARB" owner)"

echo
echo "=== 11. reaping a dead owner promotes the surviving session"
# The polite-"end" handover (test 5) has a reap twin: a receiver that died
# without "end" must hand over the same way, or the survivor plays on with no
# owner -- its volume events refused and the input parked on the dead one.
reset
"$ARB" begin airplay >/dev/null 2>&1
"$ARB" begin spotify >/dev/null 2>&1
PID=$(start_fake librespot)        # the survivor is demonstrably playing
sleep 0.3
setinput airplay                   # box still sitting on the dead owner
: > "$SENDLOG"
expire airplay                     # airplay died without sending "end"
"$ARB" reap                        # the reaper's verb
ck "ownership handed to the survivor"  "spotify" "$(cat /dev/shm/htp1-session-owner)"
ck "input followed to the survivor"    '[{"op":"replace","path":"/input","value":"spotify"}]' "$(cat $SENDLOG)"
ck "shield still up for the survivor"  "on"      "$(tr '\n' ' ' < $SHIELDLOG | sed 's/ $//')"
kill $PID 2>/dev/null; wait $PID 2>/dev/null

echo
echo "=== 12. a re-begin from a live session refreshes the lease, nothing more"
# librespot fires "playing" on every track change and unpause; that must not
# re-run the full begin, or it re-selects the input after the user manually
# switched away and re-powers a unit they turned off.
reset
"$ARB" begin spotify >/dev/null 2>&1
setinput h1                        # user picked HDMI 1 by hand
echo "$(( $(date +%s) + 5 ))" > /dev/shm/htp1-sessions/spotify
: > "$SENDLOG"; : > "$SHIELDLOG"
"$ARB" begin spotify               # track change re-fires the hook
ck "no power or input re-sent"         ""        "$(cat $SENDLOG)"
ck "shield not touched"                ""        "$(cat $SHIELDLOG)"
ck "owner unchanged"                   "spotify" "$("$ARB" owner)"
ck "lease refreshed by the re-begin"   "yes"     "$([[ "$(cat /dev/shm/htp1-sessions/spotify)" -gt "$(( $(date +%s) + 60 ))" ]] && echo yes || echo no)"

echo
echo "=== 13. handoff follows a VIRTUAL input backed by the receiver that ended"
# "Sitting on the receiver that just stopped" must resolve virtual inputs:
# v1{audio:airplay} counts as sitting on airplay, or the user is left on a
# silent input and the promoted owner's volume events are refused.
reset
"$ARB" begin airplay >/dev/null 2>&1
"$ARB" begin spotify >/dev/null 2>&1
printf '{"input":"v1","inputs":{"v1":{"virtual":{"video":"h1","audio":"airplay"}},"airplay":{},"spotify":{},"h1":{}}}' > /tmp/config.json
: > "$SENDLOG"
"$ARB" end airplay
ck "ownership handed to spotify"       "spotify" "$("$ARB" owner)"
ck "input followed from the virtual input" '[{"op":"replace","path":"/input","value":"spotify"}]' "$(cat $SENDLOG)"

echo
echo "=== 14. renew extends an existing lease and creates nothing"
reset
"$ARB" begin upnp >/dev/null 2>&1
echo "$(( $(date +%s) + 5 ))" > /dev/shm/htp1-sessions/upnp
"$ARB" renew upnp
ck "lease extended"                    "yes"     "$([[ "$(cat /dev/shm/htp1-sessions/upnp)" -gt "$(( $(date +%s) + 60 ))" ]] && echo yes || echo no)"
"$ARB" renew airplay
ck "renew of an absent session creates nothing" "" "$(ls /dev/shm/htp1-sessions | grep airplay)"

echo
echo "================================"
echo "  passed $PASS, failed $FAIL"
[[ "$FAIL" -eq 0 ]]
