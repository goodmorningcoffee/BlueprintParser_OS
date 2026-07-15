// [refactor jul14 P2] HTTPS S3-shaped fixture endpoint for offline viewer e2e.
//
// The fixture has two intentional browser boundaries:
//   - current builds read the path-style S3 URL through the private gateway;
//   - the source-exact perf-v2 baseline reads the project URL directly.
// Only the two seeded projects and those two exact path shapes are accepted.
// The stats endpoint is a test oracle for response bytes, source bytes, and
// source teardown. It is deliberately not a production S3 emulator.
import { execFileSync } from "node:child_process";
import { createServer } from "node:https";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { Transform } from "node:stream";
import { ensureSyntheticPdfFixture } from "./ensure-synthetic-pdf.mjs";

const PORT = 9876;
const FIXTURE = ensureSyntheticPdfFixture();
const FIXTURE_BUCKET = "e2e-dummy-bucket";
const FIXTURE_PROJECT_PATHS = Object.freeze([
  "e2e-co/00000000000000000001",
  "e2e-co/00000000000000000002",
]);
const DIRECT_PDF_PATHS = FIXTURE_PROJECT_PATHS.map(
  (projectPath) => `/${projectPath}/original.pdf`,
);
const BUCKET_PDF_PATHS = FIXTURE_PROJECT_PATHS.map(
  (projectPath) => `/${FIXTURE_BUCKET}/${projectPath}/original.pdf`,
);
const ALLOWED_PDF_PATHS = Object.freeze([
  ...DIRECT_PDF_PATHS,
  ...BUCKET_PDF_PATHS,
]);
const ALLOWED_PDF_PATH_SET = new Set(ALLOWED_PDF_PATHS);
const ROUTE = DIRECT_PDF_PATHS[0];
const STATS_ROUTE = "/__bp_e2e_s3_transport";
const KEY = "/tmp/e2e-cdn-key.pem";
const CERT = "/tmp/e2e-cdn-cert.pem";

// The standard perf spec issues this exact request and aborts after the first
// browser chunk. Throttling only this diagnostic range makes the cancellation
// deterministic while leaving all timed pdf.js ranges source-realistic.
const INTENTIONAL_ABORT_RANGE = "bytes=0-33554431";
const SOURCE_CHUNK_BYTES = 64 * 1024;
const ABORT_CHUNK_DELAY_MS = 20;

let nextRequestId = 1;
let completedRequests = [];
const activeRequests = new Map();
const activeStreams = new Map();

if (!existsSync(KEY) || !existsSync(CERT)) {
  execFileSync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-keyout",
    KEY,
    "-out",
    CERT,
    "-days",
    "30",
    "-nodes",
    "-subj",
    "/CN=localhost",
  ]);
}
const fixtureBytes = statSync(FIXTURE).size;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Range, If-Match, If-None-Match, If-Range",
  "Access-Control-Expose-Headers":
    "Accept-Ranges, Content-Range, Content-Length, Content-Encoding",
};

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...CORS,
    "Cache-Control": "no-store",
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function byteLength(chunk, encoding) {
  if (chunk === undefined || chunk === null || typeof chunk === "function") {
    return 0;
  }
  if (typeof chunk === "string") {
    return Buffer.byteLength(
      chunk,
      typeof encoding === "string" ? encoding : undefined,
    );
  }
  return chunk.byteLength ?? Buffer.byteLength(chunk);
}

