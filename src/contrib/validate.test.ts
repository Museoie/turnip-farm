import { describe, expect, test } from "bun:test";
import { dedupeLabelNames, isSourceKey, isUuid, isVideoId } from "./validate";

describe("request validators", () => {
  test("video ids are 64-char lowercase hex", () => {
    expect(isVideoId("a".repeat(64))).toBe(true);
    expect(isVideoId("A".repeat(64))).toBe(false);
    expect(isVideoId("a".repeat(63))).toBe(false);
    expect(isVideoId("g".repeat(64))).toBe(false);
    expect(isVideoId(42)).toBe(false);
  });

  test("source keys are 43-char base64url without padding", () => {
    expect(isSourceKey("a".repeat(43))).toBe(true);
    expect(isSourceKey("A-_".repeat(14) + "A")).toBe(true);
    expect(isSourceKey("a".repeat(44))).toBe(false);
    expect(isSourceKey("a".repeat(42) + "=")).toBe(false);
    expect(isSourceKey("a".repeat(42) + "+")).toBe(false);
  });

  test("clip ids are uuids", () => {
    expect(isUuid("123e4567-e89b-42d3-a456-426614174000")).toBe(true);
    expect(isUuid("not-a-uuid")).toBe(false);
  });
});

describe("dedupeLabelNames", () => {
  test("trims, drops blanks, collapses case-insensitive dupes", () => {
    expect(dedupeLabelNames([" cork ", "CORK", "", "   ", "gainer"])).toEqual([
      "CORK",
      "gainer",
    ]);
  });

  test("keeps the alphabetically-first casing per group", () => {
    // Mirrors DISTINCT ON (lower(trim(name))) ORDER BY lower(trim(name)),
    // trim(name): "Cork" < "cork" in both C collation and UTF-16 order.
    expect(dedupeLabelNames(["cork", "Cork"])).toEqual(["Cork"]);
  });

  test("preserves first-seen order", () => {
    expect(dedupeLabelNames(["hook", "scoot", "gainer", "cartfull"])).toEqual([
      "hook",
      "scoot",
      "gainer",
      "cartfull",
    ]);
  });

  test("ignores non-strings and non-arrays", () => {
    expect(dedupeLabelNames([42, null, "cork"])).toEqual(["cork"]);
    expect(dedupeLabelNames("cork")).toEqual([]);
    expect(dedupeLabelNames(undefined)).toEqual([]);
  });
});
