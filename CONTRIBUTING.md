# Contributing to BlueprintParser

Thanks for your interest in contributing! This guide covers everything you need to get started.

## Prerequisites

- **Node.js 20+**
- **Docker** (for PostgreSQL via docker-compose)
- **npm** (comes with Node.js)

Optional (for full pipeline features):
- Python 3.10+ (table line detection, YOLO inference, template matching)
- Tesseract OCR (fallback OCR engine)
- Ghostscript (PDF rasterization)
- AWS CLI (if testing cloud features)

## Local Development Setup

```bash
git clone https://github.com/deliciousnoodles/BlueprintParser.git
cd BlueprintParser/blueprintparser_2
cp .env.example .env.local       # Edit DATABASE_URL and NEXTAUTH_SECRET
docker compose up -d              # Start PostgreSQL
npm install
npx drizzle-kit migrate           # Run database migrations
npm run dev                       # http://localhost:3000
```

Create an admin account via the registration page, or use the bootstrap script:

```bash
bash root_admin.sh
```

## Code Style

- **TypeScript** with strict mode enabled
- **ESLint** for linting: `npm run lint`
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
  app/          # Next.js App Router pages + API routes
  components/   # React components (viewer/, dashboard/, auth/)
  lib/          # Core business logic (processing, detection, parsing)
  stores/       # Zustand state management
  types/        # Shared TypeScript types
  hooks/        # Custom React hooks
  data/         # Static data files (CSI masterformat)
scripts/        # Python scripts (YOLO, OpenCV, template matching)
infrastructure/ # Terraform IaC for AWS deployment
drizzle/        # Database migrations
```

See the [README](README.md) for detailed architecture documentation.

## Pull Request Process

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Run `npm run lint` and `npm test` to verify
4. Run `npm run build` to confirm the build succeeds
5. Open a PR against `main` with a clear description of what changed and why

## Database Changes

If you modify the schema in `src/lib/db/schema.ts`:

```bash
npx drizzle-kit generate    # Generate migration SQL
npx drizzle-kit migrate     # Apply it locally
```

Include the generated migration file in your PR.

## Questions?

Open an issue on GitHub. For architecture questions, the README has detailed documentation on every system.
