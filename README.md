# htp1-addons

Installable packages for the HTP-1 that live outside the firmware tree. An
addon is installed and removed from the web UI, survives firmware updates,
and leaves the unit stock when removed. The format, the catalog, and what the
firmware does with them are in [docs/format.md](docs/format.md).

| Addon | What it is | Needs |
|---|---|---|
| [`receiver-core`](addons/receiver-core) | Session arbiter, reap timer and shared volume mapping for the network receivers | |
| [`airplay`](addons/airplay) | AirPlay 2 receiver: shairport-sync 4.3.7 with nqptp and avahi-daemon | `receiver-core` |
| [`spotify`](addons/spotify) | Spotify Connect receiver: librespot 0.4.2 | `receiver-core` |
| [`dlna`](addons/dlna) | UPnP/DLNA renderer: gmediarender with a wake-on-play watcher | `receiver-core` |
| [`volume-calibration`](addons/volume-calibration) | The Volume Calibration wizard, as a page opened from the Addons page | |

The three receivers play into `default:I2S`, the sink Roon, USB audio and
Bluetooth already use, so their audio gets Dirac, bass management and the
processor's volume like any other input. They run continuously so senders can
see them, release the device when idle, and wake the processor and select
their input when a sender starts playing. One plays at a time.

## Install

On the HTP-1 web UI, open Settings, then Addons. The page lists what this
repository offers, with Install, Update and Remove for each, and a switch
for anything that runs as a service. The unit downloads the package from the
release listed in [index.json](index.json), checks its SHA-256, and installs
it; dependencies such as `receiver-core` are installed first. The repository
field on that page takes any GitHub repository URL with an `index.json` on
its main branch, or a direct URL to an index.

## Layout

```
addons/<id>/     one addon: addon.json, bin/, etc/, units/, debs/, hooks/,
                 build/ (Docker cross-build recipe), tests/; a page addon
                 has src/ and a package.json, and www/ is built at pack time
index.json       the catalog the unit reads: versions, download URLs, checksums
tools/pack.sh    builds one addon's tarball
tools/index.sh   packs every addon and regenerates index.json for a release tag
```

## Releasing

```
tools/index.sh v0.1.0
git commit -am "Release v0.1.0" && git push
```

Then create the GitHub release `v0.1.0` with the tarballs from `dist/` as its
assets. The URLs in `index.json` point at those assets, so the index must not
be pushed before the release exists, or a unit refreshing in between sees
downloads that 404.

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
