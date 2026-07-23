#!/bin/sh
set -eu

mode="${1:-app}"

case "${mode}" in
  schema-check)
    exec node scripts/assert-schema-current.mjs
    ;;
  schema-readiness)
    shift
    exec node scripts/assert-schema-migration-ready.mjs "${1:-}"
    ;;
  migrate)
    exec node scripts/run-schema-migrations.mjs
    ;;
  janitor)
    # [refactor jul23 P5.4-E] Advisory-locked TTL sweep of the PG-backed runtime
    # state tables (runtime_counters / login_lockouts / auto-bans / op_log).
    # One-shot; run on a schedule. Concurrent janitors self-deconflict via a
    # non-blocking advisory lock, so an N-task cluster never stampedes.
    exec node scripts/run-state-janitor.mjs
    ;;
  worker)
    shift
    if [ "$#" -eq 0 ]; then
      echo "ERROR: worker mode requires a command" >&2
      exit 64
    fi
    node scripts/assert-schema-current.mjs
    exec "$@"
    ;;
  app)
    node scripts/assert-schema-current.mjs
    ;;
  *)
    echo "ERROR: unknown entrypoint mode: ${mode}" >&2
    exit 64
    ;;
esac

echo "Starting application..."
exec node server.js
