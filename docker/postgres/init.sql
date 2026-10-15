-- Runs once, when the postgres-data volume is empty (docker-entrypoint-initdb.d), as the admin role.
-- One database per service, each owned by a same-named role whose password is the role name: development
-- defaults, see .env. The `comments` database is added in phase 5.
CREATE ROLE zitadel LOGIN PASSWORD 'zitadel';
CREATE DATABASE zitadel OWNER zitadel;

CREATE ROLE spicedb LOGIN PASSWORD 'spicedb';
CREATE DATABASE spicedb OWNER spicedb;

CREATE ROLE tenancy LOGIN PASSWORD 'tenancy';
CREATE DATABASE tenancy OWNER tenancy;

CREATE ROLE documents LOGIN PASSWORD 'documents';
CREATE DATABASE documents OWNER documents;
