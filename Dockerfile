FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/client/package.json apps/client/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci
COPY tsconfig.json ./
COPY packages/shared packages/shared
COPY apps apps
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    cups cups-filters printer-driver-brlaser sane-utils sane-airscan \
    avahi-daemon avahi-utils dbus util-linux tini ca-certificates procps \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/apps/server ./apps/server
COPY --from=build /app/apps/client/dist ./apps/client/dist
COPY --from=build /app/packages/shared ./packages/shared
COPY scripts ./scripts
COPY docker/cupsd.conf /etc/cups/cupsd.conf
COPY docker/entrypoint.sh /usr/local/bin/openwebprint-entrypoint
RUN chmod +x /usr/local/bin/openwebprint-entrypoint && mkdir -p /data && chown node:node /data
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3001 DATA_DIR=/data APP_ORIGIN=http://localhost:3001 MODE=demo
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3001/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/openwebprint-entrypoint"]
