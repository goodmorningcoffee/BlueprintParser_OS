/**
 * detectors/contact.ts
 *
 * Detects phone numbers, fax numbers, emails, URLs, addresses, and zip codes.
 */

import type { TextractWord } from "@/types";
import {
  isAdjacent,
  makeAnnotation,
  avgConf,
} from "@/lib/ocr-utils";
import type { DetectorContext, TextDetector } from "./types";

// ═══════════════════════════════════════════════════════════════════
// Module-scope compiled regexes and constants
// ═══════════════════════════════════════════════════════════════════

const RE_PHONE = /^\(?\d{3}\)?[-.\s]?\d{3}[-.]?\d{4}$/;
const RE_PHONE_MULTI_START = /^\(?\d{3}\)?[-.]?$/;
const RE_PHONE_MULTI_END = /^\d{3}[-.]?\d{4}$/;
const RE_FAX_PREFIX = /^(?:FAX|F:)$/i;
const RE_EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const RE_EMAIL_USER = /^[A-Za-z0-9._%+-]+$/;
const RE_EMAIL_AT = /^@$/;
const RE_EMAIL_DOMAIN = /^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const RE_URL = /^(?:https?:\/\/|www\.)\S+$/i;
const RE_STREET_NUMBER = /^\d{1,6}$/;
const STREET_SUFFIXES = new Set([
  "ST", "ST.", "STREET", "AVE", "AVE.", "AVENUE", "BLVD", "BLVD.", "BOULEVARD",
  "DR", "DR.", "DRIVE", "RD", "RD.", "ROAD", "LN", "LN.", "LANE", "CT", "CT.",
  "COURT", "WAY", "PKWY", "PKWY.", "PARKWAY", "HWY", "HWY.", "HIGHWAY",
  "PL", "PL.", "PLACE", "CIR", "CIR.", "CIRCLE",
]);
const RE_ZIP = /^\d{5}(?:-\d{4})?$/;
const RE_STATE_ABBR = /^[A-Z]{2}$/;

// ═══════════════════════════════════════════════════════════════════
// Detector
// ═══════════════════════════════════════════════════════════════════

function detect(ctx: DetectorContext): ReturnType<TextDetector["detect"]> {
  const { words } = ctx;
  const results: ReturnType<TextDetector["detect"]> = [];

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const txt = w.text;

    // Single-word phone
    if (RE_PHONE.test(txt.replace(/\s/g, ""))) {
      // Check if preceded by FAX
      const isFax = i > 0 && RE_FAX_PREFIX.test(words[i - 1].text);
      if (isFax) {
        results.push(makeAnnotation("fax", "contact",
          [words[i - 1], w], [i - 1, i], avgConf([words[i - 1], w])));
      } else {
        results.push(makeAnnotation("phone", "contact", [w], [i], w.confidence));
      }
      continue;
    }

    // Multi-word phone: area code + rest
    if (RE_PHONE_MULTI_START.test(txt) && i + 1 < words.length) {
      const next = words[i + 1];
      if (isAdjacent(w, next) && RE_PHONE_MULTI_END.test(next.text)) {
        const isFax = i > 0 && RE_FAX_PREFIX.test(words[i - 1].text);
        if (isFax) {
          results.push(makeAnnotation("fax", "contact",
            [words[i - 1], w, next], [i - 1, i, i + 1],
            avgConf([words[i - 1], w, next])));
        } else {
          results.push(makeAnnotation("phone", "contact",
            [w, next], [i, i + 1], avgConf([w, next])));
        }
        i += 1;
        continue;
      }
    }

    // Email: single word
    if (RE_EMAIL.test(txt)) {
      results.push(makeAnnotation("email", "contact", [w], [i], w.confidence));
      continue;
    }

    // Email: split at @
    if (RE_EMAIL_USER.test(txt) && i + 2 < words.length) {
      const atWord = words[i + 1];
      const domainWord = words[i + 2];
      if (RE_EMAIL_AT.test(atWord.text) && RE_EMAIL_DOMAIN.test(domainWord.text)
          && isAdjacent(w, atWord) && isAdjacent(atWord, domainWord)) {
        results.push(makeAnnotation("email", "contact",
          [w, atWord, domainWord], [i, i + 1, i + 2],
          avgConf([w, atWord, domainWord])));
        i += 2;
        continue;
      }
    }

    // URL
    if (RE_URL.test(txt)) {
      results.push(makeAnnotation("url", "contact", [w], [i], w.confidence));
      continue;
    }

    // Zip code: 5 digits or 5+4, preceded by a 2-letter state abbreviation
    if (RE_ZIP.test(txt)) {
      const prevIsState = i > 0 && /^[A-Z]{2}\.?$/.test(words[i - 1].text);
      if (prevIsState) {
        results.push(makeAnnotation("zip-code", "contact",
          [words[i - 1], w], [i - 1, i], avgConf([words[i - 1], w])));
      } else {
        // Standalone zip (lower confidence — could be a room number)
        results.push(makeAnnotation("zip-code", "contact", [w], [i], w.confidence * 0.6));
      }
      continue;
    }

    // Address: number + street name + suffix
    if (RE_STREET_NUMBER.test(txt) && i + 2 < words.length) {
      // Look ahead for street suffix within next 5 words
      for (let j = i + 1; j < Math.min(i + 6, words.length); j++) {
        if (!isAdjacent(words[j - 1], words[j])) break;
        const upper = words[j].text.toUpperCase();
        if (STREET_SUFFIXES.has(upper)) {
          const addrWords: TextractWord[] = [];
          const addrIndices: number[] = [];
          for (let k = i; k <= j; k++) {
            addrWords.push(words[k]);
            addrIndices.push(k);
          }
          // Extend to capture city, state, zip
          let end = j;
          for (let k = j + 1; k < Math.min(j + 6, words.length); k++) {
            if (!isAdjacent(words[k - 1], words[k])) break;
            addrWords.push(words[k]);
            addrIndices.push(k);
            end = k;
            if (RE_ZIP.test(words[k].text)) break;
          }
          results.push(makeAnnotation("address", "contact",
            addrWords, addrIndices, avgConf(addrWords)));
          i = end;
          break;
        }
      }
    }
  }

  return results;
}

export const contactDetector: TextDetector = {
  meta: {
    id: "contact",
    name: "Contact Information",
    category: "heuristic",
    description: "Detects phone numbers, fax numbers, emails, URLs, addresses, and zip codes.",
    defaultEnabled: true,
    produces: ["phone", "fax", "address", "email", "url", "zip-code"],
  },
  detect,
};
