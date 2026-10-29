// Public community stats (BACKEND_DESIGN.md §7.3).
// The handler is tested with a stub sql, plus a DB-backed round trip
// (rolled back per db/testing.ts) that runs only when TEST_DATABASE_URL
// names a database.

import { SQL } from "bun";
import { afterAll, describe, expect, test } from "bun:test";
import { TEST_DATABASE_URL, inRollback } from "../db/testing";
import { handleGetStats, type DayCount } from "./stats";

const describeDb = TEST_DATABASE_URL ? describe : describe.skip;
const sharedSql = TEST_DATABASE_URL ? new SQL(TEST_DATABASE_URL) : null;
afterAll(async () => {
  await sharedSql?.end();
});

// Dispatching stub: the totals query has no generate_series; each series
// query joins its own table.
const stubSql = (
  totals: Record<string, number>,
  usersSeries: DayCount[],
  labelsSeries: DayCount[],
) =>
  (async (strings: TemplateStringsArray, ..._values: unknown[]) => {
    const text = strings.join(" ");
    if (text.includes("generate_series")) {
      if (text.includes("JOIN users")) return usersSeries;
      if (text.includes("JOIN labels")) return labelsSeries;
    }
    return [totals];
  }) as unknown as SQL;

const get = () => new Request("http://farm.test/api/stats", { method: "GET" });

describe("handleGetStats", () => {
  test("200 with totals, both series, and Cache-Control", async () => {
    const usersSeries = [
      { date: "2026-10-28", count: 1 },
      { date: "2026-10-29", count: 2 },
    ];
    const labelsSeries = [
      { date: "2026-10-28", count: 0 },
      { date: "2026-10-29", count: 5 },
    ];
    const sql = stubSql(
      { users: 3, sources: 2, clips: 4, labels: 7 },
      usersSeries,
      labelsSeries,
    );
    const res = await handleGetStats(get(), { sql });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("max-age=60");
    const body = (await res.json()) as {
      totals: Record<string, number>;
      users_by_day: DayCount[];
      labels_by_day: DayCount[];
    };
    expect(body.totals).toEqual({ users: 3, sources: 2, clips: 4, labels: 7 });
    expect(body.users_by_day).toEqual(usersSeries);
    expect(body.labels_by_day).toEqual(labelsSeries);
  });

  test("counts are numbers in the body", async () => {
    const sql = stubSql(
      { users: 1, sources: 0, clips: 0, labels: 0 },
      [{ date: "2026-10-29", count: 1 }],
      [{ date: "2026-10-29", count: 0 }],
    );
    const res = await handleGetStats(get(), { sql });
    const body = (await res.json()) as {
      totals: Record<string, number>;
      users_by_day: DayCount[];
      labels_by_day: DayCount[];
    };
    expect(typeof body.totals.users).toBe("number");
    expect(typeof body.users_by_day[0]?.count).toBe("number");
  });
});

describeDb("handleGetStats, DB-backed", () => {
  test("totals count every row; series bucket by UTC day over 90 days", async () => {
    const sql = new SQL(TEST_DATABASE_URL ?? "");
    try {
      await inRollback(sql, async (tx) => {
        // UTC day boundaries: 23:30 UTC yesterday and 00:30 UTC today must
        // land in different buckets, and a row 100 days back must count in
        // the totals but in no bucket.
        const todayMidnight = new Date();
        todayMidnight.setUTCHours(0, 0, 0, 0);
        const t = (ms: number) => new Date(todayMidnight.getTime() + ms).toISOString();
        const yesterdayLate = t(-30 * 60 * 1000);
        const todayEarly = t(30 * 60 * 1000);
        const old = t(-100 * 24 * 3600 * 1000);
        const todayDate = todayMidnight.toISOString().slice(0, 10);
        const yesterdayDate = new Date(todayMidnight.getTime() - 24 * 3600 * 1000)
          .toISOString()
          .slice(0, 10);

        const vid = (ch: string) => ch.repeat(64);
        await tx`INSERT INTO users (id, created_at) VALUES
          ('u-today', ${todayEarly}::timestamptz),
          ('u-yesterday', ${yesterdayLate}::timestamptz),
          ('u-old', ${old}::timestamptz)`;
        await tx`INSERT INTO sources (id, source_key_hash, frame_count, sample_rate, r2_key, created_at)
          VALUES (${vid("a")}, ${vid("b")}, 100, 30, 'poses/x.tkp1.gz', ${todayEarly}::timestamptz)`;
        const [clip] = (await tx`INSERT INTO clips (id, source_id, start_frame, end_frame, created_at)
          VALUES ('123e4567-e89b-42d3-a456-426614174001', ${vid("a")}, 0, 10, ${todayEarly}::timestamptz)
          RETURNING id`) as { id: string }[];
        if (!clip) throw new Error("seed clip insert returned no row");
        await tx`INSERT INTO labels (clip_id, trick_name, taxonomy_version, origin, created_at) VALUES
          (${clip.id}, 'cork', 1, 'typed', ${todayEarly}::timestamptz),
          (${clip.id}, 'gainer', 1, 'typed', ${yesterdayLate}::timestamptz),
          (${clip.id}, 'hook', 1, 'typed', ${old}::timestamptz)`;

        const res = await handleGetStats(get(), { sql: tx as unknown as SQL });
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          totals: Record<string, number>;
          users_by_day: DayCount[];
          labels_by_day: DayCount[];
        };
        expect(body.totals).toEqual({ users: 3, sources: 1, clips: 1, labels: 3 });

        for (const series of [body.users_by_day, body.labels_by_day]) {
          expect(series).toHaveLength(90);
          const first = series[0];
          const last = series[series.length - 1];
          if (!first || !last) throw new Error("series is empty");
          expect(first.date).toBe(
            new Date(todayMidnight.getTime() - 89 * 24 * 3600 * 1000).toISOString().slice(0, 10),
          );
          expect(last.date).toBe(todayDate);
          const dates = series.map((d) => d.date);
          expect([...dates].sort()).toEqual(dates);
          expect(dates.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))).toBe(true);
        }
        const usersByDate = Object.fromEntries(body.users_by_day.map((d) => [d.date, d.count]));
        const labelsByDate = Object.fromEntries(body.labels_by_day.map((d) => [d.date, d.count]));
        expect(usersByDate[todayDate]).toBe(1);
        expect(usersByDate[yesterdayDate]).toBe(1);
        expect(labelsByDate[todayDate]).toBe(1);
        expect(labelsByDate[yesterdayDate]).toBe(1);
        expect(body.users_by_day.reduce((s, d) => s + d.count, 0)).toBe(2);
        expect(body.labels_by_day.reduce((s, d) => s + d.count, 0)).toBe(2);
      });
    } finally {
      await sql.end();
    }
  });
});
