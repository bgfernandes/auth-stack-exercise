# syntax=docker/dockerfile:1.7-labs
# Build context is the repository root (workspace packages are bundled from source). Pins match mise.toml.
FROM node:22.23.3-alpine AS build
RUN npm install -g pnpm@10.34.6
WORKDIR /repo
# Manifests first, so the install layer depends on the lockfile and the package.json files only and survives
# every source edit; every workspace manifest is copied because --frozen-lockfile checks the lockfile against all
# of them, and the install itself fetches only dashboard-api's dependency closure (as in apps/bootstrap/Dockerfile).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --parents apps/*/package.json packages/*/package.json ./
RUN pnpm install --frozen-lockfile --filter dashboard-api...
COPY packages ./packages
COPY apps/dashboard-api ./apps/dashboard-api
RUN pnpm --filter dashboard-api build

FROM node:22.23.3-alpine
ENV NODE_ENV=production
ENV PORT=4002
WORKDIR /app
# The whole program is one bundled file (docs/README.md §12, bootstrap build); no node_modules in the image.
COPY --from=build /repo/apps/dashboard-api/dist/index.js ./index.js
COPY apps/dashboard-api/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
USER node
EXPOSE 4002
ENTRYPOINT ["docker-entrypoint.sh"]
