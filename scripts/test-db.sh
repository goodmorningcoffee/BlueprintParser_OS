#!/usr/bin/env bash
# [refactor jun12 P0.3] Local test database for the route characterization suite.
#
# Runs a USER-OWNED postgres cluster on :5433 (no sudo, no docker), serving the
# vitest default test URL:
#   postgres://bp_test:bp_test@localhost:5433/bp_test
# CI does NOT use this: the `checks` job runs a postgres:17 service on :5432 (ci:ci)
# and sets BP_TEST_DATABASE_URL; the `golden-e2e` job uses postgres:17 on :5433 (bp_test).
# Port 5433 is also the docker-compose dev database — run one or the other, or point
# BP_TEST_DATABASE_URL at a different port.
# PostgreSQL binaries: the Debian/Ubuntu layout (/usr/lib/postgresql/<v>/bin) is found
# automatically; elsewhere set BP_PG_BIN to the directory holding initdb and pg_ctl.
#
# Usage: scripts/test-db.sh start|stop|status
set -euo pipefail

PGBIN="${BP_PG_BIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
DATA_DIR="${BP_TEST_PG_DIR:-$HOME/.bp_test_pg}"
PORT=5433
LOG="$DATA_DIR/log"

case "${1:-start}" in
  start)
    if [ ! -d "$DATA_DIR/base" ]; then
      echo "[test-db] initdb → $DATA_DIR"
      "$PGBIN/initdb" -D "$DATA_DIR" -A trust -U postgres >/dev/null
    fi
    if ! "$PGBIN/pg_ctl" -D "$DATA_DIR" status >/dev/null 2>&1; then
      # unix_socket_directories=/tmp: the default /var/run/postgresql is
      # postgres-user-owned; this cluster runs as the devcontainer user.
      "$PGBIN/pg_ctl" -D "$DATA_DIR" -l "$LOG" -o "-p $PORT -c listen_addresses=localhost -c unix_socket_directories=/tmp" start
    else
      echo "[test-db] already running"
    fi
    # role + db are idempotent
    "$PGBIN/psql" -h localhost -p $PORT -U postgres -d postgres -tAc \
      "SELECT 1 FROM pg_roles WHERE rolname='bp_test'" | grep -q 1 || \
      "$PGBIN/psql" -h localhost -p $PORT -U postgres -d postgres -c \
      "CREATE ROLE bp_test LOGIN PASSWORD 'bp_test' CREATEDB" >/dev/null
    "$PGBIN/psql" -h localhost -p $PORT -U postgres -d postgres -tAc \
      "SELECT 1 FROM pg_database WHERE datname='bp_test'" | grep -q 1 || \
      "$PGBIN/createdb" -h localhost -p $PORT -U postgres -O bp_test bp_test
    echo "[test-db] ready: postgres://bp_test:bp_test@localhost:$PORT/bp_test"
    ;;
  stop)   "$PGBIN/pg_ctl" -D "$DATA_DIR" stop ;;
  status) "$PGBIN/pg_ctl" -D "$DATA_DIR" status ;;
  *) echo "usage: $0 start|stop|status" >&2; exit 1 ;;
esac
