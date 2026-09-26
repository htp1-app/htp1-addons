# airplay

Makes the HTP-1 appear as an AirPlay target, so an iPhone, iPad or Mac can play
to it directly. Audio lands on `default:I2S` — the same sink Roon, USB gadget
audio and Bluetooth already use — and from there goes to the APM DSP, so it gets
Dirac, bass management and the processor's own volume like any other input.

**AirPlay 2 is what ships** — shairport-sync 4.3.7, built `--with-avahi`. That
gets multi-room grouping with other AirPlay 2 devices, the Home app and Siri
targeting, none of which AirPlay 1 offers. The AirPlay 1 build is still
reproducible from `Dockerfile` and the reasoning is kept below, because the
route to AirPlay 2 went through it and the dependency notes still apply.

## What ships

| | |
|---|---|
| `bin/shairport-sync` | 514 KB stripped, **shairport-sync 4.3.7 AirPlay 2** |
| `bin/nqptp` | 26 KB; the PTP timing peer AirPlay 2 requires |
| `etc/shairport-sync.conf` | config |
| `bin/airplay-volume.sh` | passes the sender's volume to the unit, which moves its own by each change |
| `bin/run-foreground.sh` | runs the receiver by hand for debugging, with the service stopped |
| `units/airplay.service`, `units/nqptp.service` | systemd units |
| `units/avahi-daemon.service.d/htp1.conf` | lets avahi stop when AirPlay is off |
| `debs/` | `avahi-daemon` and `libavahi-core7`, installed offline |
| `build/Dockerfile` | reproduces the binaries |
| `build/Dockerfile.airplay1` | the older AirPlay 1 build, kept for reference |

AirPlay 2 requires `avahi-daemon`, so this is the one receiver that puts
packages on the rootfs. They are removed with the addon. avahi is pulled up
by `airplay.service` through `Requires=` and stops when unneeded, so a unit
with AirPlay switched off runs no avahi; `hooks/install` makes sure it is not
also enabled at boot.

## Build

    docker build --platform linux/arm/v7 -t sps-build build

The image is `arm32v7/debian:stretch-slim` — the same Debian 9 / glibc 2.24 /
armhf the unit runs — so the binary links against symbol versions the device
already has. Building on the unit itself would work (`gcc` and `make` are
present) but would mean installing four `-dev` packages onto the rootfs.

Stretch is EOL, so the Dockerfile points apt at `archive.debian.org` and
disables the `Valid-Until` check.

**`libconfig` is linked statically.** It is the one library shairport-sync needs
that the unit does not already have; the rest — libasound2, libssl1.1, libpopt0,
libstdc++ — are all present. Linking it in avoids shipping a `.so` or setting
`LD_LIBRARY_PATH`. Relink after building:

    g++ ... -lasound -lssl -lcrypto /usr/lib/arm-linux-gnueabihf/libconfig.a -lpopt -lm -lpthread -lrt

Confirm before deploying that nothing is unresolved on the target:

    ldd /var/lib/olympia/addons/airplay/bin/shairport-sync | grep 'not found'

## mDNS

AirPlay 2 **requires Avahi** — shairport-sync's own `CONFIGURATION FLAGS.md`
makes `--with-avahi` mandatory, and built with `tinysvcmdns` instead it
advertises only `_raop._tcp`, so no sender ever sees an AirPlay 2 device. The
stock rootfs has the avahi *client* libraries but no daemon, which is why
`avahi-daemon` is one of the two packages installed. It coexists with
`htp1-mdns-svc`: both hold 5353 and both answer.

## Input wiring

The manifest registers `airplay` as an input that routes to `i2s`. Selecting
it sends the console verb `i2s` to avController, the same generic command
`roon`, `b` and `usb` use; `ALSAI2S` tracks the sample rate on its own, so
AirPlay's fixed 44.1 kHz is handled. The service runs continuously so senders
can see it. `run_this_before_play_begins` (under `sessioncontrol`, with
`wait_for_completion`) calls `addon-source start airplay` before every stream
opens the device: the unit selects AirPlay, waking first if it has to, and
the device is free when the hook returns. Selecting another input, or
standby, restarts the service, which ends the sender's session; the sender
pauses and does not reconnect by itself. The front panel and web UI name the
input from its label, so both read "AirPlay".

## Verified

2026-08-31 on the bench unit (firmware V2.1.3, avController 5.120):

