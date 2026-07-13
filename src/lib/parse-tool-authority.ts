/**
 * Non-reactive capability for the one global tool destination owned by parse operations.
 *
 * Parse bytes have independent per-kind lanes, but the viewer has only one active tool. Keep that
 * distinction out of Zustand: exact token identity prevents ABA/forged-token authority without
 * adding a publication, subscriber edge, or long-lived operation registry.
 */
let currentParseToolOwner: object | null = null;

export function claimParseToolAuthority<T extends object>(token: T): T {
  currentParseToolOwner = token;
  return token;
}

export function invalidateParseToolAuthority(): void {
  currentParseToolOwner = null;
}

export function ownsParseToolAuthority(token: object): boolean {
  return currentParseToolOwner === token;
}
