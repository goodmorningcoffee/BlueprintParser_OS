# ── Stage 1: Install dependencies ──────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# ── Stage 2: Build the Next.js app ────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1

RUN npm run build

# Bundle standalone processing worker for Step Functions / ECS tasks
RUN npx esbuild scripts/process-worker.ts \
    --bundle --platform=node --target=node20 \
    --outfile=dist/process-worker.js \
    --alias:@=./src \
    --external:pg-native

# ── Stage 3: Production runner ─────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Install Ghostscript for PDF rasterization (required by processing pipeline)
# Install Python 3, Tesseract OCR, and dependencies for keynote extraction
RUN apk add --no-cache \
    ghostscript \
    python3 \
    py3-pip \
    py3-numpy \
    py3-opencv \
    tesseract-ocr \
    tesseract-ocr-data-eng \
    && pip3 install --break-system-packages --no-cache-dir \
    pytesseract==0.3.13

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
