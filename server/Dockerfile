# syntax=docker/dockerfile:1
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY server/package.json server/tsconfig.json ./server/
RUN npm ci --workspace server --include-workspace-root
COPY server/ ./server/
RUN npm --workspace server run build

FROM gcr.io/distroless/nodejs20-debian12
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/src/db/migrations ./server/dist/db/migrations
ENV NODE_ENV=production
USER nonroot
EXPOSE 8443
CMD ["server/dist/index.js"]
