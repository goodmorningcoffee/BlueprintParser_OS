# syntax=docker/dockerfile:1.7
FROM alpine:3.21 AS rds-ca
RUN apk add --no-cache ca-certificates curl \
    && curl --fail --silent --show-error --location \
      https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
      --output /aws-rds-global-bundle.pem \
    && test "$(grep -c -- '-----BEGIN CERTIFICATE-----' /aws-rds-global-bundle.pem)" -gt 0 \
    && test "$(grep -c -- '-----END CERTIFICATE-----' /aws-rds-global-bundle.pem)" -gt 0 \
    && chmod 0444 /aws-rds-global-bundle.pem

# ── Stage 1: Install dependencies ──────────────────────────────
# Build stages use Alpine (small, fast). Runner uses Debian for Python/ML deps.
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm install --ignore-scripts

# ── Stage 2: Build the Next.js app ────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=rds-ca /aws-rds-global-bundle.pem /etc/ssl/certs/aws-rds-global-bundle.pem
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
# The production DB module is evaluated during `next build`. Supply a
# non-secret, non-routable shape-valid URL so the same fail-closed URL parser is
# exercised without embedding deployment credentials or contacting a database.
ENV DATABASE_URL=postgresql://build:build@database.invalid:5432/build
# Bucket-fill engine routing. Next inlines NEXT_PUBLIC_* at build time (src/lib/bucket-fill-mode.ts),
# so this is the only place it can be set; a task env var does nothing. `auto` = vector on pages
# with vector geometry, raster fallback elsewhere. Owner decision 2026-09-30: vector fill ships.
ARG NEXT_PUBLIC_BUCKET_FILL_MODE=auto
ENV NEXT_PUBLIC_BUCKET_FILL_MODE=${NEXT_PUBLIC_BUCKET_FILL_MODE}

RUN --mount=type=cache,target=/app/.next/cache \
    npm run build

# Bundle standalone processing worker for Step Functions / ECS tasks
RUN npx esbuild scripts/process-worker.ts \
    --bundle --platform=node --target=node20 \
    --outfile=dist/process-worker.js \
    --alias:@=./src \
    --external:pg-native

# Bundle the scheduled durable project-asset deletion reconciler.
# bcrypt is native: bundled in, node-gyp-build looks for its binary next to the BUNDLE (/app/scripts)
# and the worker dies at load ("No native build was found") on every 5-minute run. Left external, it
# resolves from /app/node_modules like the app does. (Measured 2026-09-29; process-worker has no
# bcrypt in its import graph.)
RUN npx esbuild scripts/project-asset-deletion-worker.ts \
    --bundle --platform=node --target=node20 \
    --outfile=dist/project-asset-deletion-worker.js \
    --alias:@=./src \
    --external:pg-native \
    --external:bcrypt

# ── Stage 3: Production runner ─────────────────────────────────
# Using Debian slim instead of Alpine for full glibc compatibility
# (required by img2table/polars and future TATR/PyTorch)
FROM node:20-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN groupadd --system --gid 1001 nodejs && \
    useradd --system --uid 1001 --no-create-home --gid nodejs nextjs

