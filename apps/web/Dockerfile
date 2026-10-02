# syntax=docker/dockerfile:1.7
# Static web app served by nginx, which also proxies /api and /socket.io to the API.
#   docker build -f apps/web/Dockerfile -t ludo-web .

FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/config/package.json packages/config/
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/game-engine/package.json packages/game-engine/
COPY packages/validation/package.json packages/validation/
RUN npm ci --ignore-scripts
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/web ./apps/web
# Public build-time configuration only — never secrets.
ARG VITE_API_URL=/api
ARG VITE_SOCKET_URL=
ARG VITE_SITE_URL=http://localhost:8080
ENV VITE_API_URL=$VITE_API_URL VITE_SOCKET_URL=$VITE_SOCKET_URL VITE_SITE_URL=$VITE_SITE_URL
RUN npm run build -w @ludo/web

FROM nginx:1.27-alpine AS runtime
COPY apps/web/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
ENV API_UPSTREAM=http://server:4000
EXPOSE 8080
