# Contributing to BlueprintParser

Thanks for your interest in contributing! This guide covers everything you need to get started.

## Prerequisites

- **Node.js 20 exactly** — pinned by `.nvmrc`; vitest is known-broken under node 24
  (`ERR_INTERNAL_ASSERTION`), so "20 or newer" is not a safe reading
- **Docker** (for PostgreSQL via docker-compose)
- **npm** (comes with Node.js)

Optional (for full pipeline features):
- Python 3.10+ (table line detection, YOLO inference, template matching)
- Tesseract OCR (fallback OCR engine)
- Ghostscript (PDF rasterization)
- AWS CLI (if testing cloud features)

## Local Development Setup

```bash
git clone https://github.com/goodmorningcoffee/BlueprintParser_OS.git
cd BlueprintParser_OS
cp .env.example .env.local       # Edit DATABASE_URL and NEXTAUTH_SECRET
docker compose up -d              # Start PostgreSQL
npm install
npm run db:migrate                # Loopback development database only
npm run dev                       # http://localhost:3000
```

Create an admin account via the registration page, or use the first-run setup script, which also
initializes the database:

```bash
bash scripts/setup.sh
```

`root_admin.sh` is **not** the local bootstrap. It is the owner break-glass helper: it sources
`.deploy.env`, drives ECS Exec against the deployed cluster, and can only list, promote, or demote
an account that already exists.

Trained model weights (`models/`, ignored) must never be pushed. Install the pre-push guard once per
clone; it refuses any push whose history adds weight files or a blob over 50 MB:

```bash
scripts/prepush-check.sh --install
```

## Code Style

- **TypeScript** with strict mode enabled
- **ESLint** with a baseline-aware no-growth gate: `npm run check:lint-baseline` (`npm run lint` reports the full accepted backlog)
- **Tailwind CSS 4** for styling
- No Prettier config yet — match the existing code style

## Testing

```bash
npm test              # Run all tests (Vitest)
npm run test:watch    # Watch mode
```

Tests live in `__tests__/` directories next to the code they test. We use Vitest with jsdom for component-adjacent tests.

## Project Structure

```
src/
  app/          # Next.js App Router pages + API routes (route files are thin shells)
  server/       # HTTP shell + services. Routes are declared with defineRoute(); every
                #   project write goes through the withProjectWrite capability
  queries/      # TanStack Query layer. Canonical keys live in queryKeys.ts;
                #   stores do not fetch
  components/   # React components (viewer/, dashboard/, auth/)
  lib/          # Core business logic (processing, detection, parsing)
  stores/       # Zustand state management
  hooks/        # Custom React hooks
  types/        # Shared TypeScript types
  data/         # Static data files (CSI masterformat)
  workers/      # Web workers (bucket fill, one-click)
  test/         # Test harness, seeds, global setup
scripts/        # Build/CI gate scripts (.mjs), Python CV scripts (.py),
                #   operator shell scripts (.sh)
infrastructure/ # Terraform IaC for AWS deployment
drizzle/        # Database migrations
```

`server/` and `queries/` are the two layers the P0–P5 refactor introduced, and they carry the
contracts the gates enforce — new mutations belong in `server/`, not in `lib/`. Putting one in the
wrong layer is caught by `npm run check:architecture` and
`npm run check:project-security-policy` rather than by review.

See the [README](README.md) for detailed architecture documentation.

## Pull Request Process

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Run `npm run test:scripts`, `npm run check:architecture`, `npm run check:project-security-policy`, `npm run check:schema-cutover`, `npm run check:lint-baseline`, and `npm test`
4. Run `npm run build` to confirm the build succeeds
5. Open a PR against `main` with a clear description of what changed and why

## Database Changes

If you modify the schema in `src/lib/db/schema.ts`:

```bash
npx drizzle-kit generate    # Generate migration SQL
npm run db:migrate          # Apply to a loopback development database
```

Include the generated migration file in your PR.

## Questions?

Open an issue on GitHub. For architecture questions, the README has detailed documentation on every system.