# Install Ghostscript, Python 3, Tesseract OCR, and system libraries
# Two pins are load-bearing, not tidiness (measured 2026-09-29 against PyPI): pymupdf 1.28.2 prints
# a deprecation warning to STDOUT on `import fitz`, and src/lib/processing.ts JSON-parses the
# script's stdout — every upload failed. opencv-python-headless 5.0 changed HoughLinesP's shape and
# img2table 0.0.12 raises TypeError. Both pins are the versions the last working image resolved.
# pip3 --no-cache-dir is intentionally REMOVED below because we've mounted a
# BuildKit cache at /root/.cache/pip — the cache lives outside the final image
# layer, so there's no image bloat, and wheel downloads are reused across builds.
RUN --mount=type=cache,target=/root/.cache/pip,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    ghostscript \
    python3 \
    python3-pip \
    tesseract-ocr \
    tesseract-ocr-eng \
    libglib2.0-0 \
    libheif-dev \
    libsm6 \
    libxext6 \
    libxrender1 \
    libgl1 \
    && rm -rf /var/lib/apt/lists/* \
    && pip3 install --break-system-packages \
    numpy \
    opencv-python-headless==4.13.0.92 \
    pytesseract==0.3.13 \
    pdfplumber \
    pdfminer.six \
    pymupdf==1.27.2.2 \
    tabulate \
    openpyxl \
    "Pillow>=10.0" \
    "pillow-heif>=0.16" \
    img2table==0.0.12 \
    && pip3 install --break-system-packages \
    torch==2.5.1+cpu torchvision==0.20.1+cpu --index-url https://download.pytorch.org/whl/cpu \
    && pip3 install --break-system-packages \
    "transformers>=4.40.0,<5.0.0" \
    "timm>=0.9.0,<2.0.0"

# Production PostgreSQL clients and the production Next build share the same
# reviewed RDS trust bundle.
COPY --from=rds-ca /aws-rds-global-bundle.pem /etc/ssl/certs/aws-rds-global-bundle.pem

# Schema checker/migrator deps. The ops scripts (scripts/*.mjs) run outside Next.js' traced server
# graph. `pg` and its dependencies are already in the standalone trace; `drizzle-orm` is not
# (Turbopack bundles it into chunks), so copy the lock-resolved package from the deps stage. It is
# pure JS with no runtime dependencies, so the Alpine-built copy is valid on Debian.
# (Was `npm install drizzle-orm pg` here, which resolved @latest — not the lock, despite its
# comment — rewrote package.json, and installed the entire production tree: 670 MB. Measured.)

# Copy standalone output
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=deps /app/node_modules/drizzle-orm ./node_modules/drizzle-orm

# Copy migration files and entrypoint
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

# Copy Phase 3 scripts, data, and bundled worker
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/src/data ./src/data
COPY --from=builder /app/dist/process-worker.js ./scripts/process-worker.js
COPY --from=builder /app/dist/project-asset-deletion-worker.js ./scripts/project-asset-deletion-worker.js

# Copy TATR (Table Transformer) model files for table-structure detection.
# ~115 MB. Required by scripts/tatr_structure.py via from_pretrained().
# .dockerignore selectively allows models/tatr/ through while excluding YOLO weights.
COPY --from=builder /app/models/tatr ./models/tatr

# PROD-FIX-2: patch TATR preprocessor_config.json Size format. The model was
# exported with size: {longest_edge: 800} which the installed transformers
# >= 4.40 rejects with: "Size must contain 'height' and 'width' keys or
# 'shortest_edge' and 'longest_edge' keys. Got dict_keys(['longest_edge'])".
# Surfaced via the Phase I debug UI on the first prod parse. The fix is a
# trivial schema update — DETR ImageProcessor needs both keys.
RUN python3 -c "import json; \
p='/app/models/tatr/preprocessor_config.json'; \
c=json.load(open(p)); \
c['size']={'shortest_edge': 800, 'longest_edge': 800}; \
json.dump(c, open(p,'w'), indent=2); \
print('Patched TATR preprocessor_config.json size to', c['size'])"

# Patch img2table for Polars API compatibility AND disable numba caching in
# rotation.py (img2table 0.0.12 uses @njit(cache=True) which fails in containers
# with "RuntimeError: no locator available" — surfaced via Phase I debug UI).
RUN python3 ./scripts/patch_img2table.py

# PROD-FIX-1 defense in depth: give numba a writable cache directory in case any
# other numba-cached function tries to write a cache file. /tmp is writable by
# the nextjs user.
ENV NUMBA_CACHE_DIR=/tmp/numba_cache
RUN mkdir -p /tmp/numba_cache && chmod 777 /tmp/numba_cache

USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["./entrypoint.sh", "app"]
