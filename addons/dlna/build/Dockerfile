# Cross-build gmediarender for the HTP-1 (armhf, Debian 9) from Debian's own
# source package with one patch, htp1-start-command-and-release.patch:
#
#   --gstout-start-command runs a command, and waits for it, before playback
#     opens the audio device, so the unit can select DLNA and free the device.
#   End of stream releases the device the way a stop does; unpatched, the
#     renderer holds it until the next track, blocking every other source.
#
# Built on amd64 with the armhf cross toolchain, as spotify/build does, against
# stretch so it links against the unit's own libraries. The result replaces
# Debian's package in debs/, with a +htp1 version so it sorts above it.
#
#   docker build -t gmediarender-build addons/dlna/build
#   docker run --rm -v "$PWD/addons/dlna/debs":/out gmediarender-build

FROM --platform=linux/amd64 debian:stretch-slim

RUN printf '%s\n' \
      'deb http://archive.debian.org/debian stretch main' \
      'deb-src http://archive.debian.org/debian stretch main' \
      'deb http://archive.debian.org/debian-security stretch/updates main' \
      > /etc/apt/sources.list \
 && printf 'Acquire::Check-Valid-Until "false";\n' > /etc/apt/apt.conf.d/99no-check-valid-until

# The build dependencies, spelled out: libupnp-dev is a virtual package on
# stretch, which a cross build-dep cannot resolve, so dpkg-buildpackage runs
# with -d.
RUN dpkg --add-architecture armhf \
 && apt-get update && apt-get install -y --no-install-recommends \
      build-essential crossbuild-essential-armhf dpkg-dev fakeroot quilt \
      autoconf automake debhelper dh-autoreconf libtool pkg-config \
      libgstreamer1.0-dev:armhf libupnp6-dev:armhf \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /src
RUN apt-get update && apt-get source gmrender-resurrect=0.0.7~git20160329+repack-1 \
 && rm -rf /var/lib/apt/lists/*

COPY htp1-start-command-and-release.patch /src/
RUN cd gmrender-resurrect-*/ \
 && mkdir -p debian/patches \
 && cp /src/htp1-start-command-and-release.patch debian/patches/ \
 && echo htp1-start-command-and-release.patch >> debian/patches/series \
 && { printf '%s\n' \
        'gmrender-resurrect (0.0.7~git20160329+repack-1+htp1.1) stretch; urgency=medium' '' \
        '  * Run --gstout-start-command before playback opens the audio device.' \
        '  * Release the audio device at the end of the stream.' '' \
      && printf ' -- HTP-1 addons <addons@htp1.invalid>  %s\n\n' "$(date -R)" \
      && cat debian/changelog; } > debian/changelog.new \
 && mv debian/changelog.new debian/changelog \
 && DEB_BUILD_OPTIONS=nocheck dpkg-buildpackage -a armhf -d -us -uc -b

CMD cp /src/gmediarender_*_armhf.deb /out/
