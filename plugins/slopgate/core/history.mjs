import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export const HISTORY_DIR = ".slopgate";
export const HISTORY_FILE = "events.jsonl";
export const HISTORY_VERSION = 1;

const MAX_FINDINGS = 50;

export function isHistoryEnabled(options = {}) {
  if (options.enabled === false) return false;
  if (process.env.SLOPGATE_HISTORY === "0") return false;
  return true;
}

export function getHistoryDir(projectRoot) {
  return path.join(projectRoot, HISTORY_DIR);
}

export function getHistoryPath(projectRoot) {
  return path.join(getHistoryDir(projectRoot), HISTORY_FILE);
}

function ensureHistoryDir(projectRoot) {
  const dir = getHistoryDir(projectRoot);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const ignorePath = path.join(dir, ".gitignore");
  if (!existsSync(ignorePath)) {
    writeFileSync(ignorePath, "*\n", { mode: 0o600 });
  }

  return dir;
}

function compactFinding(finding) {
  return {
    rule: finding.rule,
    severity: finding.severity,
    file: finding.file,
    line: finding.line,
    ...(finding.column ? { column: finding.column } : {}),
  };
}

function buildEvent(result, type, source, extra = {}) {
  return {
    v: HISTORY_VERSION,
    id: randomUUID(),
    ts: new Date().toISOString(),
    type,
    source,
    project: result.root,
    mode: result.mode,
    counts: result.counts,
    score: result.score,
    version: result.version,
    findings: (result.findings ?? []).slice(0, MAX_FINDINGS).map(compactFinding),
    ...extra,
  };
}

function appendEvent(projectRoot, event) {
  ensureHistoryDir(projectRoot);
  appendFileSync(getHistoryPath(projectRoot), `${JSON.stringify(event)}\n`, {
    mode: 0o600,
  });
  return event;
}

export function recordScan(result, options = {}) {
  if (!isHistoryEnabled(options)) return null;
  if (!result?.root) return null;

  try {
    return appendEvent(
      result.root,
      buildEvent(result, "scan", options.source ?? "cli", {
        sessionId: options.sessionId,
      }),
    );
  } catch {
    return null;
  }
}

export function recordCheck(result, options = {}) {
  if (!isHistoryEnabled(options)) return null;
  if (!result?.root) return null;

  try {
    return appendEvent(
      result.root,
      buildEvent(result, "check", options.source ?? "hook", {
        action: options.action ?? "stop",
        blocked: Boolean(options.blocked),
        waived: Boolean(options.waived),
        sessionId: options.sessionId,
      }),
    );
  } catch {
    return null;
  }
}

export function readEvents(projectRoot) {
  const file = getHistoryPath(projectRoot);
  if (!existsSync(file)) return [];

  const raw = readFileSync(file, "utf8");
  const events = [];

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;

    try {
      const event = JSON.parse(line);
      if (event && typeof event === "object" && event.type) {
        events.push(event);
      }
    } catch {
      // A corrupt line should not make the whole journal unreadable.
    }
  }

  return events.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
}
