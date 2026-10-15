#!/bin/sh
set -eu
APP_PASSWORD="$(cat /tmp/postgres-app-password)"
export APP_PASSWORD
psql --username postgres --dbname neurochess --set ON_ERROR_STOP=1 <<'SQL'
\getenv app_password APP_PASSWORD
SELECT format('CREATE ROLE neurochess LOGIN PASSWORD %L', :'app_password') \gexec
ALTER DATABASE neurochess OWNER TO neurochess;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT ALL ON SCHEMA public TO neurochess;
SQL
unset APP_PASSWORD
