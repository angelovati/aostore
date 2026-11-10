FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000 MCP_PORT=3001 DATA_DIR=/data TZ=America/Argentina/Buenos_Aires
RUN apk add --no-cache tzdata
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js ./
COPY lib ./lib
COPY public ./public
COPY channel ./channel
USER node
EXPOSE 3000 3001
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
