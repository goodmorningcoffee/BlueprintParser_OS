import { isIP } from "node:net";

// The production ALB appends its socket peer to X-Forwarded-For. Parse only a bounded tail and
// trust only that rightmost nonempty hop; every preceding value is caller-controlled.
const X_FORWARDED_FOR_TAIL_MAX_CHARS = 2_048;
const X_FORWARDED_FOR_MAX_SUFFIX_SEGMENTS = 8;

function canonicalIpLiteral(value: string): string | null {
  const version = isIP(value);
  if (version === 4) {
    return value
      .split(".")
      .map((octet) => String(Number(octet)))
      .join(".");
  }
  if (version === 6) {
    try {
      const hostname = new URL(`http://[${value}]/`).hostname;
      return hostname.slice(1, -1);
    } catch {
      return null;
    }
  }
  return null;
}

/** Resolve the ALB-authenticated client address from an append-mode X-Forwarded-For header. */
export function trustedClientIp(xForwardedFor: string | null): string {
  if (!xForwardedFor) return "unknown";

  const tail = xForwardedFor.slice(-X_FORWARDED_FOR_TAIL_MAX_CHARS);
  let end = tail.length;
  for (
    let segmentCount = 0;
    segmentCount < X_FORWARDED_FOR_MAX_SUFFIX_SEGMENTS && end >= 0;
    segmentCount += 1
  ) {
    const comma = tail.lastIndexOf(",", end - 1);
    const candidate = tail.slice(comma + 1, end).trim();
    if (candidate) return canonicalIpLiteral(candidate) ?? "unknown";
    if (comma < 0) break;
    end = comma;
  }
  return "unknown";
}
