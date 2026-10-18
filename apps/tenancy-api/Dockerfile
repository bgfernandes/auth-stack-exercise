# syntax=docker/dockerfile:1.7-labs
# Build context is the repository root (workspace packages are bundled from source). Pins match mise.toml.
FROM node:22.23.3-alpine AS build
RUN npm install -g pnpm@10.34.6
WORKDIR /repo
# Manifests first, so the install layer depends on the lockfile and the package.json files only and survives
# every source edit; every workspace manifest is copied because --frozen-lockfile checks the lockfile against all
# of them, and the install itself fetches only tenancy-api's dependency closure (as in apps/bootstrap/Dockerfile).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --parents apps/*/package.json packages/*/package.json ./
RUN pnpm install --frozen-lockfile --filter tenancy-api...
COPY packages ./packages
COPY apps/tenancy-api ./apps/tenancy-api
RUN pnpm --filter tenancy-api build

FROM node:22.23.3-alpine
ENV NODE_ENV=production
ENV PORT=4001
WORKDIR /app
# The whole program is one bundled file (docs/README.md §12, bootstrap build); no node_modules in the image.
COPY --from=build /repo/apps/tenancy-api/dist/index.js ./index.js
COPY apps/tenancy-api/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
USER node
EXPOSE 4001
ENTRYPOINT ["docker-entrypoint.sh"]
