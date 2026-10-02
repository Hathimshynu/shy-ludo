# syntax=docker/dockerfile:1.7
# Production image for the Ludo Nova API. Build from the repository root:
#   docker build -f apps/server/Dockerfile -t ludo-server .

FROM node:24-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# ---- Dependencies (cached on package manifests only) ---------------------------
FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/config/package.json packages/config/
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/game-engine/package.json packages/game-engine/
COPY packages/validation/package.json packages/validation/
RUN npm ci --ignore-scripts

# ---- Build -----------------------------------------------------------------------
FROM deps AS build
COPY tsconfig.base.json ./
COPY prisma ./prisma
COPY packages ./packages
COPY apps/server ./apps/server
RUN npx prisma generate --schema prisma/schema.prisma \
  && npm run build -w @ludo/server

# ---- Runtime (production dependencies only) -------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/config/package.json packages/config/
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/game-engine/package.json packages/game-engine/
COPY packages/validation/package.json packages/validation/
COPY prisma ./prisma
RUN npm ci --omit=dev --ignore-scripts -w @ludo/server \
  && npx prisma generate --schema prisma/schema.prisma \
  && npm cache clean --force
COPY --from=build /app/apps/server/dist ./apps/server/dist

USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Apply pending migrations, then start. Migrations are idempotent.
CMD ["sh", "-c", "npx prisma migrate deploy --schema prisma/schema.prisma && node apps/server/dist/index.js"]