- binary runs, no unresolved libraries, reports
  `3.3.9-OpenSSL-tinysvcmdns-ALSA-pipe`
- binds UDP 5353 and TCP 5000 (RTSP)
- discoverable over multicast from another host on the LAN, appearing as
  `HTP-1` beside the Apple TVs and the Denon on the same network
- `i2s 44100` moves the DSP to the I2S input while leaving HSR video routing
  untouched

Not yet verified: audio actually playing from a sender end to end.

## AirPlay 2 — attempted 2026-08-31

`Dockerfile.airplay2` builds shairport-sync **4.3.7 with AirPlay 2** plus
`nqptp`. It works. Three risks were flagged before trying and **none of them
turned out to be real**:

| Flagged risk | Outcome |
|---|---|
| CPU too weak (dual-core A7) | Not a constraint. shairport-sync 4 runs on a Pi Zero W, which is weaker. AAC-LC stereo decode is a few percent of one core. |
| ffmpeg 3.2 too old for the 4.x source | Compiled clean. `configure.ac` sets no version floor on `libav*`, and the source used nothing newer. |
| PTP timing / `nqptp` on the forced-100 Mbit NIC | Built, ran, bound UDP 319/320 without complaint. |

Dependency work needed: **libplist** built from source (stretch has 1.12,
`configure.ac` demands >= 2.0.0), then `libplist-2.0`, `libsodium` and
`libconfig` linked statically. Result is **514 KB** with **zero unresolved
libraries on the unit** — the unit already carries ffmpeg 3.2 and its whole
tree, because it is an Armbian desktop image. `nqptp` is a further 26 KB.

On the unit it reports `4.3.7-AirPlay2-smi10-OpenSSL-tinysvcmdns-ALSA-pipe`,
binds TCP **7000** (the AirPlay 2 port, not AirPlay 1's 5000) and UDP 5353,
and `nqptp` holds 319/320.

### What blocks it: Avahi

The device advertises `_raop._tcp` but **not** `_airplay._tcp`, so senders never
see it as an AirPlay 2 device. This is not a bug in the build — from
shairport-sync's own `CONFIGURATION FLAGS.md`:

> AirPlay 2 operation requires the Avahi libraries, so the option `--with-avahi`
> is mandatory.

`configure` accepts `--with-tinysvcmdns` for an AirPlay 2 build without
complaint and yields a half-advertised device. `--with-avahi` links
`libavahi-client`, which talks over D-Bus to a running `avahi-daemon`.

The unit has the avahi **client** libraries and a live D-Bus, but no
`avahi-daemon`. Installing it is small — `apt-get install --no-install-recommends
avahi-daemon` pulls exactly **two** packages, `avahi-daemon` and
`libavahi-core7` — but it is a rootfs modification, which is the one thing this
folder and `mdns-svc` and `ui-background-svc` have all avoided.

Note that `htp1-mdns-svc` already being an mDNS responder does not help:
shairport needs the Avahi *client API* to register and mutate `_airplay._tcp`
TXT records (public key, feature flags, group state) at runtime, and those must
agree with its RTSP endpoint or pairing fails. Port sharing is not the issue —
two responders on 5353 were observed coexisting fine during this test.

### Resolved — AirPlay 2 is what ships

The two packages were accepted and installed, so `Dockerfile.airplay2` now
builds `--with-avahi` and the result reports
`4.3.7-AirPlay2-smi10-OpenSSL-Avahi-ALSA-pipe`. It advertises **both**
`_airplay._tcp` and `_raop._tcp` and appears alongside the other AirPlay 2
devices on the network.

`avahi-daemon` and `libavahi-core7` were installed from `archive.debian.org`
with `dpkg -i` rather than `apt-get`, because the unit's `sources.list` still
points at `httpredir.debian.org`, which no longer serves stretch and 404s.
Fetch them from
`http://archive.debian.org/debian/pool/main/a/avahi/`. This leaves apt's
configuration untouched. avahi-daemon coexists with `htp1-mdns-svc`; both hold
5353 and both answer.

| Runs as | |
|---|---|
| `airplay.service` | started and stopped by the firmware from the AirPlay switch; runs continuously while on. Pulls up `nqptp` and `avahi-daemon` through `Requires=`. |
| `nqptp.service` | ~26 KB, idle between sessions; `StopWhenUnneeded`, so it follows AirPlay off. |
