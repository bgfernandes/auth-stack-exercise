# syntax=docker/dockerfile:1.7-labs
# Build context is the repository root (the workspace packages are compiled from source). Pins match mise.toml.
FROM node:22.23.3-alpine AS build
RUN npm install -g pnpm@10.34.6
WORKDIR /repo
# Manifests first, so the install layer depends on the lockfile and the package.json files only and survives
# every source edit; every workspace manifest is copied because --frozen-lockfile checks the lockfile against all
# of them, and the install itself fetches only tenancy-web's dependency closure (as in apps/tenancy-api/Dockerfile).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --parents apps/*/package.json packages/*/package.json ./
RUN pnpm install --frozen-lockfile --filter tenancy-web...
COPY packages ./packages
COPY apps/tenancy-web ./apps/tenancy-web
# Every page is rendered on demand (app/layout.tsx), so the build reads no configuration.
RUN pnpm --filter tenancy-web build

FROM node:22.23.3-alpine AS runner
ENV NODE_ENV=production
ENV PORT=3001
ENV HOSTNAME=0.0.0.0
WORKDIR /app
# The standalone output is laid out from the monorepo root: apps/tenancy-web/server.js plus traced node_modules.
COPY --from=build /repo/apps/tenancy-web/.next/standalone ./
COPY --from=build /repo/apps/tenancy-web/.next/static ./apps/tenancy-web/.next/static
COPY apps/tenancy-web/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
USER node
EXPOSE 3001
ENTRYPOINT ["docker-entrypoint.sh"]
