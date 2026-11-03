# Backend services: makers, hedger, API, keeper, reporter.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data DEPLOYMENTS_DIR=/app/deployments LOG_FORMAT=json

COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY contracts/package.json contracts/package.json
COPY web/package.json web/package.json
RUN npm ci --omit=dev -w @weekend-options/backend --include-workspace-root=false && npm cache clean --force

COPY backend/src backend/src
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=3s --start-period=60s CMD ["node", "-e", "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# deployments/ is mounted at runtime so a redeploy never needs a rebuild
STOPSIGNAL SIGTERM
CMD ["node", "backend/src/index.js"]
