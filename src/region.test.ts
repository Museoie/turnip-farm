// Country backstop (BACKEND_DESIGN.md §7.2, §8).

import { describe, expect, test } from "bun:test";
import {
  BLOCKED_STOREFRONT_COUNTRIES,
  invalidStorefrontCountry,
  readStorefrontCountry,
  refuseStorefront,
} from "./region";

const body = (country: unknown) => ({ storefront_country: country });

async function errorOf(res: Response | null) {
  expect(res).not.toBeNull();
  const json = (await res!.json()) as { error: { code: string; details: unknown } };
  return { status: res!.status, code: json.error.code, details: json.error.details };
}

describe("BLOCKED_STOREFRONT_COUNTRIES", () => {
  test("is exactly the EU 27, ISL, LIE, NOR and GBR", () => {
    expect([...BLOCKED_STOREFRONT_COUNTRIES].sort()).toEqual(
      [
        "AUT", "BEL", "BGR", "HRV", "CYP", "CZE", "DNK", "EST", "FIN", "FRA", "DEU", "GRC", "HUN", "IRL",
        "ITA", "LVA", "LTU", "LUX", "MLT", "NLD", "POL", "PRT", "ROU", "SVK", "SVN", "ESP", "SWE",
        "ISL", "LIE", "NOR",
        "GBR",
      ].sort(),
    );
    // Switzerland is in neither the EU nor the EEA.
    for (const code of ["USA", "KOR", "CHE", "GB", "UK"]) {
      expect(BLOCKED_STOREFRONT_COUNTRIES.has(code)).toBe(false);
    }
  });
});

describe("readStorefrontCountry", () => {
  test("uppercases a three-letter ASCII code", () => {
    expect(readStorefrontCountry(body("gbr"))).toBe("GBR");
    expect(readStorefrontCountry(body("Kor"))).toBe("KOR");
    expect(readStorefrontCountry(body("USA"))).toBe("USA");
  });

  test("null when absent, JSON null, or the body is not an object", () => {
    expect(readStorefrontCountry({})).toBeNull();
    expect(readStorefrontCountry(body(null))).toBeNull();
    expect(readStorefrontCountry(null)).toBeNull();
  });

  test("invalid for anything but three ASCII letters", () => {
    // "ı" and "ß" uppercase to ASCII letters, so the check has to run first.
    for (const value of ["GB", "GBRR", "", "G1R", "123", " GBR", "GBR\n", "ıta", "gß", 826, true, ["GBR"], {}]) {
      expect(readStorefrontCountry(body(value))).toBe("invalid");
    }
  });
});

describe("refuseStorefront", () => {
  test("403 REGION_UNAVAILABLE, reason storefront_blocked, for a blocked storefront, any case", async () => {
    for (const country of ["GBR", "deu", "Nor", "LIE"]) {
      expect(await errorOf(refuseStorefront(body(country)))).toEqual({
        status: 403,
        code: "REGION_UNAVAILABLE",
        details: { reason: "storefront_blocked" },
      });
    }
  });

  test("403 REGION_UNAVAILABLE, reason storefront_missing, when absent, null, or the body is not an object", async () => {
    for (const b of [{}, body(null), null]) {
      expect(await errorOf(refuseStorefront(b))).toEqual({
        status: 403,
        code: "REGION_UNAVAILABLE",
        details: { reason: "storefront_missing" },
      });
    }
  });

  test("null for other storefronts, and for malformed values (answered as 422 later)", () => {
    for (const country of ["USA", "KOR", "CHE", "usa", "GB", "GBRR", 826, false]) {
      expect(refuseStorefront(body(country))).toBeNull();
    }
  });
});

describe("invalidStorefrontCountry", () => {
  test("422 VALIDATION_ERROR naming the field for a malformed value", async () => {
    for (const country of ["GB", "GBRR", "G1R", 826, false]) {
      expect(await errorOf(invalidStorefrontCountry(body(country)))).toEqual({
        status: 422,
        code: "VALIDATION_ERROR",
        details: { field: "storefront_country" },
      });
    }
  });

  test("null for a well-formed code, blocked or not, and an absent or null field", () => {
    for (const country of ["GBR", "usa", null]) {
      expect(invalidStorefrontCountry(body(country))).toBeNull();
    }
    expect(invalidStorefrontCountry({})).toBeNull();
  });
});