function safeInteger(raw) {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

/** Parse one RFC 7233 byte range. Suffixes larger than the object clamp to 0. */
function parseRange(rawRange, size) {
  const match = /^bytes=(\d*)-(\d*)$/u.exec(rawRange);
  if (!match || (match[1] === "" && match[2] === "")) return null;

  if (match[1] === "") {
    const suffixLength = safeInteger(match[2]);
    if (suffixLength === null || suffixLength === 0) return null;
    const start = Math.max(0, size - suffixLength);
    const end = size - 1;
    return { start, end, length: end - start + 1, kind: "suffix" };
  }

  const start = safeInteger(match[1]);
  const requestedEnd = match[2] === "" ? size - 1 : safeInteger(match[2]);
  if (
    start === null ||
    requestedEnd === null ||
    start >= size ||
    requestedEnd < start
  ) {
    return null;
  }
  const end = Math.min(requestedEnd, size - 1);
  return {
    start,
    end,
    length: end - start + 1,
    kind: match[2] === "" ? "open" : "closed",
  };
}

function snapshotRecord(record) {
  // Internal completion flags are closure state, so every enumerable field is
  // intentional oracle output and can be validated by Playwright.
  return { ...record };
}

function accountResponse(req, res, pathname) {
  const record = {
    id: nextRequestId++,
    method: req.method,
    pathname,
    range: req.headers.range ?? null,
    servedRange: null,
    expectedBodyBytes: null,
    bodyBytes: 0,
    status: null,
    outcome: null,
    sourceBytes: 0,
    sourceCreated: false,
    sourceEnded: false,
    sourceClosed: false,
    sourceDestroyed: false,
    sourceDestroyedOnResponseClose: false,
    sourceError: null,
    throttleCreated: false,
    throttleClosed: false,
  };
  activeRequests.set(record.id, record);

  let source = null;
  let throttle = null;
  let responseSettled = false;
  let requestCompleted = false;

  const maybeComplete = () => {
    if (
      requestCompleted ||
      !responseSettled ||
      (record.sourceCreated && !record.sourceClosed) ||
      (record.throttleCreated && !record.throttleClosed)
    ) {
      return;
    }
    requestCompleted = true;
    activeRequests.delete(record.id);
    completedRequests.push(snapshotRecord(record));
  };

  const originalWrite = res.write.bind(res);
  res.write = (chunk, encoding, callback) => {
    record.bodyBytes += byteLength(chunk, encoding);
    return originalWrite(chunk, encoding, callback);
  };
  const originalEnd = res.end.bind(res);
  res.end = (chunk, encoding, callback) => {
    record.bodyBytes += byteLength(chunk, encoding);
    return originalEnd(chunk, encoding, callback);
  };

  const settleResponse = (outcome) => {
    if (responseSettled) return;
    responseSettled = true;
    record.status = res.statusCode;
    record.outcome = outcome;
    maybeComplete();
  };

  res.once("finish", () => settleResponse("finish"));
  res.once("close", () => {
    const downstreamClosedEarly = !res.writableFinished;
    if (downstreamClosedEarly && source && !source.closed) {
      record.sourceDestroyedOnResponseClose = true;
      source.destroy();
    }
    if (downstreamClosedEarly && throttle && !throttle.closed) {
      throttle.destroy();
    }
    settleResponse(res.writableFinished ? "finish" : "close");
  });

  const attachSource = (nextSource, nextThrottle = null) => {
    source = nextSource;
    throttle = nextThrottle;
    record.sourceCreated = true;
    activeStreams.set(`${record.id}:source`, "source");
    source.on("data", (chunk) => {
      record.sourceBytes += byteLength(chunk);
    });
    source.once("end", () => {
      record.sourceEnded = true;
    });
    source.once("error", (error) => {
      record.sourceError =
        error instanceof Error ? error.message : String(error);
      if (throttle && !throttle.destroyed) throttle.destroy(error);
      if (!res.destroyed) res.destroy(error);
    });
    source.once("close", () => {
      record.sourceClosed = true;
      record.sourceDestroyed = source.destroyed;
      activeStreams.delete(`${record.id}:source`);
      maybeComplete();
    });

    if (throttle) {
      record.throttleCreated = true;
      activeStreams.set(`${record.id}:throttle`, "throttle");
      throttle.once("error", (error) => {
        if (!source.destroyed) source.destroy(error);
        if (!res.destroyed) res.destroy(error);
      });
      throttle.once("close", () => {
        record.throttleClosed = true;
        activeStreams.delete(`${record.id}:throttle`);
        maybeComplete();
      });
    }
  };

  return { record, attachSource };
}

function delayedPassThrough() {
  return new Transform({
    transform(chunk, _encoding, callback) {
      setTimeout(callback, ABORT_CHUNK_DELAY_MS, null, chunk);
    },
  });
}

function streamFixture(res, accounting, range) {
  const source = createReadStream(FIXTURE, {
    start: range?.start,
    end: range?.end,
    highWaterMark: SOURCE_CHUNK_BYTES,
  });
  if (accounting.record.range === INTENTIONAL_ABORT_RANGE) {
    const throttle = delayedPassThrough();
    accounting.attachSource(source, throttle);
    source.pipe(throttle).pipe(res);
    return;
  }
  accounting.attachSource(source);
  source.pipe(res);
}

const server = createServer(
  { key: readFileSync(KEY), cert: readFileSync(CERT) },
  (req, res) => {
    const url = new URL(req.url, "https://localhost");
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS);
      return res.end();
    }
    if (url.pathname === STATS_ROUTE) {
      if (req.method === "POST") {
        if (activeRequests.size > 0 || activeStreams.size > 0) {
          return json(res, 409, {
            error: "cannot reset while fixture responses are active",
            activeCount: activeRequests.size,
            activeStreamCount: activeStreams.size,
          });
        }
        completedRequests = [];
        res.writeHead(204, { ...CORS, "Cache-Control": "no-store" });
        return res.end();
      }
      if (req.method === "GET") {
        return json(res, 200, {
          schemaVersion: 2,
          fixture: {
            bytes: fixtureBytes,
            bucket: FIXTURE_BUCKET,
            projectPaths: FIXTURE_PROJECT_PATHS,
            allowedPdfPaths: ALLOWED_PDF_PATHS,
            intentionalAbortRange: INTENTIONAL_ABORT_RANGE,
            sourceChunkBytes: SOURCE_CHUNK_BYTES,
            abortChunkDelayMs: ABORT_CHUNK_DELAY_MS,
          },
          activeCount: activeRequests.size,
          activeStreamCount: activeStreams.size,
          activeRequests: [...activeRequests.values()].map(snapshotRecord),
          completedRequests,
        });
      }
      res.writeHead(405, { ...CORS, Allow: "GET, POST, OPTIONS" });
      return res.end();
    }

    if (!ALLOWED_PDF_PATH_SET.has(url.pathname)) {
      res.writeHead(404, { ...CORS, "Content-Type": "text/plain" });
      return res.end("not found");
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, {
        ...CORS,
        Allow: "GET, HEAD, OPTIONS",
        "Content-Type": "text/plain",
      });
      return res.end("method not allowed");
    }

    const accounting = accountResponse(req, res, url.pathname);
    const base = {
      ...CORS,
      "Accept-Ranges": "bytes",
      "Content-Type": "application/pdf",
    };
    const rawRange = req.headers.range;
    if (rawRange) {
      const range = parseRange(rawRange, fixtureBytes);
      if (!range) {
        res.writeHead(416, {
          ...base,
          "Content-Range": `bytes */${fixtureBytes}`,
        });
        return res.end();
      }
      accounting.record.servedRange = `bytes ${range.start}-${range.end}/${fixtureBytes}`;
      accounting.record.expectedBodyBytes = range.length;
      res.writeHead(206, {
        ...base,
        "Content-Range": accounting.record.servedRange,
        "Content-Length": range.length,
      });
      if (req.method === "HEAD") return res.end();
      streamFixture(res, accounting, range);
      return;
    }

    accounting.record.expectedBodyBytes = fixtureBytes;
    res.writeHead(200, { ...base, "Content-Length": fixtureBytes });
    if (req.method === "HEAD") return res.end();
    streamFixture(res, accounting, null);
  },
);

server.listen(PORT, () =>
  console.log(`[cdn-stub] https://localhost:${PORT}${ROUTE}`),
);
