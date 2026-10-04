# WebStationX — build the UI and server, then ship a small runtime image.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production WSX_PORT=8090
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY tools/invite.mjs ./tools/invite.mjs
COPY LICENSE THIRD_PARTY_NOTICES.md ./
COPY licenses ./licenses
RUN mkdir -p /app/Games/psx /app/Games/ps2 /app/library /app/bios /app/data && chown -R node:node /app
# Games, BIOS and player data are volumes so upgrades never touch them.
VOLUME ["/app/Games", "/app/library", "/app/bios", "/app/data"]
USER node
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8090/api/health >/dev/null || exit 1
CMD ["node", "dist/server.js"]
