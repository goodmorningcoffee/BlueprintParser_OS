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
# Next's standalone server listens on $HOSTNAME. The Dockerfile sets it to 0.0.0.0, but the ECS
# Fargate runtime overwrites HOSTNAME with the task's own name (ip-10-…ec2.internal), so the server
# bound only to the task's network address: the ALB health check (task IP) passed while the
# container health check (curl localhost) failed, and ECS replaced every task about 4.5 minutes
# after it started (measured 2026-10-04: 337 failed tasks since the first deploy). Bind every
# interface here, after the runtime has had its say.
export HOSTNAME=0.0.0.0
exec node server.js
