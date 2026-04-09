# ── Stage 1: Install dependencies ──────────────────────────────
FROM node:20-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --ignore-scripts

# ── Stage 2: Build the Next.js app ────────────────────────────
FROM node:20-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1

# Next.js inlines NEXT_PUBLIC_* vars at build time — required for client-side
# S3/CloudFront features (thumbnails, PNG fallback, page prefetching)
ARG NEXT_PUBLIC_CLOUDFRONT_DOMAIN=assets.blueprintparser.com
ENV NEXT_PUBLIC_CLOUDFRONT_DOMAIN=$NEXT_PUBLIC_CLOUDFRONT_DOMAIN

RUN npm run build

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
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ghostscript \
    python3 \
    python3-pip \
    tesseract-ocr \
    tesseract-ocr-eng \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender1 \
    && rm -rf /var/lib/apt/lists/* \
    && pip3 install --break-system-packages --no-cache-dir \
    numpy \
    opencv-python-headless \
    pytesseract==0.3.13 \
    pdfplumber \
    pdfminer.six \
    tabulate \
    openpyxl \
    camelot-py[base] \
    img2table

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

# Install drizzle-orm and pg for migrations (already in standalone but need migrator)
RUN npm install drizzle-orm pg 2>/dev/null || true

USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["./entrypoint.sh"]
