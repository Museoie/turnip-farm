import { describe, expect, test } from "bun:test";
import { TokenBucket } from "./ratelimit";

describe("TokenBucket", () => {
  test("allows capacity requests, then refuses until refill", () => {
    let t = 0;
    const b = new TokenBucket(3, 60, () => t);
    expect(b.take("u")).toBe(true);
    expect(b.take("u")).toBe(true);
    expect(b.take("u")).toBe(true);
    expect(b.take("u")).toBe(false);
    // One minute later the bucket is full again (60/min).
    t += 60_000;
    expect(b.take("u")).toBe(true);
  });

  test("keys are independent", () => {
    let t = 0;
    const b = new TokenBucket(1, 60, () => t);
    expect(b.take("a")).toBe(true);
    expect(b.take("a")).toBe(false);
    expect(b.take("b")).toBe(true);
  });

  test("retryAfterSec estimates the wait for the next token", () => {
    let t = 0;
    const b = new TokenBucket(1, 60, () => t);
    expect(b.retryAfterSec("u")).toBe(0);
    expect(b.take("u")).toBe(true);
    expect(b.retryAfterSec("u")).toBe(1);
    t += 30_000;
    expect(b.retryAfterSec("u")).toBe(0);
  });

  test("partial refill accrues proportionally", () => {
    let t = 0;
    const b = new TokenBucket(2, 60, () => t);
    expect(b.take("u")).toBe(true);
    expect(b.take("u")).toBe(true);
    expect(b.take("u")).toBe(false);
    t += 30_000; // half a minute → 30 tokens at 60/min, capped at 2
    expect(b.take("u")).toBe(true);
    expect(b.take("u")).toBe(true);
    expect(b.take("u")).toBe(false);
  });
});
