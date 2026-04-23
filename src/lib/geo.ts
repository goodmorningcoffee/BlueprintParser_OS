/**
 * GeoIP — IP → country-code lookup via MaxMind GeoLite2-Country offline DB.
 *
 * Free, offline, private. Bundled .mmdb file is ~3 MB. Zero per-request network
 * cost; lookups take microseconds after first load.
 *
 * The DB file is NOT committed to the repo (MaxMind's EULA requires you to
 * register for a free license key and download their current DB). The Docker
 * image's build process places it at `/app/geo/GeoLite2-Country.mmdb`. If the
 * file is missing (dev environment without a local copy), `lookupCountry`
 * gracefully returns `"??"` — the feature degrades, the app keeps working.
 *
 * To enable:
 *   1. Register free MaxMind account at https://dev.maxmind.com/geoip/geolite2-free-geolocation-data
 *   2. Download GeoLite2-Country.mmdb
 *   3. Place at `docker/GeoLite2-Country.mmdb` in this repo (gitignored)
 *   4. The Dockerfile COPYs it to `/app/geo/` during build
 */

import { open, type Reader, type CountryResponse } from "maxmind";
import path from "node:path";
import { logger } from "./logger";

const MMDB_PATH = process.env.GEOIP_DB_PATH || path.join(process.cwd(), "geo", "GeoLite2-Country.mmdb");

let readerPromise: Promise<Reader<CountryResponse> | null> | null = null;
let loadAttempted = false;

async function getReader(): Promise<Reader<CountryResponse> | null> {
  if (readerPromise) return readerPromise;
  readerPromise = (async () => {
    try {
      const reader = await open<CountryResponse>(MMDB_PATH);
      logger.info("[geo] MaxMind DB loaded", { path: MMDB_PATH });
      return reader;
    } catch (err) {
      if (!loadAttempted) {
        logger.warn("[geo] MaxMind DB not available — country lookups will return '??'", {
          path: MMDB_PATH,
          hint: "Place GeoLite2-Country.mmdb at the path or set GEOIP_DB_PATH",
          error: err instanceof Error ? err.message : String(err),
        });
        loadAttempted = true;
      }
      return null;
    }
  })();
  return readerPromise;
}

/**
 * Returns an ISO-3166-1 alpha-2 country code (e.g. "US", "GB") or "??" when
 * the IP is invalid, the DB is missing, or the lookup fails for any reason.
 * Never throws.
 */
export async function lookupCountry(ip: string | null | undefined): Promise<string> {
  if (!ip || ip === "unknown") return "??";
  // Strip IPv6 zone index if present
  const clean = ip.replace(/%.*$/, "");
  try {
    const reader = await getReader();
    if (!reader) return "??";
    const result = reader.get(clean);
    return result?.country?.iso_code || "??";
  } catch {
    return "??";
  }
}

// Preload the MaxMind reader at module-import time so the first request after
// an ECS cold-start doesn't pay ~100ms loading the 3 MB .mmdb file on its
// [visit] log emission. `getReader()` catches its own errors and logs a
// warning if the .mmdb is missing — void-discarding the promise is safe.
void getReader();
