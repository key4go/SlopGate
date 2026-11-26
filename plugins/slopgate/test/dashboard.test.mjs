import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startDashboard } from "../dashboard/server.mjs";
import { recordCheck, recordScan } from "../core/history.mjs";
import { cleanup, makeRepo } from "./helpers.mjs";

function makeResult(repo) {
  return {
    root: repo,
    mode: "all",
    counts: { block: 1, warn: 1, info: 0, suppressed: 0 },
    score: 80,
    version: "0.2.0",
    findings: [
      {
        rule: "empty-catch",
        severity: "block",
        file: "src/app.ts",
        line: 3,
      },
      {
        rule: "placeholder",
        severity: "warn",
        file: "src/app.ts",
        line: 4,
      },
    ],
  };
}

test("dashboard serves health, stats, HTML and history", async () => {
  const repo = makeRepo();
  let dashboard;

  try {
    dashboard = await startDashboard({ cwd: repo, port: 0 });
    assert.match(dashboard.url, /^http:\/\/127\.0\.0\.1:\d+$/);

    const health = await fetch(`${dashboard.url}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    const emptyResponse = await fetch(`${dashboard.url}/api/stats?days=7`);
    assert.equal(emptyResponse.status, 200);
    const empty = await emptyResponse.json();
    assert.equal(empty.days, 7);
    assert.equal(empty.daily.length, 7);
    assert.equal(empty.totals.events, 0);
    assert.equal(empty.project, null);

    const result = makeResult(repo);
    recordScan(result, { source: "cli" });
    recordCheck(result, {
      source: "hook",
      action: "handoff",
      blocked: true,
    });

    const statsResponse = await fetch(`${dashboard.url}/api/stats?days=30`);
    assert.equal(statsResponse.status, 200);
    const stats = await statsResponse.json();
    assert.equal(stats.totals.events, 2);
    assert.equal(stats.totals.scans, 1);
    assert.equal(stats.totals.checks, 1);
    assert.equal(stats.totals.blocks, 1);
    assert.equal(stats.totals.findings.block, 1);
    assert.equal(stats.project, repo);

    const allResponse = await fetch(`${dashboard.url}/api/stats?days=all`);
    const all = await allResponse.json();
    assert.equal(all.days, "all");
    assert.equal(all.daily.length, 90);

    const page = await fetch(`${dashboard.url}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type"), /text\/html/);
    const html = await page.text();
    assert.match(html, /SlopGate/);
    assert.match(html, /\/api\/stats/);

    const missing = await fetch(`${dashboard.url}/nope`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: "Not found" });

    const post = await fetch(`${dashboard.url}/api/stats`, { method: "POST" });
    assert.equal(post.status, 405);
    assert.equal(await post.text(), "Method not allowed");
  } finally {
    if (dashboard) await dashboard.close();
    cleanup(repo);
  }
});

test("dashboard retries when the requested port is taken", async () => {
  const repo = makeRepo();
  const blocker = http.createServer((request, response) => {
    response.end("blocked");
  });
  let dashboard;

  try {
    await new Promise((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(0, "127.0.0.1", resolve);
    });

    const blockedPort = blocker.address().port;
    dashboard = await startDashboard({ cwd: repo, port: blockedPort });

    assert.notEqual(dashboard.port, blockedPort);
    const health = await fetch(`${dashboard.url}/health`);
    assert.equal(health.status, 200);
  } finally {
    if (dashboard) await dashboard.close();
    await new Promise((resolve) => blocker.close(resolve));
    cleanup(repo);
  }
});
