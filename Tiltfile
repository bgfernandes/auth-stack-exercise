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
for name in ['tls', 'zitadel-api', 'zitadel-login']:
    dc_resource(name, labels=['zitadel'])
dc_resource('proxy', labels=['zitadel'], links=['https://auth.localtest.me:8443'])

# The development CA the tls one-shot wrote (ticket 17b): every host-run process that calls Zitadel trusts it.
# Node reads the variable at start, so it is exported before the dev server, with an absolute path.
DEV_CA = os.path.abspath('.local/tls/ca.crt')

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
        'packages/client-scopes/src',
        'packages/db-core/src',
        'packages/tenancy/src',
        'packages/tenancy/migrations',
        'packages/documents/src',
        'packages/documents/migrations',
    ],
    resource_deps=['tls', 'proxy', 'spicedb', 'postgres'],
    labels=['apps'],
)


def stack_env():
    """The committed development defaults of .env, as a dict, for the processes that run on the host.

    Compose reads the file itself and passes each service the keys it needs; the host-run apps below get the
    same keys, with the hosts that differ outside the compose network replaced. Values are exported
    single-quoted, since some hold spaces.
    """
    values = {}
    for line in str(read_file('.env')).splitlines():
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            key, value = line.split('=', 1)
            values[key.strip()] = value.strip()
    return values


STACK_ENV = stack_env()


def host_app(name, url, port, env={}, config=None, path='/', deps=[]):
    """Runs an app on the host with its dev server, configured like its container.

    The serve command sources ./.local/config/<config>.env (the file bootstrap wrote for the app, <name>.env by
    default; apis.env for an API), the way the app's docker-entrypoint.sh does, then exports `env` (the keys the
    app's compose service gets, with host-side values) and NODE_EXTRA_CA_CERTS (the development CA, as the
    compose service gets it), which therefore win over the file's: the file names the compose-network hosts
    (DASHBOARD_API_URL, TENANCY_API_URL), and on the host they are replaced. The file is read when the process starts, after
    bootstrap, so a fresh clone needs no Tiltfile reload. `deps` names the other apps this one calls, the way
    its compose service's depends_on does.
    """
    exports = ''.join(
        ["export %s='%s'; " % (key, value) for key, value in dict(env, NODE_EXTRA_CA_CERTS=DEV_CA).items()]
    )
    local_resource(
        name,
        serve_cmd='set -a; . ./.local/config/%s.env; set +a; %sexec pnpm --filter %s dev' % (config or name, exports, name),
        resource_deps=['pnpm-install', 'bootstrap'] + deps,
        readiness_probe=probe(http_get=http_get_action(port, path=path), period_secs=5, timeout_secs=10),
        links=[url],
        labels=['apps'],
    )


# One hostname per app (docs/README.md §4.3); the port is the one the app's compose service publishes.
host_app(
    'dashboard-web',
    'http://dashboard.localtest.me:3000',
    3000,
    {
        'DASHBOARD_API_URL': 'http://localhost:4002',
        'TENANCY_API_URL': 'http://localhost:4001',
        'SESSION_SECRET': STACK_ENV['SESSION_SECRET'],
        'REDIS_URL': 'redis://localhost:6379',
    },
    # Every documents operation is a call to dashboard-api and the login callback calls both APIs (tickets 10
    # and 19); in compose, dashboard-web depends on them the same way.
    deps=['dashboard-api', 'tenancy-api'],
)
host_app(
    'tenancy-web',
    'http://tenancy.localtest.me:3001',
    3001,
    {
        'TENANCY_API_URL': 'http://localhost:4001',
        'SESSION_SECRET': STACK_ENV['SESSION_SECRET'],
        'REDIS_URL': 'redis://localhost:6379',
    },
    # Every page is a call to tenancy-api (ticket 17); in compose, tenancy-web depends on it the same way.
    deps=['tenancy-api'],
)
host_app(
    'tenancy-api',
    'http://localhost:4001/health',
    4001,
    {
        'TENANCY_DATABASE_URL': 'postgres://tenancy:tenancy@localhost:5432/tenancy',
        'SPICEDB_ENDPOINT': 'localhost:50051',
        'SPICEDB_PRESHARED_KEY': STACK_ENV['SPICEDB_PRESHARED_KEY'],
        'SPICEDB_INSECURE': STACK_ENV['SPICEDB_INSECURE'],
    },
    config='apis',
    path='/health',
)
host_app(
    'dashboard-api',
    'http://localhost:4002/health',
    4002,
    {
        'DOCUMENTS_DATABASE_URL': 'postgres://documents:documents@localhost:5432/documents',
        'SPICEDB_ENDPOINT': 'localhost:50051',
        'SPICEDB_PRESHARED_KEY': STACK_ENV['SPICEDB_PRESHARED_KEY'],
        'SPICEDB_INSECURE': STACK_ENV['SPICEDB_INSECURE'],
        'TENANCY_API_URL': 'http://localhost:4001',
    },
    config='apis',
    path='/health',
    # Organization names come from tenancy-api (§6.6); in compose, dashboard-api depends on it the same way.
    deps=['tenancy-api'],
)
