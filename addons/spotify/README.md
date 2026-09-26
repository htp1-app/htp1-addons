# spotify

Makes the HTP-1 appear in the Spotify app's device picker. Audio lands on
`default:I2S` — the sink Roon, USB gadget audio, Bluetooth and AirPlay all
share — so it reaches the APM DSP and gets Dirac, bass management and the
processor's volume like any other input.

**Needs nothing on the rootfs.** The binary depends only on `libasound` and libc
essentials, all already present. Unlike AirPlay 2 (which required
`avahi-daemon` + `libavahi-core7`), this costs zero packages: librespot does its
own zeroconf and advertises `_spotify-connect._tcp` itself.

## What ships

| | |
|---|---|
| `bin/librespot` | 6 MB stripped, librespot 0.4.2, ALSA backend only |
| `bin/spotify-event.sh` | `--onevent` hook: selects Spotify before each device open, and passes the app's volume to the unit |
| `units/spotify.service` | systemd unit |
| `build/Dockerfile` | reproduces the binary |

The credentials cache lives in `state/`, which survives an upgrade of the
addon.

## Build

    docker build --platform linux/amd64 -t librespot-build build

This one **cross-compiles on amd64** rather than building under qemu like
shairport does — compiling Rust under armv7 emulation takes the better part of
an hour. The base is still Debian stretch so the binary links against glibc
2.24, the version the unit has; building on a newer Debian would produce
something the unit cannot load. `armhf` is added as a foreign architecture to
supply the target's ALSA headers for `alsa-sys`.

Only the ALSA backend is built (`--no-default-features --features
alsa-backend`); the defaults pull in backends the unit has no use for.

Extract with `docker run --rm -v "$PWD":/out librespot-build \
  cp /src/target/armv7-unknown-linux-gnueabihf/release/librespot /out/`, and
**check the result is a real ELF** — a build that ran while the Docker VM's disk
was full once produced a 10 MB file of nulls that cargo still reported as
"Finished".

## Notable options

`--device-type avr` makes the Spotify picker show a receiver icon rather than a
generic speaker. Worth contrasting with AirPlay, where the equivalent (the
`model` TXT record) is hardcoded in shairport and where a *correct* icon needs
MFi certification: here it is simply ours to set.

`--volume-ctrl log --volume-range 1` keeps librespot's own attenuation to at
most 1 dB while still reporting the app's slider, so the stream reaches the
DSP essentially untouched and the HTP-1's own volume does the work.
`spotify-event.sh` passes the slider to the unit as a fraction, and the unit
moves its own volume by each change, as for AirPlay; starting playback does
not change the level. The reasoning for each option is in
`units/spotify.service`.

## Input wiring

The manifest registers `spotify` as an input that routes to `i2s`. The
service runs continuously so the unit stays in the Spotify picker.
`--emit-sink-events` makes librespot run the event hook, and wait for it, just
before it opens the device; the hook calls `addon-source start spotify`, so
the unit selects Spotify, waking first if it has to, and the device is free
when librespot opens it. Selecting another input, or standby, restarts the
service with SIGINT, the one signal on which librespot tells Spotify it is
leaving; the app stops playback. The front panel and web UI name the input
"Spotify" from its label.

## Verified

2026-08-31 on the bench unit:

- runs with no unresolved libraries, reports `librespot 0.4.2`
- advertises `_spotify-connect._tcp` (`CPath=/`, `VERSION=1.0`) and is
  discoverable from another host on the LAN
- selecting the input moves the DSP to `Audio input: I2S` at 44100 and leaves
  HSR video routing untouched
- playback from the Spotify app, wake-on-play and the volume mapping, on the
  bench through the streaming branch these files came from
