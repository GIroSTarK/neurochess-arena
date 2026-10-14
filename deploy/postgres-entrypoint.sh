#!/bin/sh
set -eu
install -m 600 -o postgres -g postgres /run/secrets/postgres-key /tmp/postgres-key.pem
install -m 644 -o postgres -g postgres /run/secrets/postgres-cert /tmp/postgres-cert.pem
exec docker-entrypoint.sh postgres \
  -c ssl=on \
  -c ssl_cert_file=/tmp/postgres-cert.pem \
  -c ssl_key_file=/tmp/postgres-key.pem \
  -c hba_file=/etc/postgresql/pg_hba.conf \
  -c log_statement=none \
  -c log_error_verbosity=terse \
  -c log_min_error_statement=panic
