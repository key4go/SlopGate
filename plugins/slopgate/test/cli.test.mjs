import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readEvents } from "../core/history.mjs";
import { cleanup, makeRepo, write } from "./helpers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(here, "..");
const cli = path.join(pluginDir, "cli.mjs");

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: pluginDir,
    encoding: "utf8",
    timeout: 30000,
    env: { ...process.env, SLOPGATE_HISTORY: "1" },
  });
}

test("CLI scan records history and stats reads it", () => {
  const repo = makeRepo();
  try {
    const scan = run(["--cwd", repo, "--json"]);
    assert.equal(scan.status, 0, scan.stderr);

    const result = JSON.parse(scan.stdout);
    assert.equal(result.clean, true);
    assert.equal(readEvents(repo).length, 1);

    const stats = run(["stats", "--cwd", repo, "--json"]);
    assert.equal(stats.status, 0, stats.stderr);

    const statsJson = JSON.parse(stats.stdout);
    assert.equal(statsJson.totals.events, 1);
    assert.equal(statsJson.totals.scans, 1);
    assert.equal(statsJson.project, realpathSync(repo));
  } finally {
    cleanup(repo);
  }
});

test("CLI --no-history leaves no journal behind", () => {
  const repo = makeRepo();
  try {
    const scan = run(["--cwd", repo, "--json", "--no-history"]);
    assert.equal(scan.status, 0, scan.stderr);
    assert.equal(existsSync(path.join(repo, ".slopgate")), false);
    assert.equal(readEvents(repo).length, 0);
  } finally {
    cleanup(repo);
  }
});

test("CLI stats honors --days", () => {
  const repo = makeRepo();
  try {
    assert.equal(run(["--cwd", repo, "--json"]).status, 0);

    const stats = run(["stats", "--cwd", repo, "--days", "7", "--json"]);
    assert.equal(stats.status, 0, stats.stderr);
    assert.equal(JSON.parse(stats.stdout).days, 7);
  } finally {
    cleanup(repo);
  }
});

test("CLI exits 1 on blockers and still records the scan", () => {
  const repo = makeRepo();
  try {
    write(repo, "src/app.ts", `try { risky(); } catch (e) {}\n`);

    const scan = run(["--cwd", repo, "--json"]);
    assert.equal(scan.status, 1, scan.stderr);

    const result = JSON.parse(scan.stdout);
    assert.equal(result.clean, false);
    assert.ok(result.findings.some((item) => item.rule === "empty-catch"));
    assert.equal(readEvents(repo).length, 1);
  } finally {
    cleanup(repo);
  }
});

test("CLI help and version work", () => {
  const version = run(["--version"]);
  assert.equal(version.status, 0);
  assert.match(version.stdout.trim(), /^SlopGate \d+\.\d+\.\d+$/);

  const help = run(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /slopgate dashboard/);
  assert.match(help.stdout, /--no-history/);
});

test("CLI rejects unknown commands with exit 2", () => {
  const result = run(["nope"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unknown command: nope/);
});
