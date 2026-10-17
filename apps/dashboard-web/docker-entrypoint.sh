#!/bin/sh
# Loads the configuration the bootstrap container generated, then starts the standalone Next.js server. The file
# is sourced, so its values win over variables of the same name already in the environment.
set -eu
CONFIG_FILE=/config/dashboard-web.env
if [ -f "$CONFIG_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$CONFIG_FILE"
  set +a
else
  echo "warning: $CONFIG_FILE not found; OIDC_* must come from the environment" >&2
fi
exec node apps/dashboard-web/server.js
