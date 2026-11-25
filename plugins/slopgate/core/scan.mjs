import { createHash } from "node:crypto";
import path from "node:path";
import {
  getDiffText,
  getFileChange,
  getRepoRoot,
  getUntrackedFiles,
  isScannablePath,
  isTestPath,
  normalizeRelPath,
  pathIsInside,
  readFileForChange,
  rightSideOfRange,
} from "./git.mjs";
import { parseUnifiedDiff } from "./diff.mjs";
import { RULES, findSuppression } from "./rules.mjs";
import { compareFindings, scoreFindings } from "./score.mjs";
import { SlopGateError } from "./errors.mjs";
import { VERSION } from "./version.mjs";

function truncate(value, max = 180) {
  const text = String(value).replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function addChange(changeMap, change) {
  const normalized = normalizeRelPath(change.path);
  const existing = changeMap.get(normalized);

  if (!existing) {
    changeMap.set(normalized, {
      ...change,
      path: normalized,
      added: [...change.added],
    });
    return;
  }

  const seen = new Set(existing.added.map((entry) => entry.line));
  for (const entry of change.added) {
    if (seen.has(entry.line)) continue;
    seen.add(entry.line);
    existing.added.push(entry);
  }

  if (change.status === "added" || change.status === "renamed") {
    existing.status = change.status;
  }
}

function makeFinding(rule, change, raw, lines) {
  const line = Number(raw.line);
  const column = Number(raw.column) || 1;
  const snippet = truncate(raw.snippet ?? lines[line - 1] ?? "");
  const severity = raw.severity ?? rule.severity;

  return {
    id: createHash("sha1")
      .update(`${rule.id}\0${change.path}\0${line}\0${column}\0${snippet}`)
      .digest("hex")
      .slice(0, 12),
    rule: rule.id,
    title: raw.title ?? rule.title,
    severity,
    file: change.path,
    line,
    column,
    snippet,
    why: raw.why ?? rule.why,
    fix: raw.fix ?? rule.fix,
  };
}

function normalizeFilter(root, value) {
  const absolute = path.resolve(root, value);
  if (pathIsInside(root, absolute)) {
    return path.relative(root, absolute).replaceAll("\\", "/");
  }
  return normalizeRelPath(value);
}

function buildResult({
  root,
  mode,
  changes,
  fileResults,
  findings,
  suppressedCount,
}) {
  const { counts, score } = scoreFindings(findings);
  const addedLines = changes.reduce(
    (total, change) => total + change.added.length,
    0,
  );

  let summary;
  if (addedLines === 0) {
    summary = "No added lines to scan.";
  } else if (counts.block > 0) {
    summary = `${plural(counts.block, "blocker")}, ${plural(counts.warn, "warning")}, score ${score}/100`;
  } else if (counts.warn > 0 || counts.info > 0) {
    summary = `No blockers, ${plural(counts.warn, "warning")}, score ${score}/100`;
  } else {
    summary = `No blockers, score ${score}/100`;
  }

  return {
    schemaVersion: 1,
    tool: "slopgate",
    version: VERSION,
    root,
    mode,
    generatedAt: new Date().toISOString(),
    addedLines,
    files: fileResults,
    findings,
    counts: {
      ...counts,
      suppressed: suppressedCount,
    },
    score,
    clean: counts.block === 0,
    summary,
  };
}

async function scanChanges({ root, mode, changes, rangeRef }) {
  const findings = [];
  const fileResults = [];
  let suppressedCount = 0;

  for (const change of changes) {
    const source =
      mode === "staged" ? "index" : mode === "range" ? "ref" : "worktree";

    const file = await readFileForChange(root, change.path, {
      source,
      ref: rangeRef ?? "HEAD",
    });

    if (!file) continue;

    const addedLines = new Set(change.added.map((entry) => Number(entry.line)));
    if (addedLines.size === 0) continue;

    const isTest = isTestPath(change.path);
    const fileFindings = [];

    for (const rule of RULES) {
      let rawFindings;
      try {
        rawFindings = rule.detect({
          path: change.path,
          lines: file.lines,
          text: file.text,
          isTest,
          addedLines,
        });
      } catch {
        continue;
      }

      if (!Array.isArray(rawFindings)) continue;

      for (const raw of rawFindings) {
        const line = Number(raw.line);
        if (!Number.isFinite(line) || !addedLines.has(line)) continue;

        const finding = makeFinding(rule, change, raw, file.lines);
        const reason = findSuppression(file.lines, line, rule.id);
        if (reason) {
          suppressedCount += 1;
          continue;
        }

        fileFindings.push(finding);
      }
    }

    const seen = new Set();
    const unique = fileFindings
      .filter((finding) => {
        const key = `${finding.rule}:${finding.line}:${finding.column}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort(compareFindings);

    findings.push(...unique);
    fileResults.push({
      path: change.path,
      status: change.status,
      addedLines: change.added.length,
      findings: unique,
    });
  }

  fileResults.sort((a, b) => a.path.localeCompare(b.path));
  findings.sort(compareFindings);

  return buildResult({
    root,
    mode,
    changes,
    fileResults,
    findings,
    suppressedCount,
  });
}

/**
 * Scan the current diff in a git repository.
 *
 * @param {object} options
 * @param {string} [options.cwd]
 * @param {"all"|"staged"|"unstaged"|"range"|"file"} [options.mode]
 * @param {string} [options.range]
 * @param {string[]} [options.paths]
 */
export async function scan({
  cwd = process.cwd(),
  mode = "all",
  range,
  paths = [],
} = {}) {
  const root = await getRepoRoot(cwd);
  if (!root) {
    throw new SlopGateError(
      "SlopGate needs a git repository. Run `git init` in the project, then try again.",
      "NOT_A_REPO",
    );
  }

  if (mode === "file") {
    if (!Array.isArray(paths) || paths.length !== 1) {
      throw new SlopGateError(
        "Scan mode 'file' requires exactly one path in `paths`.",
        "INVALID_PATH",
      );
    }
    return scanFile({ cwd: root, path: paths[0] });
  }

  if (!["all", "staged", "unstaged", "range"].includes(mode)) {
    throw new SlopGateError(`Unknown scan mode: ${mode}`, "INVALID_MODE");
  }

  const diffText = await getDiffText(root, mode, { range });
  const changeMap = new Map();

  for (const change of parseUnifiedDiff(diffText)) {
    if (!isScannablePath(change.path)) continue;
    addChange(changeMap, change);
  }

  if (mode === "all") {
    for (const relPath of await getUntrackedFiles(root)) {
      if (!isScannablePath(relPath)) continue;
      const change = await getFileChange(root, relPath);
      if (change) addChange(changeMap, change);
    }
  }

  let changes = [...changeMap.values()];
  const filters = (Array.isArray(paths) ? paths : [])
    .map((value) => normalizeFilter(root, value))
    .filter(Boolean);

  if (filters.length > 0) {
    changes = changes.filter((change) =>
      filters.some(
        (filter) =>
          change.path === filter ||
          change.path.startsWith(`${filter.replace(/\/+$/, "")}/`),
      ),
    );
  }

  const rangeRef = mode === "range" ? rightSideOfRange(range) : null;

  return scanChanges({
    root,
    mode,
    changes,
    rangeRef,
  });
}

/**
 * Scan one file as if every line were newly added.
 */
export async function scanFile({ cwd = process.cwd(), path: filePath } = {}) {
  const root = await getRepoRoot(cwd);
  if (!root) {
    throw new SlopGateError(
      "SlopGate needs a git repository. Run `git init` in the project, then try again.",
      "NOT_A_REPO",
    );
  }

  if (!filePath) {
    throw new SlopGateError("A file path is required.", "INVALID_PATH");
  }

  const absolute = path.resolve(root, filePath);
  if (!pathIsInside(root, absolute)) {
    throw new SlopGateError(
      `Refusing to scan a file outside the repository: ${filePath}`,
      "INVALID_PATH",
    );
  }

  const relPath = path.relative(root, absolute).replaceAll("\\", "/");
  if (!isScannablePath(relPath)) {
    throw new SlopGateError(
      `SlopGate does not scan this file type: ${relPath}`,
      "UNSUPPORTED_FILE",
    );
  }

  const change = await getFileChange(root, relPath);
  if (!change) {
    throw new SlopGateError(
      `Could not read ${relPath}; it may be binary or larger than 1 MB.`,
      "FILE_NOT_READABLE",
    );
  }

  change.status = "file";

  return scanChanges({
    root,
    mode: "file",
    changes: [change],
    rangeRef: null,
  });
}
