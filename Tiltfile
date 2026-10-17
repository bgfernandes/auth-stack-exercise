# The developer loop (ticket 5): the infrastructure runs in compose, the apps run on the host as local resources
# with hot reload, and bootstrap runs as an explicit step in between. `tilt up` is the one command; `tilt down`
# stops the containers and the host processes and keeps the volumes. Run Tilt through mise (`mise exec -- tilt up`,
# or a shell with mise activated) so tilt, node, and pnpm are the pinned versions. The other way to run the
# project, everything in compose, is `docker compose --profile apps up -d --wait --build` (root README).

# Tilt ignores the compose file's `name:` and derives the project from the directory unless told otherwise. It
# starts every service on its own (`up --no-deps`) in depends_on order, but considers a service started as soon as
# its container runs, not when it is healthy: the long-running services carry restart policies and the one-shots
# retry (spicedb-migrate) or wait (bootstrap, below), so the order settles itself. `profiles=[]` keeps a
# COMPOSE_PROFILES in the shell from starting the containerized apps, which would take the apps' ports.
docker_compose('./docker-compose.yml', project_name='auth-stack', profiles=[])

for name in ['postgres', 'redis', 'spicedb-migrate', 'spicedb']:
    dc_resource(name, labels=['infra'])
dc_resource('mailpit', labels=['infra'], links=['http://localhost:8025'])
for name in ['zitadel-api', 'zitadel-login']:
    dc_resource(name, labels=['zitadel'])
dc_resource('proxy', labels=['zitadel'], links=['http://auth.localtest.me:8080'])

# The workspace install, re-run when a pulled commit changed the dependencies: CI enforces a frozen lockfile, so
# every dependency change that reaches main changes pnpm-lock.yaml. The host-run apps depend on it; bootstrap
# runs in Docker and does not.
local_resource(
    'pnpm-install',
    cmd='pnpm install',
    deps=['pnpm-lock.yaml', 'pnpm-workspace.yaml'],
    labels=['apps'],
)

# Bootstrap (ticket 4) is in the apps profile, so Tilt does not run it as a compose service. As a one-off
# `compose run` it waits for Zitadel and SpiceDB through the service's depends_on, blocks until done, and fails
# the resource on a non-zero exit, which is what the apps below depend on. It re-runs when its sources or the
# workspace packages it bundles change; it is idempotent.
local_resource(
    'bootstrap',
    cmd='docker compose run --rm --build bootstrap',
    deps=[
        'apps/bootstrap/src',
        'apps/bootstrap/Dockerfile',
        'apps/bootstrap/build.mjs',
        'apps/bootstrap/package.json',
        'packages/authz/schema.zed',
        'packages/authz/src',
    ],
    resource_deps=['proxy', 'spicedb'],
    labels=['apps'],
)


def host_app(name, url, port, env_overrides={}):
    """Runs an app on the host with its dev server, configured like its container.

    The serve command sources ./.local/config/<name>.env, the file bootstrap wrote, the way the app's
    docker-entrypoint.sh does, then applies the overrides: values that differ because the process is on the host
    rather than in the compose network. The file is read when the process starts, after bootstrap, so a fresh clone
    needs no Tiltfile reload.
    """
    exports = ''.join(['export %s=%s; ' % (key, value) for key, value in env_overrides.items()])
    local_resource(
        name,
        serve_cmd='set -a; . ./.local/config/%s.env; set +a; %sexec pnpm --filter %s dev' % (name, exports, name),
        resource_deps=['pnpm-install', 'bootstrap'],
        readiness_probe=probe(http_get=http_get_action(port, path='/'), period_secs=5, timeout_secs=10),
        links=[url],
        labels=['apps'],
    )


# One hostname per app (docs/README.md §4.3); the port is the one the app's compose service publishes.
host_app('dashboard-web', 'http://dashboard.localtest.me:3000', 3000, {'TENANCY_API_URL': 'http://localhost:4001'})
