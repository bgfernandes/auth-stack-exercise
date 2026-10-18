#!/bin/sh
# Loads the configuration the bootstrap container generated (the OIDC application, APP_URL, TENANCY_API_URL), then
# starts the standalone Next.js server. The file is sourced, so its values win over variables of the same name
# already in the environment; SESSION_SECRET and REDIS_URL come from the compose service's environment.
set -eu
CONFIG_FILE=/config/dashboard-web.env
if [ -f "$CONFIG_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$CONFIG_FILE"
  set +a
else
  echo "warning: $CONFIG_FILE not found; OIDC_*, APP_URL, and TENANCY_API_URL must come from the environment" >&2
fi
exec node apps/dashboard-web/server.js
