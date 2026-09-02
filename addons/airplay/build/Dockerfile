# Build shairport-sync with AirPlay 2 for the HTP-1 (armv7l, Debian 9).
#
# Same base as the AirPlay 1 image -- Debian stretch / glibc 2.24 / armhf,
# matching the unit -- but AirPlay 2 needs more than stretch can supply:
#
# mDNS is Avahi, not tinysvcmdns. shairport-sync's own CONFIGURATION FLAGS.md
# says "--with-avahi is mandatory" for AirPlay 2; built --with-tinysvcmdns it
# configures and runs but advertises only _raop._tcp, never _airplay._tcp, so
# senders never see an AirPlay 2 device. The unit runs avahi-daemon for this
# (avahi-daemon + libavahi-core7, the only two packages added to the rootfs).
#
#   libplist  stretch has 1.12; configure.ac demands >= 2.0.0 (>= 2.3.0 to set
#             HAVE_LIBPLIST_GE_2_3_0). Built from source below.
#   plistutil ships with libplist, so it arrives with that build.
#   xxd       in vim-common on stretch.
#
# Everything else configure.ac asks for -- libsodium, libgcrypt, uuid, and the
# ffmpeg trio -- is in stretch and is taken from apt. There is no version floor
# on libav*, so ffmpeg 3.2 satisfies configure; whether shairport-sync's source
# only uses APIs that old is the open question this build answers.

FROM --platform=linux/arm/v7 arm32v7/debian:stretch-slim

RUN printf '%s\n' \
      'deb http://archive.debian.org/debian stretch main' \
      'deb http://archive.debian.org/debian-security stretch/updates main' \
      > /etc/apt/sources.list \
 && printf 'Acquire::Check-Valid-Until "false";\n' > /etc/apt/apt.conf.d/99no-check-valid-until

RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential autoconf automake libtool libtool-bin pkg-config git \
      ca-certificates vim-common \
      libasound2-dev libpopt-dev libconfig-dev libssl-dev \
      libsodium-dev libgcrypt20-dev uuid-dev \
      libavcodec-dev libavutil-dev libavformat-dev libavahi-client-dev \
 && rm -rf /var/lib/apt/lists/*

# --- libplist, new enough for AirPlay 2 -------------------------------------
# Installed into /usr/local so pkg-config finds it ahead of stretch's 1.12.
# --without-cython: the Python bindings are irrelevant here and drag in more.
ARG LIBPLIST_VERSION=2.3.0
RUN git clone --depth 1 --branch ${LIBPLIST_VERSION} \
      https://github.com/libimobiledevice/libplist.git /src/libplist \
 && cd /src/libplist \
 && ./autogen.sh --prefix=/usr/local --without-cython \
 && make -j"$(nproc)" && make install && ldconfig

ENV PKG_CONFIG_PATH=/usr/local/lib/pkgconfig

# --- shairport-sync ---------------------------------------------------------
ARG SPS_VERSION=4.3.7
RUN git clone --depth 1 --branch ${SPS_VERSION} \
      https://github.com/mikebrady/shairport-sync.git /src/sps

WORKDIR /src/sps
RUN autoreconf -fi \
 && ./configure --with-alsa --with-avahi --with-ssl=openssl \
                --with-airplay-2 --with-pipe \
 && make -j"$(nproc)"

# --- nqptp ------------------------------------------------------------------
# AirPlay 2 needs this alongside shairport-sync; it binds UDP 319/320 and
# disciplines the PTP clock the sender and receiver share.
RUN git clone --depth 1 https://github.com/mikebrady/nqptp.git /src/nqptp \
 && cd /src/nqptp \
 && autoreconf -fi && ./configure && make -j"$(nproc)"

CMD ["bash"]
