import test from "node:test";
import assert from "node:assert/strict";
import {
  buildStats,
  formatStatsMarkdown,
  normalizeDays,
} from "../core/stats.mjs";

const now = new Date(2026, 10, 25, 12, 0, 0);

function ts(daysAgo, hour = 12) {
  const date = new Date(now);
  date.setDate(date.getDate() - daysAgo);
  date.setHours(hour, 0, 0, 0);
  return date.toISOString();
}

function makeEvents() {
  return [
    {
      v: 1,
      id: "scan-1",
      ts: ts(0),
      type: "scan",
      source: "cli",
      project: "/project",
      mode: "all",
      counts: { block: 2, warn: 1, info: 0, suppressed: 1 },
      score: 70,
      version: "0.2.0",
      findings: [
        {
          rule: "empty-catch",
          severity: "block",
          file: "src/a.ts",
          line: 1,
        },
        {
          rule: "empty-catch",
          severity: "block",
          file: "src/a.ts",
          line: 2,
        },
        {
          rule: "placeholder",
          severity: "warn",
          file: "src/b.ts",
          line: 3,
        },
      ],
    },
    {
      v: 1,
      id: "check-1",
      ts: ts(0, 13),
      type: "check",
      source: "hook",
      project: "/project",
      mode: "all",
      counts: { block: 2, warn: 1, info: 0, suppressed: 1 },
      score: 70,
      version: "0.2.0",
      action: "handoff",
      blocked: true,
      waived: false,
      findings: [
        {
          rule: "empty-catch",
          severity: "block",
          file: "src/a.ts",
          line: 1,
        },
        {
          rule: "empty-catch",
          severity: "block",
          file: "src/a.ts",
          line: 2,
        },
        {
          rule: "placeholder",
          severity: "warn",
          file: "src/b.ts",
          line: 3,
        },
      ],
    },
    {
      v: 1,
      id: "check-2",
      ts: ts(1),
      type: "check",
      source: "hook",
      project: "/project",
      mode: "all",
      counts: { block: 0, warn: 0, info: 0, suppressed: 0 },
      score: 100,
      version: "0.2.0",
      action: "commit",
      blocked: false,
      waived: false,
      findings: [],
    },
    {
      v: 1,
      id: "check-3",
      ts: ts(2),
      type: "check",
      source: "hook",
      project: "/project",
      mode: "all",
      counts: { block: 1, warn: 0, info: 0, suppressed: 0 },
      score: 85,
      version: "0.2.0",
      action: "handoff",
      blocked: true,
      waived: true,
      findings: [
        {
          rule: "empty-catch",
          severity: "block",
          file: "src/a.ts",
          line: 1,
        },
      ],
    },
    {
      v: 1,
      id: "old-scan",
      ts: ts(40),
      type: "scan",
      source: "mcp",
      project: "/project",
      mode: "all",
      counts: { block: 0, warn: 0, info: 1, suppressed: 0 },
      score: 90,
      version: "0.2.0",
      findings: [
        {
          rule: "debug-leftover",
          severity: "info",
          file: "src/old.ts",
          line: 9,
        },
      ],
    },
  ];
}

function dayKey(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

test("normalizeDays accepts all, numbers, and clamps", () => {
  assert.equal(normalizeDays("all"), "all");
  assert.equal(normalizeDays("All"), "all");
  assert.equal(normalizeDays("7"), 7);
  assert.equal(normalizeDays(0), 30);
  assert.equal(normalizeDays(-1), 30);
  assert.equal(normalizeDays("nope"), 30);
  assert.equal(normalizeDays(1000), 365);
});

test("buildStats aggregates a 30-day window", () => {
  const stats = buildStats(makeEvents(), { days: 30, now });

  assert.equal(stats.project, "/project");
  assert.equal(stats.days, 30);
  assert.equal(stats.chartDays, 30);
  assert.ok(stats.since);
  assert.equal(stats.daily.length, 30);

  assert.equal(stats.totals.events, 4);
  assert.equal(stats.totals.scans, 1);
  assert.equal(stats.totals.checks, 3);
  assert.equal(stats.totals.blocks, 1);
  assert.equal(stats.totals.waived, 1);
  assert.equal(stats.totals.cleanChecks, 1);
  assert.deepEqual(stats.totals.findings, {
    block: 2,
    warn: 1,
    info: 0,
    suppressed: 1,
  });
  assert.deepEqual(stats.totals.blockedFindings, {
    block: 2,
    warn: 1,
    info: 0,
    suppressed: 1,
  });
  assert.equal(stats.totals.avgScore, 70);
  assert.equal(stats.blockRate, 1 / 3);

  assert.equal(stats.topRules[0].rule, "empty-catch");
  assert.equal(stats.topRules[0].count, 4);
  assert.equal(stats.topRules[1].rule, "placeholder");
  assert.equal(stats.topRules[1].count, 2);
  assert.equal(stats.topFiles[0].file, "src/a.ts");
  assert.equal(stats.topFiles[0].block, 4);
  assert.equal(stats.topFiles[1].file, "src/b.ts");
  assert.equal(stats.topFiles[1].warn, 2);

  assert.deepEqual(stats.sources, { cli: 1, hook: 3 });
  assert.equal(stats.recent.length, 4);
  assert.equal(stats.recent[0].id, "check-1");

  const scanned = stats.recent.find((event) => event.id === "scan-1");
  assert.equal(scanned.findingsCount, 3);
  assert.equal(scanned.topRule, "empty-catch");
  assert.equal(scanned.topFile, "src/a.ts");

  const today = stats.daily.at(-1);
  assert.equal(today.date, dayKey(now));
  assert.equal(today.scans, 1);
  assert.equal(today.checks, 1);
  assert.equal(today.blocks, 1);
  assert.equal(today.block, 2);
  assert.equal(today.warn, 1);
  assert.equal(today.suppressed, 1);

  assert.equal(stats.daily.at(-2).checks, 1);
  assert.equal(stats.daily.at(-2).blocks, 0);
  assert.equal(stats.daily.at(-3).checks, 1);
  assert.equal(stats.daily.at(-3).blocks, 0);
});

test("buildStats supports all-time totals with a 90-day chart", () => {
  const stats = buildStats(makeEvents(), { days: "all", now });

  assert.equal(stats.days, "all");
  assert.equal(stats.chartDays, 90);
  assert.equal(stats.since, null);
  assert.equal(stats.daily.length, 90);
  assert.equal(stats.totals.events, 5);
  assert.equal(stats.totals.scans, 2);
  assert.equal(stats.totals.checks, 3);
  assert.equal(stats.totals.avgScore, 80);
  assert.ok(stats.topRules.some((item) => item.rule === "debug-leftover"));
});

test("formatStatsMarkdown handles empty and populated stats", () => {
  const empty = formatStatsMarkdown({
    days: 30,
    totals: { events: 0 },
  });
  assert.match(empty, /No SlopGate history yet/);

  const markdown = formatStatsMarkdown(
    buildStats(makeEvents(), { days: "all", now }),
  );
  assert.match(markdown, /SlopGate stats — all time/);
  assert.match(markdown, /Scans: \*\*2\*\*/);
  assert.match(markdown, /Handoff checks: \*\*3\*\* \(1 blocked, 1 clean, 1 waived\)/);
  assert.match(markdown, /Blockers stopped at the gate: \*\*2\*\*/);
  assert.match(markdown, /Average scan score: \*\*80\/100\*\*/);
  assert.match(markdown, /Top rules: empty-catch \(4\)/);
});
