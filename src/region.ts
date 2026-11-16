// Country backstop for contribution (BACKEND_DESIGN.md §7.2, §8).
// The app hides contribution on EU, EEA and UK App Store storefronts and
// sends its storefront's country as `storefront_country` on the
// contribution entry points. The field is required: this refuses the
// request when it is absent (or null) and when it names one of those
// countries. A device with no storefront (no App Store account, the
// simulator) therefore can't contribute. The value is client-supplied, so
// it is still only a backstop behind the app's own check: a client that
// lies about it gets past this check, and nothing here can tell. The
// storefront, unlike the connection's country, stays the same when the
// phone travels. The value is never stored or logged.

import { errorResponse } from "./errors";

/**
 * ISO 3166-1 alpha-3 codes, as StoreKit's `Storefront.countryCode` gives
 * them, where contribution is switched off: EU 27, the EEA's ISL, LIE and
 * NOR, and GBR.
 */
export const BLOCKED_STOREFRONT_COUNTRIES: ReadonlySet<string> = new Set([
  // EU 27
  "AUT", "BEL", "BGR", "HRV", "CYP", "CZE", "DNK", "EST", "FIN", "FRA", "DEU", "GRC", "HUN", "IRL",
  "ITA", "LVA", "LTU", "LUX", "MLT", "NLD", "POL", "PRT", "ROU", "SVK", "SVN", "ESP", "SWE",
  // EEA outside the EU
  "ISL", "LIE", "NOR",
  // United Kingdom
  "GBR",
]);

export const STOREFRONT_COUNTRY_FIELD = "storefront_country";

// Tested before uppercasing: toUpperCase maps some non-ASCII letters to
// ASCII ("ı" to "I", "ß" to "SS").
const ALPHA3_RE = /^[A-Za-z]{3}$/;

/**
 * Reads `storefront_country` from a parsed request body: the uppercased
 * code, null when the field is absent or JSON null (or the body is not an
 * object), or "invalid" when it is not a string of exactly three ASCII
 * letters.
 */
export function readStorefrontCountry(body: Record<string, unknown> | null): string | null | "invalid" {
  const value = body?.[STOREFRONT_COUNTRY_FIELD] ?? null;
  if (value === null) return null;
  if (typeof value !== "string") return "invalid";
  return ALPHA3_RE.test(value) ? value.toUpperCase() : "invalid";
}

/** Why `refuseStorefront` refused, in `details.reason`. */
export type StorefrontRefusal = "storefront_missing" | "storefront_blocked";

/**
 * `403 REGION_UNAVAILABLE` when the body carries no `storefront_country`
 * (absent or JSON null, or the body is not a JSON object):
 * `details.reason = "storefront_missing"`; or when it names a storefront
 * where contribution is switched off: `"storefront_blocked"`. Else null.
 * Call it before any other work in a contribution entry point
 * (authentication included, since it writes), so a refused request
 * touches nothing. A malformed value is not refused here;
 * `invalidStorefrontCountry` answers it with the handler's other
 * validation.
 */
export function refuseStorefront(body: Record<string, unknown> | null): Response | null {
  const code = readStorefrontCountry(body);
  let reason: StorefrontRefusal;
  if (code === null) reason = "storefront_missing";
  else if (code !== "invalid" && BLOCKED_STOREFRONT_COUNTRIES.has(code)) reason = "storefront_blocked";
  else return null;
  return errorResponse(403, "REGION_UNAVAILABLE", "Contribution is not available in this region", {
    details: { reason },
  });
}

/** `422 VALIDATION_ERROR` when `storefront_country` is present but not three ASCII letters, else null. */
export function invalidStorefrontCountry(body: Record<string, unknown> | null): Response | null {
  if (readStorefrontCountry(body) !== "invalid") return null;
  return errorResponse(422, "VALIDATION_ERROR", "storefront_country must be an ISO 3166-1 alpha-3 code", {
    details: { field: STOREFRONT_COUNTRY_FIELD },
  });
}
