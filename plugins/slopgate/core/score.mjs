export const SEVERITY_WEIGHTS = {
  block: 15,
  warn: 5,
  info: 1,
};

export const SEVERITY_ORDER = {
  block: 0,
  warn: 1,
  info: 2,
};

export function scoreFindings(findings) {
  const counts = { block: 0, warn: 0, info: 0 };

  for (const finding of findings) {
    if (finding.severity in counts) counts[finding.severity] += 1;
  }

  const deduction =
    counts.block * SEVERITY_WEIGHTS.block +
    counts.warn * SEVERITY_WEIGHTS.warn +
    counts.info * SEVERITY_WEIGHTS.info;

  return {
    counts,
    score: Math.max(0, 100 - deduction),
  };
}

export function compareFindings(a, b) {
  return (
    SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
    a.file.localeCompare(b.file) ||
    a.line - b.line ||
    a.column - b.column ||
    a.rule.localeCompare(b.rule)
  );
}
