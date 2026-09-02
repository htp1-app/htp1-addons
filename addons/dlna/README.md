# dlna

UPnP/DLNA renderer, so BubbleUPnP, Hi-Fi Cast, VLC and Windows "Cast to
device" can push audio to the HTP-1. This is the Android answer: Google Cast
cannot be implemented, because a Cast receiver must present a certificate
chain signed by Google's Cast CA.

| | |
|---|---|
| `debs/` | `gmediarender` 0.0.7 and the GStreamer 1.10 plugins and libraries it needs, exact Debian 9 packages, installed offline |
| `units/upnp.service` | The renderer, on `default:I2S` |
| `units/upnp-watch.service` | Wake-on-play watcher, pulled up and down with the renderer |
| `bin/upnp-watch.sh` | Polls whether `gmediarender` holds a sound device and calls the arbiter on each edge |

The renderer advertises under the unit name with a UUID derived from the
serial number, so two units on one LAN do not collide. GStreamer's volume is
held at 0 dB; the processor's own volume does the work.

gmediarender has no session hook, unlike shairport-sync and librespot, so
playback is detected from outside: alsasink opens `default:I2S` when a track
starts and releases it when it stops, and `upnp-watch.sh` reads that from
`/proc/<pid>/fd` every two seconds. It calls `session-arbiter.sh begin upnp`
on the rising edge and `end upnp` on the falling one, which powers the unit
on and selects the input the same way the other receivers do.

`-I <address>` is resolved at start from `eth0`, falling back to
`hostname -I`; gmediarender does not accept `0.0.0.0`.
