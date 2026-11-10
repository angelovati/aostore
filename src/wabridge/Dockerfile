# Dependencies are installed on the build machine's own platform for the
# target one: running node under QEMU (arm64 on GitHub's amd64 runners)
# crashes with "Illegal instruction". Only prebuilt binaries are involved
# (sharp, the optional image library), so nothing has to run on the target.
FROM --platform=$BUILDPLATFORM node:22-alpine AS deps
ARG TARGETARCH
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --os=linux --libc=musl --cpu="$([ "$TARGETARCH" = arm64 ] && echo arm64 || echo x64)" \
  && npm cache clean --force

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000 MCP_PORT=3001 DATA_DIR=/data TZ=America/Argentina/Buenos_Aires
RUN apk add --no-cache tzdata
COPY --from=deps /app/node_modules ./node_modules
COPY package.json server.js ./
COPY lib ./lib
COPY public ./public
COPY channel ./channel
USER node
EXPOSE 3000 3001
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
