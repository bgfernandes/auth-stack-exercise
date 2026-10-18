#!/bin/sh
# Loads the configuration the bootstrap container generated for the APIs (issuer, project ID, JWKS URL), then
# starts the bundled server. The file is sourced, so its values win over variables of the same name already in
# the environment.
set -eu
CONFIG_FILE=/config/apis.env
if [ -f "$CONFIG_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$CONFIG_FILE"
  set +a
else
  echo "warning: $CONFIG_FILE not found; OIDC_* must come from the environment" >&2
fi
exec node /app/index.js
