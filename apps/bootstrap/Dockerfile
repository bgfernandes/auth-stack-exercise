# syntax=docker/dockerfile:1.7-labs
# Build context is the repository root (workspace packages are bundled from source). Pins match mise.toml.
FROM node:22.23.3-alpine AS build
RUN npm install -g pnpm@10.34.6
WORKDIR /repo
# Manifests first, so the install layer depends on the lockfile and the package.json files only and survives
# every source edit (Tilt rebuilds the image on each). Every workspace manifest is copied (--parents keeps the
# paths; the labs syntax above provides it) because --frozen-lockfile checks the lockfile against all of them;
# the install itself fetches only bootstrap's dependency closure.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --parents apps/*/package.json packages/*/package.json ./
RUN pnpm install --frozen-lockfile --filter bootstrap...
COPY packages ./packages
COPY apps/bootstrap ./apps/bootstrap
RUN pnpm --filter bootstrap build

FROM node:22.23.3-alpine
ENV NODE_ENV=production
WORKDIR /app
# The whole program is one bundled file (docs/README.md §12, bootstrap build); no node_modules in the image.
COPY --from=build /repo/apps/bootstrap/dist/index.js ./index.js
# Runs as root by compose configuration (user: '0'), so it can write the bind-mounted /config on Linux hosts.
CMD ["node", "index.js"]
