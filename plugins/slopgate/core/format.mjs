const SEVERITY_LABELS = {
  block: "BLOCK",
  warn: "WARN",
  info: "INFO",
};

function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function truncate(value, max = 180) {
  const text = String(value).replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function addedLineCount(result) {
  if (typeof result.addedLines === "number") return result.addedLines;
  return result.files.reduce((total, file) => total + (file.addedLines ?? 0), 0);
}

function countSummary(result) {
  const parts = [];
  if (result.counts.block > 0) parts.push(plural(result.counts.block, "blocker"));
  if (result.counts.warn > 0) parts.push(plural(result.counts.warn, "warning"));
  if (result.counts.info > 0) parts.push(plural(result.counts.info, "info"));
  if (result.counts.suppressed > 0) {
    parts.push(`${plural(result.counts.suppressed, "suppression")}`);
  }
  return parts.length > 0 ? parts.join(" · ") : "no findings";
}

export function formatMarkdown(result, { maxFindings = 20 } = {}) {
  const lines = [];
  const added = addedLineCount(result);

  lines.push(
    `SlopGate ${result.version} · ${result.mode} · ${plural(result.files.length, "file")} · +${added}`,
  );
  lines.push(`${countSummary(result)} · score ${result.score}/100`);
  lines.push("");

  if (result.findings.length === 0) {
    lines.push(added === 0 ? "No added lines to scan." : "No findings. Clean.");
    return lines.join("\n");
  }

  const shown = result.findings.slice(0, maxFindings);
  for (const finding of shown) {
    lines.push(
      `${SEVERITY_LABELS[finding.severity]}  ${finding.file}:${finding.line}  ${finding.rule}`,
    );
    lines.push(`       ${truncate(finding.snippet, 160)}`);
    lines.push(`       Why: ${finding.why}`);
    lines.push(`       Fix: ${finding.fix}`);
    lines.push("");
  }

  if (result.findings.length > shown.length) {
    lines.push(
      `…and ${result.findings.length - shown.length} more finding(s). Run \`slopgate scan --json\` for the full list.`,
    );
    lines.push("");
  }

  lines.push(
    result.counts.block > 0
      ? "Next: fix the blockers, then re-run the scan."
      : "Next: review the warnings; suppress only with a written reason.",
  );

  return lines.join("\n");
}

export function formatHookReason(result, { maxFindings = 5 } = {}) {
  const blockers = result.findings
    .filter((finding) => finding.severity === "block")
    .slice(0, maxFindings);

  const lines = [
    `SlopGate found ${plural(result.counts.block, "blocker")}. Fix before finishing:`,
  ];

  blockers.forEach((finding, index) => {
    lines.push(
      `${index + 1}. ${finding.file}:${finding.line} [${finding.rule}] ${finding.title ?? finding.rule}`,
    );
    lines.push(`   Why: ${truncate(finding.why, 240)}`);
    lines.push(`   Fix: ${truncate(finding.fix, 240)}`);
  });

  if (result.counts.block > blockers.length) {
    lines.push(
      `…and ${result.counts.block - blockers.length} more blocker(s). Run the scan for the full list.`,
    );
  }

  lines.push("");
  lines.push(
    "Do not suppress without a written reason. Re-run the scan after fixing.",
  );

  return lines.join("\n");
}

export function formatRulesMarkdown(rules) {
  const lines = ["SlopGate rules:", ""];

  for (const rule of rules) {
    lines.push(`${rule.severity.toUpperCase()}  ${rule.id} — ${rule.title}`);
    lines.push(`       Why: ${rule.why}`);
    lines.push(`       Fix: ${rule.fix}`);
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

export function formatJson(result) {
  return JSON.stringify(result, null, 2);
}
