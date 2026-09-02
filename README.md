# htp1-addons

Installable packages for the HTP-1 that live outside the firmware tree. An
addon is installed and removed on its own, survives firmware updates, and
leaves the unit stock when removed. The format, and what the firmware does
with it, is in [docs/format.md](docs/format.md).

| Addon | What it is | Needs |
|---|---|---|
| [`receiver-core`](addons/receiver-core) | Session arbiter, reap timer and shared volume mapping for the network receivers | |
| [`airplay`](addons/airplay) | AirPlay 2 receiver: shairport-sync 4.3.7 with nqptp and avahi-daemon | `receiver-core` |
| [`spotify`](addons/spotify) | Spotify Connect receiver: librespot 0.4.2 | `receiver-core` |
| [`dlna`](addons/dlna) | UPnP/DLNA renderer: gmediarender with a wake-on-play watcher | `receiver-core` |

The three receivers play into `default:I2S`, the sink Roon, USB audio and
Bluetooth already use, so their audio gets Dirac, bass management and the
processor's volume like any other input. They run continuously so senders can
see them, release the device when idle, and wake the processor and select
their input when a sender starts playing. One plays at a time.

## Layout

```
addons/<id>/     one addon: addon.json, bin/, etc/, units/, debs/, hooks/,
                 build/ (Docker cross-build recipe), tests/
tools/pack.sh    builds the tarball addonctl installs
```

## Install

Copy the tarball to the unit and run the firmware's installer:

```
tools/pack.sh receiver-core
tools/pack.sh airplay
scp dist/htp1-addon-*.tar.gz root@HTP-1.local:/tmp/
ssh root@HTP-1.local addonctl install /tmp/htp1-addon-receiver-core-0.1.0.tar.gz
ssh root@HTP-1.local addonctl install /tmp/htp1-addon-airplay-0.1.0.tar.gz
```

The addon's input and Services switch appear on the next MSO fixup.
`addonctl remove <id>` reverses it.

## Build

Each receiver's `build/` directory holds the Docker recipe that produced the
binary in `bin/`. The images are Debian 9 (glibc 2.24, armhf), matching the
unit, so the results link against what is already there.

```
docker build --platform linux/arm/v7 -t sps-build addons/airplay/build
docker build --platform linux/amd64  -t librespot-build addons/spotify/build
```

`gmediarender` and its GStreamer plugins are stock Debian 9 packages, carried
as exact `.deb` files because the unit's apt sources are gone and updates
cannot assume a network.

## Tests

The session arbiter runs against real processes in a container:

```
addons/receiver-core/tests/run.sh
```

## Licensing

This repository is Apache-2.0. The binaries and packages it carries keep
their own licenses, listed in [NOTICE](NOTICE), with the build recipes that
produced them.
