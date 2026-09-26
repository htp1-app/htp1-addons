# htp1-addons

Installable packages for the HTP-1 that live outside the firmware tree. An
addon is installed and removed from the web UI, survives firmware updates,
and leaves the unit stock when removed. The format, the catalog, and what the
firmware does with them are in [docs/format.md](docs/format.md).

| Addon | What it is | Needs |
|---|---|---|
| [`airplay`](addons/airplay) | AirPlay 2 receiver: shairport-sync 4.3.7 with nqptp and avahi-daemon | `source/1` |
| [`spotify`](addons/spotify) | Spotify Connect receiver: librespot 0.4.2 | `source/1` |
| [`dlna`](addons/dlna) | UPnP/DLNA renderer: gmediarender, patched to report playback starts | `source/1` |
| [`volume-calibration`](addons/volume-calibration) | The Volume Calibration wizard, as a page opened from the Addons page | |

The three receivers play into `default:I2S`, the sink Roon, USB audio and
Bluetooth already use, so their audio gets Dirac, bass management and the
processor's volume like any other input. They run continuously so senders can
see them and hold the device only while playing. Starting playback on one
takes the unit over: it wakes if it has to, selects that input, and the
receiver that was playing is restarted, which ends its sender's session.
Each is a thin adapter onto the firmware's audio source interface
(`source/1`, see [docs/format.md](docs/format.md)).

## Install

On the HTP-1 web UI, open Settings, then Addons, and add this repository's
address, `https://github.com/htp1-app/htp1-addons`. The unit ships with no
repositories; those added are kept. Each repository is listed with what it
offers, with Install, Update and Remove per addon, a switch for anything that
runs as a service, and its own Refresh. The unit downloads the package from the
release listed in [index.json](index.json), checks its SHA-256, and installs
it, with any addons it depends on first. The repository
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

## Work in progress

An addon with `"published": false` in its manifest stays in the repository
but out of the catalog, so it can be developed on main without appearing on
anyone's Addons page. Pack it by hand with `tools/pack.sh <id>` to try it on
a unit.

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
docker build --platform linux/amd64  -t gmediarender-build addons/dlna/build
```

The GStreamer plugins DLNA needs are stock Debian 9 packages, carried as
exact `.deb` files because the unit's apt sources are gone and updates cannot
assume a network. `gmediarender` is Debian's own package rebuilt with one
patch by `addons/dlna/build/`, and replaces it in `debs/`.

## Tests

The firmware side of the receivers (selection, wake, volume, release) is
tested in the firmware repository with `tests/addons/run.sh`.

## Licensing

This repository is Apache-2.0. The binaries and packages it carries keep
their own licenses, listed in [NOTICE](NOTICE), with the build recipes that
produced them.
