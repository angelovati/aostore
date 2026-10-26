# microsocks is not in Alpine's stable repositories (only edge/testing), so it
# is built from the upstream tag with a pinned checksum.
FROM alpine:3.24@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a AS build
ARG MICROSOCKS_VERSION=1.0.5
ARG MICROSOCKS_SHA256=939d1851a18a4c03f3cc5c92ff7a50eaf045da7814764b4cb9e26921db15abc8
RUN apk add --no-cache build-base \
 && wget -O /tmp/microsocks.tar.gz "https://github.com/rofl0r/microsocks/archive/refs/tags/v${MICROSOCKS_VERSION}.tar.gz" \
 && echo "${MICROSOCKS_SHA256}  /tmp/microsocks.tar.gz" | sha256sum -c - \
 && tar -xzf /tmp/microsocks.tar.gz -C /tmp \
 && make -C "/tmp/microsocks-${MICROSOCKS_VERSION}" CFLAGS="-O2 -Wall -std=c99" LDFLAGS="-s" \
 && install -D -m 755 "/tmp/microsocks-${MICROSOCKS_VERSION}/microsocks" /out/microsocks

FROM alpine:3.24@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a
LABEL org.opencontainers.image.source="https://github.com/angelovati/aostore"
COPY --from=build /out/microsocks /usr/bin/microsocks
USER nobody
EXPOSE 1080
ENTRYPOINT ["/usr/bin/microsocks", "-p", "1080"]
