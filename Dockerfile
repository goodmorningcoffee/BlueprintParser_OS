# syntax=docker/dockerfile:1.7
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
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1

# Next.js inlines NEXT_PUBLIC_* vars at build time — required for client-side
# S3/CloudFront features (thumbnails, PNG fallback, page prefetching)
ARG NEXT_PUBLIC_CLOUDFRONT_DOMAIN=""
ARG NEXT_PUBLIC_S3_BUCKET=""
ENV NEXT_PUBLIC_CLOUDFRONT_DOMAIN=$NEXT_PUBLIC_CLOUDFRONT_DOMAIN
ENV NEXT_PUBLIC_S3_BUCKET=$NEXT_PUBLIC_S3_BUCKET

RUN --mount=type=cache,target=/app/.next/cache \
    npm run build

# Bundle standalone processing worker for Step Functions / ECS tasks
RUN npx esbuild scripts/process-worker.ts \
    --bundle --platform=node --target=node20 \
    --outfile=dist/process-worker.js \
    --alias:@=./src \
    --external:pg-native

# ── Stage 3: Production runner ─────────────────────────────────
# Using Debian slim instead of Alpine for full glibc compatibility
# (required by img2table/polars, camelot, and future TATR/PyTorch)
FROM node:20-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN groupadd --system --gid 1001 nodejs && \
    useradd --system --uid 1001 --no-create-home --gid nodejs nextjs

# Install Ghostscript, Python 3, Tesseract OCR, and system libraries
# pip3 --no-cache-dir is intentionally REMOVED below because we've mounted a
# BuildKit cache at /root/.cache/pip — the cache lives outside the final image
# layer, so there's no image bloat, and wheel downloads are reused across builds.
RUN --mount=type=cache,target=/root/.cache/pip,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
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
    opencv-python-headless \
    pytesseract==0.3.13 \
    pdfplumber \
    pdfminer.six \
    pymupdf \
    tabulate \
    openpyxl \
    "Pillow>=10.0" \
    "pillow-heif>=0.16" \
    camelot-py[base] \
    img2table==0.0.12 \
    && pip3 install --break-system-packages \
    torch==2.5.1+cpu torchvision==0.20.1+cpu --index-url https://download.pytorch.org/whl/cpu \
    && pip3 install --break-system-packages \
    "transformers>=4.40.0,<5.0.0" \
    "timm>=0.9.0,<2.0.0"

# Migrator deps (drizzle-orm, pg). Not traced by Next.js standalone because
# entrypoint.sh uses them via `node -e "require(...)"` inside a shell heredoc,
# not from TS code — so the tracer never sees the imports. Installed here
# (cacheable across source-only rebuilds) instead of at the end of the runner
# stage, where every builder COPY invalidated the layer and this install cost
# ~195s every deploy. The `COPY package.json` pins the install to the exact
# versions the main app depends on (drizzle-orm@0.45.1, pg@8.19.0).
COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm install drizzle-orm pg

# Copy standalone output
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Copy migration files and entrypoint
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

# Copy Phase 3 scripts, data, and bundled worker
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/src/data ./src/data
COPY --from=builder /app/dist/process-worker.js ./scripts/process-worker.js

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

CMD ["./entrypoint.sh"]
