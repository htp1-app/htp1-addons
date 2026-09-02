# receiver-core

What the network receivers share: the session arbiter, the timer that reaps
dead sessions, and the volume mapping their hooks source. AirPlay, Spotify
and DLNA require it.

| | |
|---|---|
| `bin/session-arbiter.sh` | `begin`, `end`, `renew`, `reap`, `owner`, `pending`. Called by each receiver's session hook. |
| `bin/volume-common.sh` | Sourced by the volume hooks: the active-receiver guard and the sender-range to MSO-volume mapping. |
| `units/session-reap.timer` | Runs `session-arbiter.sh reap` every 30 s. |

## The arbiter

Three receivers run continuously against one audio output. The arbiter makes
one of them the owner at a time:

- The first receiver to begin a session takes ownership, powers the unit on
  and selects its input after a short settle. A later arrival plays into the
  shared device if it can open it, but does not steal the input.
- A session holds a 90 s lease. Expiry is only a prompt to check: a receiver
  still holding `/dev/snd` is playing and is extended; one that is not is
  reaped. Neither shairport-sync nor librespot has a periodic hook, so this
  is what keeps a long stream alive and cleans up a crashed receiver.
- The CPU shield is reference-counted across sessions and dropped when none
  remain, including by reaping.
- When a session leaves, by `end` or by reaping, a surviving session is
  promoted and the input follows it only if the unit is still sitting on the
  receiver that left. A manual selection made since is kept.
- A re-`begin` from a receiver whose session is live refreshes the lease and
  nothing else, so a track change never re-selects the input.
- Between `begin` and the input switch landing, the receiver is published as
  `pending` so its volume hook is accepted during that window and refused
  afterwards unless it is the selected input.

State lives in `/dev/shm`, so it cannot survive a reboot half-written. It
talks to the unit through `POST /webapi` and `config.json` on localhost, and
raises the shield with `/opt/olympia/setup_shield.sh`. A receiver's process
name comes from `service.process` in the manifest of the addon whose
`input.code` matches, read from `/var/lib/olympia/addons/*/addon.json`.

## The volume guard and mapping

`receiver_is_active <receiver>` accepts a volume event only when that
receiver is the selected input, or the audio half of the selected virtual
input, or the owner whose switch is still pending. Without it a slider in a
merely connected app would change the level of whatever is playing on HDMI.

`map_fraction_to_volume <0..1> [span]` maps a sender's range onto a window
ending at `/cal/vph`, 60 dB wide by default and clamped at `/cal/vpl`, read
live so it fits whatever the owner configured. `set_volume_unmuted` applies
volume and unmute as one ordered patch through port 1799, volume first, so
unmuting cannot burst at the previous listener's level.

## Tests

```
tests/run.sh
```

Runs `session-arbiter.sh` and `volume-common.sh` for real in a Linux
container, against processes named like the receivers that hold a real
descriptor under `/dev/snd`. Only `setup_shield.sh` and `curl` are stubbed,
and both are logged so the shield count and every emitted patch can be
asserted.
