# dlna

UPnP/DLNA renderer, so BubbleUPnP, Hi-Fi Cast, VLC and Windows "Cast to
device" can push audio to the HTP-1. This is the Android answer: Google Cast
cannot be implemented, because a Cast receiver must present a certificate
chain signed by Google's Cast CA.

| | |
|---|---|
| `debs/` | `gmediarender` 0.0.7, rebuilt with two patches, and the GStreamer 1.10 plugins and libraries it needs, exact Debian 9 packages, installed offline |
| `units/upnp.service` | The renderer, on `default:I2S` |
| `build/` | The patches and the cross-build that produces the `gmediarender` package |

The renderer advertises under the unit name with a UUID derived from the
serial number, so two units on one LAN do not collide. GStreamer's volume is
held at 0 dB; the processor's own volume does the work.

gmediarender has no hook of its own, and unpatched it holds the I2S device
from the end of a track until the next one plays, which blocks every other
source. The patch (`build/htp1-start-command-and-release.patch`, against
Debian's `0.0.7~git20160329+repack-1`) adds `--gstout-start-command`, run and
waited for just before playback opens the device, and releases the device at
the end of the stream the way a stop does. The unit passes
`addon-source start dlna`, so a control point's Play selects DLNA, waking the
unit first if it has to, and the device is free when the renderer opens it.
Selecting another input, or standby, restarts the renderer; it comes back on
another UPnP port, and control points find it again over SSDP.

Unpatched, a new track sent with SetAVTransportURI while one plays only
changed what the renderer reported: the old track played on to its end, and
after a pause, Play resumed the old track. The second patch
(`build/htp1-new-uri-replaces-track.patch`) starts the new track at once,
reopening the device at its own sample rate, and stops a paused track so Play
starts the new one.

Build with `docker build -t gmediarender-build build` and
`docker run --rm -v "$PWD/debs":/out gmediarender-build`; the result is
`gmediarender_0.0.7~git20160329+repack-1+htp1.2_armhf.deb`.

`-I <address>` is resolved at start from `eth0`, falling back to
`hostname -I`; gmediarender does not accept `0.0.0.0`.
