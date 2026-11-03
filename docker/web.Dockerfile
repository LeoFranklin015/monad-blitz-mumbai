# Web app: static build served by nginx, with /api proxied to the backend.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY contracts/package.json contracts/package.json
COPY web/package.json web/package.json
RUN npm ci -w @weekend-options/web --include-workspace-root=false
COPY web web
ARG VITE_NETWORK=monad
ARG VITE_API_URL=/api
ARG VITE_JAW_API_KEY=
ARG VITE_PAYMASTER_URL=
ENV VITE_NETWORK=$VITE_NETWORK VITE_API_URL=$VITE_API_URL VITE_JAW_API_KEY=$VITE_JAW_API_KEY VITE_PAYMASTER_URL=$VITE_PAYMASTER_URL
RUN npm run build -w @weekend-options/web

FROM nginx:1.27-alpine
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/web/dist /usr/share/nginx/html
# deployments/<network>.json and abi.json are mounted at /usr/share/nginx/html/deployments
EXPOSE 80
HEALTHCHECK --interval=15s --timeout=3s CMD wget -qO- http://127.0.0.1/healthz || exit 1
