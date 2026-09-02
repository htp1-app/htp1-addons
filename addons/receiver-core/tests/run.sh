#!/bin/bash
#
# Run the session arbiter tests. Needs Docker; nothing else.
#
#     addons/receiver-core/tests/run.sh
#
# The arbiter is device-side shell that coordinates three receivers against one
# audio output, and its failures are the kind that only show up when two people
# stream at once -- an input stolen mid-listen, a CPU shield left up, a volume
# slider driving the wrong source. None of that is reachable from the vitest
# suite in htp1-custom-controller, which covers the pure resolver only.
#
# So the arbiter runs here for real, in Linux, against real processes: the tests
# create processes named librespot and shairport-sync holding a real descriptor
# under /dev/snd, so the pgrep -x and /proc/<pid>/fd liveness probe under test
# is the production one. Only setup_shield.sh and curl are stubbed, and both are
# logged so the CPU-shield ref-count and every emitted webapi patch can be
# asserted.

set -eu
cd "$(dirname "$0")"
REPO=$(cd ../../.. && pwd)
# Git Bash rewrites container paths like /work unless told not to.
case "$(uname -s)" in MINGW*|MSYS*) REPO=$(cd ../../.. && pwd -W); export MSYS_NO_PATHCONV=1 ;; esac

docker build -q -t htp1-arbiter-test . >/dev/null
exec docker run --rm -v "$REPO":/work htp1-arbiter-test bash /work/addons/receiver-core/tests/run-tests.sh
