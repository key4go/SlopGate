const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RECENT = 30;

function emptyCounts() {
  return { block: 0, warn: 0, info: 0, suppressed: 0 };
}

function addCounts(target, counts = {}) {
  target.block += Number(counts.block) || 0;
  target.warn += Number(counts.warn) || 0;
  target.info += Number(counts.info) || 0;
  target.suppressed += Number(counts.suppressed) || 0;
}

function localDayKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function startOfLocalDay(date) {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

export function normalizeDays(days) {
  if (days === "all" || days === "All") return "all";
  const value = Number(days);
  if (!Number.isFinite(value) || value <= 0) return 30;
  return Math.min(Math.floor(value), 365);
}

function aggregateFindings(events) {
  const rules = new Map();
  const files = new Map();

  for (const event of events) {
    for (const finding of event.findings ?? []) {
      if (!finding?.rule) continue;

      const rule = rules.get(finding.rule) ?? {
        rule: finding.rule,
        count: 0,
        severity: finding.severity ?? "warn",
      };
      rule.count += 1;
      if (finding.severity === "block") rule.severity = "block";
      else if (finding.severity === "warn" && rule.severity !== "block") {
        rule.severity = "warn";
      }
      rules.set(finding.rule, rule);

      if (!finding.file) continue;
      const file = files.get(finding.file) ?? {
        file: finding.file,
        count: 0,
        block: 0,
        warn: 0,
        info: 0,
      };
      file.count += 1;
      file[finding.severity] = (file[finding.severity] ?? 0) + 1;
      files.set(finding.file, file);
    }
  }

  return {
    topRules: [...rules.values()].sort(
      (a, b) => b.count - a.count || a.rule.localeCompare(b.rule),
    ),
    topFiles: [...files.values()].sort(
      (a, b) => b.count - a.count || a.file.localeCompare(b.file),
    ),
  };
}

function buildDaily(scans, checks, { dayCount, now }) {
  const today = startOfLocalDay(now);
  const start = new Date(today);
  start.setDate(start.getDate() - (dayCount - 1));

  const buckets = new Map();
  const days = [];

  for (let index = 0; index < dayCount; index += 1) {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    const key = localDayKey(date);
    const bucket = {
      date: key,
      block: 0,
      warn: 0,
      info: 0,
      suppressed: 0,
      scans: 0,
      checks: 0,
      blocks: 0,
    };
    buckets.set(key, bucket);
    days.push(bucket);
  }

  for (const scan of scans) {
    const bucket = buckets.get(localDayKey(new Date(scan.ts)));
    if (!bucket) continue;
    bucket.scans += 1;
    addCounts(bucket, scan.counts);
  }

  for (const check of checks) {
    const bucket = buckets.get(localDayKey(new Date(check.ts)));
    if (!bucket) continue;
    bucket.checks += 1;
    if (check.blocked && !check.waived) bucket.blocks += 1;
  }

  return days;
}

function compactEvent(event) {
  const topFinding = event.findings?.[0];

  return {
    id: event.id,
    ts: event.ts,
    type: event.type,
    source: event.source ?? "unknown",
    action: event.action,
    blocked: Boolean(event.blocked),
    waived: Boolean(event.waived),
    score: event.score,
    mode: event.mode,
    counts: event.counts ?? emptyCounts(),
    findingsCount: event.findings?.length ?? 0,
    topRule: topFinding?.rule ?? null,
    topFile: topFinding?.file ?? null,
  };
}

export function buildStats(events, { days = 30, now = new Date() } = {}) {
  const range = normalizeDays(days);
  const chartDays = range === "all" ? 90 : range;

  let since = null;
  if (range !== "all") {
    since = startOfLocalDay(now);
    since.setDate(since.getDate() - (range - 1));
  }

  const filtered = events.filter((event) => {
    const timestamp = new Date(event.ts);
    if (Number.isNaN(timestamp.getTime())) return false;
    return !since || timestamp >= since;
  });

  const scans = filtered.filter((event) => event.type === "scan");
  const checks = filtered.filter((event) => event.type === "check");
  const blockedChecks = checks.filter((event) => event.blocked && !event.waived);
  const waivedChecks = checks.filter((event) => event.waived);
  const cleanChecks = checks.filter((event) => !event.blocked && !event.waived);

  const findings = emptyCounts();
  for (const scan of scans) addCounts(findings, scan.counts);

  const blockedFindings = emptyCounts();
  for (const check of blockedChecks) addCounts(blockedFindings, check.counts);

  const averageScore = scans.length
    ? Math.round(
        scans.reduce((sum, event) => sum + (Number(event.score) || 0), 0) /
          scans.length,
      )
    : null;

  const { topRules, topFiles } = aggregateFindings([...scans, ...blockedChecks]);

  const sources = {};
  for (const event of filtered) {
    const source = event.source ?? "unknown";
    sources[source] = (sources[source] ?? 0) + 1;
  }

  const recent = [...filtered]
    .sort((a, b) => String(b.ts).localeCompare(String(a.ts)))
    .slice(0, MAX_RECENT)
    .map(compactEvent);

  return {
    project: filtered.at(-1)?.project ?? events.at(-1)?.project ?? null,
    generatedAt: new Date().toISOString(),
    days: range,
    chartDays,
    since: since ? since.toISOString() : null,
    totals: {
      events: filtered.length,
      scans: scans.length,
      checks: checks.length,
      blocks: blockedChecks.length,
      waived: waivedChecks.length,
      cleanChecks: cleanChecks.length,
      findings,
      blockedFindings,
      avgScore: averageScore,
    },
    blockRate: checks.length ? blockedChecks.length / checks.length : 0,
    topRules: topRules.slice(0, 8),
    topFiles: topFiles.slice(0, 8),
    daily: buildDaily(scans, checks, { dayCount: chartDays, now }),
    recent,
    sources,
  };
}

function rangeLabel(stats) {
  return stats.days === "all" ? "all time" : `last ${stats.days} days`;
}

export function formatStatsMarkdown(stats) {
  if (!stats.totals.events) {
    return `## SlopGate stats — ${rangeLabel(stats)}\n\nNo SlopGate history yet. Run a scan or let Codex finish a turn.`;
  }

  const { totals } = stats;
  const findings = totals.findings;
  const findingTotal = findings.block + findings.warn + findings.info;
  const topRules = stats.topRules
    .slice(0, 5)
    .map((item) => `${item.rule} (${item.count})`)
    .join(", ");

  return [
    `## SlopGate stats — ${rangeLabel(stats)}`,
    "",
    `- Scans: **${totals.scans}**`,
    `- Handoff checks: **${totals.checks}** (${totals.blocks} blocked, ${totals.cleanChecks} clean${totals.waived ? `, ${totals.waived} waived` : ""})`,
    `- Findings from scans: **${findingTotal}** (${findings.block} block, ${findings.warn} warn, ${findings.info} info)`,
    `- Blockers stopped at the gate: **${totals.blockedFindings.block}**`,
    `- Average scan score: **${totals.avgScore ?? "—"}/100**`,
    topRules ? `- Top rules: ${topRules}` : null,
    `- Project: \`${stats.project ?? "unknown"}\``,
  ]
    .filter(Boolean)
    .join("\n");
}
