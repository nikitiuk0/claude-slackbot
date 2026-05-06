# syntax=docker/dockerfile:1
FROM node:24-trixie-slim AS build
WORKDIR /app
# better-sqlite3 ships prebuilds for linux-x64 / linux-arm64 (glibc), but fall
# back to a source build if the prebuild is missing for the host arch.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json tsconfig.base.json ./
COPY server/package.json server/tsconfig.json ./server/
RUN npm ci --workspace server --include-workspace-root
COPY server/ ./server/
RUN npm --workspace server run build

FROM gcr.io/distroless/nodejs24-debian12
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/src/db/migrations ./server/dist/db/migrations
ENV NODE_ENV=production
USER nonroot
EXPOSE 8443
CMD ["server/dist/index.js"]
