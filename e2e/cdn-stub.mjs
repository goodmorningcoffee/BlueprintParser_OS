// [refactor jun12 P0.4] HTTPS CloudFront stand-in for offline viewer e2e.
//
// Serves test/fixtures/synthetic-100pg.pdf at /e2e/synthetic/original.pdf with
// the two behaviors the REAL edge provides and the viewer depends on
// (plan 05 §2: they are "infra half of viewer performance"):
//   1. Range requests (206) — pdf.js loads the 60MB file in 64KB chunks
//   2. CORS incl. preflight for the Range header — the app origin (:3100)
//      fetches cross-origin, exactly like app.domain → assets.domain in prod
// Page-PNG underlays/thumbnails 404 here by design: the viewer must degrade
// to pure pdf.js canvas (and the perf numbers note that).
//
// Self-signed cert is generated on first boot (openssl); playwright runs with
// ignoreHTTPSErrors. getS3Url hardcodes https://, hence TLS not plain http.
import { createServer } from "node:https";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, createReadStream } from "node:fs";

const PORT = 9876;
const FIXTURE = "test/fixtures/synthetic-100pg.pdf";
const ROUTE = "/e2e/synthetic/original.pdf";
const KEY = "/tmp/e2e-cdn-key.pem";
const CERT = "/tmp/e2e-cdn-cert.pem";

if (!existsSync(KEY) || !existsSync(CERT)) {
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-keyout", KEY, "-out", CERT,
    "-days", "30", "-nodes", "-subj", "/CN=localhost",
  ]);
}
if (!existsSync(FIXTURE)) {
  console.error(`[cdn-stub] fixture missing — run: node scripts/make-synthetic-pdf.mjs`);
  process.exit(1);
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Range, If-Match, If-None-Match, If-Range",
  "Access-Control-Expose-Headers": "Accept-Ranges, Content-Range, Content-Length, Content-Encoding",
};

const server = createServer({ key: readFileSync(KEY), cert: readFileSync(CERT) }, (req, res) => {
  const url = new URL(req.url, "https://localhost");
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    return res.end();
  }
  if (url.pathname !== ROUTE) {
    res.writeHead(404, { ...CORS, "content-type": "text/plain" });
    return res.end("not found");
  }
  const size = statSync(FIXTURE).size;
  const base = { ...CORS, "Accept-Ranges": "bytes", "Content-Type": "application/pdf" };
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!m || (m[1] === "" && m[2] === "")) {
      res.writeHead(416, { ...base, "Content-Range": `bytes */${size}` });
      return res.end();
    }
    const start = m[1] === "" ? size - Number(m[2]) : Number(m[1]);
    const end = m[1] !== "" && m[2] !== "" ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start > end || start >= size) {
      res.writeHead(416, { ...base, "Content-Range": `bytes */${size}` });
      return res.end();
    }
    res.writeHead(206, {
      ...base,
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Content-Length": end - start + 1,
    });
    if (req.method === "HEAD") return res.end();
    return createReadStream(FIXTURE, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...base, "Content-Length": size });
  if (req.method === "HEAD") return res.end();
  createReadStream(FIXTURE).pipe(res);
});

server.listen(PORT, () => console.log(`[cdn-stub] https://localhost:${PORT}${ROUTE}`));
