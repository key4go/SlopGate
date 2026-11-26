import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  HISTORY_DIR,
  HISTORY_FILE,
  getHistoryDir,
  getHistoryPath,
  readEvents,
  recordCheck,
  recordScan,
} from "../core/history.mjs";
import { cleanup, makeRepo } from "./helpers.mjs";

function makeResult(repo, overrides = {}) {
  return {
    root: repo,
    mode: "all",
    counts: { block: 1, warn: 1, info: 0, suppressed: 0 },
    score: 85,
    version: "0.2.0",
    findings: [
      {
        rule: "empty-catch",
        severity: "block",
        file: "src/app.ts",
        line: 3,
        snippet: "try {} catch (e) {}",
        why: "Errors disappear.",
        fix: "Handle or rethrow.",
      },
      {
        rule: "placeholder",
        severity: "warn",
        file: "src/app.ts",
        line: 4,
      },
    ],
    ...overrides,
  };
}

test("recordScan writes a compact event and keeps history out of git", () => {
  const repo = makeRepo();
  try {
    const event = recordScan(makeResult(repo), {
      source: "cli",
      sessionId: "ses_1",
    });

    assert.ok(event);
    assert.equal(event.type, "scan");
    assert.equal(event.source, "cli");
    assert.equal(event.project, repo);
    assert.equal(event.sessionId, "ses_1");
    assert.equal(event.findings.length, 2);
    assert.equal(event.findings[0].snippet, undefined);

    const events = readEvents(repo);
    assert.equal(events.length, 1);
    assert.deepEqual(events[0], event);

    const historyDir = path.join(repo, HISTORY_DIR);
    assert.ok(existsSync(path.join(historyDir, ".gitignore")));
    assert.equal(
      readFileSync(path.join(historyDir, ".gitignore"), "utf8"),
      "*\n",
    );

    const raw = readFileSync(getHistoryPath(repo), "utf8").trim();
    assert.equal(raw.split("\n").length, 1);
    assert.ok(!raw.includes("snippet"));
    assert.ok(raw.includes(HISTORY_FILE) === false);
  } finally {
    cleanup(repo);
  }
});

test("recordCheck stores the action, blocked flag, waiver and session", () => {
  const repo = makeRepo();
  try {
    const event = recordCheck(makeResult(repo), {
      source: "hook",
      action: "handoff",
      blocked: true,
      waived: false,
      sessionId: "ses_2",
    });

    assert.equal(event.type, "check");
    assert.equal(event.action, "handoff");
    assert.equal(event.blocked, true);
    assert.equal(event.waived, false);
    assert.equal(event.sessionId, "ses_2");

    const [stored] = readEvents(repo);
    assert.equal(stored.action, "handoff");
    assert.equal(stored.blocked, true);
  } finally {
    cleanup(repo);
  }
});

test("history can be disabled by option or environment", () => {
  const repo = makeRepo();
  const previous = process.env.SLOPGATE_HISTORY;

  try {
    assert.equal(recordScan(makeResult(repo), { enabled: false }), null);
    assert.equal(existsSync(getHistoryDir(repo)), false);

    process.env.SLOPGATE_HISTORY = "0";
    try {
      assert.equal(recordScan(makeResult(repo)), null);
    } finally {
      if (previous === undefined) delete process.env.SLOPGATE_HISTORY;
      else process.env.SLOPGATE_HISTORY = previous;
    }

    assert.equal(existsSync(getHistoryDir(repo)), false);
  } finally {
    cleanup(repo);
  }
});

test("readEvents skips corrupt lines", () => {
  const repo = makeRepo();
  try {
    recordScan(makeResult(repo), { source: "cli" });
    appendFileSync(
      getHistoryPath(repo),
      'not json\n{"type":"scan","ts":"2026-11-25T00:00:00.000Z"}\n',
    );

    const events = readEvents(repo);
    assert.equal(events.length, 2);
    assert.ok(events.every((event) => event.type));
  } finally {
    cleanup(repo);
  }
});

test("recordScan caps stored findings at 50", () => {
  const repo = makeRepo();
  try {
    const findings = Array.from({ length: 60 }, (_, index) => ({
      rule: "placeholder",
      severity: "warn",
      file: "src/app.ts",
      line: index + 1,
    }));

    const event = recordScan(makeResult(repo, { findings }), {
      source: "cli",
    });

    assert.equal(event.findings.length, 50);
    assert.equal(event.findings[0].line, 1);
    assert.equal(event.findings[49].line, 50);
  } finally {
    cleanup(repo);
  }
});

test("recordScan ignores results without a project root", () => {
  assert.equal(recordScan({ mode: "all" }), null);
  assert.equal(recordCheck({ mode: "all" }), null);
});
