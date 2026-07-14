// Retained only as a fail-closed pointer for old operator notes. Local
// development uses `npm run db:migrate`; production uses the singleton,
// quiescent task launched by scripts/p2-schema-cutover.sh.
console.error(
  "This migration entry point is disabled. Use npm run db:migrate for a loopback development database or scripts/p2-schema-cutover.sh for production.",
);
process.exitCode = 64;
