# Cross-build librespot (Spotify Connect) for the HTP-1 (armv7l, Debian 9).
#
# Unlike the shairport image this builds on amd64 and cross-compiles, because
# compiling Rust under qemu-armv7 emulation takes the better part of an hour.
# The base is still Debian stretch so the binary links against glibc 2.24 --
# the version the unit actually has. Building on a newer Debian would produce
# a binary the unit cannot load.
#
# Stretch is EOL, so apt points at archive.debian.org with Valid-Until off.

FROM --platform=linux/amd64 debian:stretch-slim

RUN printf '%s\n' \
      'deb http://archive.debian.org/debian stretch main' \
      'deb http://archive.debian.org/debian-security stretch/updates main' \
      > /etc/apt/sources.list \
 && printf 'Acquire::Check-Valid-Until "false";\n' > /etc/apt/apt.conf.d/99no-check-valid-until

# armhf as a foreign architecture gives us the target's ALSA headers and
# library, which alsa-sys needs to link against.
RUN dpkg --add-architecture armhf \
 && apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates build-essential pkg-config git \
      crossbuild-essential-armhf libasound2-dev:armhf \
 && rm -rf /var/lib/apt/lists/*

ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo PATH=/usr/local/cargo/bin:$PATH
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
      | sh -s -- -y --profile minimal --default-toolchain stable \
 && rustup target add armv7-unknown-linux-gnueabihf

# Point cargo at the cross linker, and let pkg-config look at armhf packages.
ENV CARGO_TARGET_ARMV7_UNKNOWN_LINUX_GNUEABIHF_LINKER=arm-linux-gnueabihf-gcc \
    PKG_CONFIG_ALLOW_CROSS=1 \
    PKG_CONFIG_PATH=/usr/lib/arm-linux-gnueabihf/pkgconfig \
    PKG_CONFIG_LIBDIR=/usr/lib/arm-linux-gnueabihf/pkgconfig

ARG LIBRESPOT_VERSION=v0.4.2
RUN git clone --depth 1 --branch ${LIBRESPOT_VERSION} \
      https://github.com/librespot-org/librespot.git /src

WORKDIR /src
# Only the ALSA backend. The defaults drag in extra backends and audio
# libraries the unit has no use for, and every one is another thing to
# resolve at runtime.
RUN cargo build --release --target armv7-unknown-linux-gnueabihf \
      --no-default-features --features alsa-backend

CMD ["bash"]
