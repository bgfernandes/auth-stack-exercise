# syntax=docker/dockerfile:1
# Build context is the repository root (the workspace is needed to install). Pins match mise.toml.
FROM node:22.23.3-alpine AS build
RUN npm install -g pnpm@10.34.6
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages
COPY apps/dashboard-web ./apps/dashboard-web
RUN pnpm install --frozen-lockfile --filter dashboard-web...
RUN pnpm --filter dashboard-web build

FROM node:22.23.3-alpine AS runner
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
WORKDIR /app
# The standalone output is laid out from the monorepo root: apps/dashboard-web/server.js plus traced node_modules.
COPY --from=build /repo/apps/dashboard-web/.next/standalone ./
COPY --from=build /repo/apps/dashboard-web/.next/static ./apps/dashboard-web/.next/static
COPY apps/dashboard-web/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
USER node
EXPOSE 3000
ENTRYPOINT ["docker-entrypoint.sh"]
