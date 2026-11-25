import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  cleanup,
  git,
  makeEmptyDir,
  makeRepo,
  write,
} from "./helpers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(here, "..");

function runHook(name, input) {
  const result = spawnSync(
    process.execPath,
    [path.join(pluginDir, "scripts", name)],
    {
      cwd: pluginDir,
      input: JSON.stringify(input),
      encoding: "utf8",
      timeout: 30000,
    },
  );

  return {
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    status: result.status,
  };
}

test("Stop hook blocks once when blockers are present", () => {
  const repo = makeRepo();
  try {
    write(repo, "src/app.ts", `try { risky(); } catch (e) {}\n`);

    const output = runHook("stop-check.mjs", {
      cwd: repo,
      hook_event_name: "Stop",
      stop_hook_active: false,
    });

    const payload = JSON.parse(output.stdout);
    assert.equal(payload.decision, "block");
    assert.match(payload.reason, /empty-catch/);
    assert.match(payload.reason, /src\/app\.ts:1/);
  } finally {
    cleanup(repo);
  }
});

test("Stop hook allows completion after a continuation", () => {
  const repo = makeRepo();
  try {
    write(repo, "src/app.ts", `try { risky(); } catch (e) {}\n`);

    const output = runHook("stop-check.mjs", {
      cwd: repo,
      hook_event_name: "Stop",
      stop_hook_active: true,
    });

    const payload = JSON.parse(output.stdout);
    assert.equal(payload.decision, undefined);
    assert.match(payload.systemMessage, /allowing completion/);
  } finally {
    cleanup(repo);
  }
});

test("Stop hook is silent on a clean diff", () => {
  const repo = makeRepo();
  try {
    const output = runHook("stop-check.mjs", {
      cwd: repo,
      hook_event_name: "Stop",
      stop_hook_active: false,
    });

    assert.equal(output.stdout, "");
  } finally {
    cleanup(repo);
  }
});

test("Stop hook fails open outside a git repository", () => {
  const emptyDir = makeEmptyDir();
  try {
    const output = runHook("stop-check.mjs", {
      cwd: emptyDir,
      hook_event_name: "Stop",
      stop_hook_active: false,
    });

    assert.equal(output.stdout, "");
    assert.match(output.stderr, /scan skipped/);
  } finally {
    cleanup(emptyDir);
  }
});

test("git guard denies a commit with staged blockers", () => {
  const repo = makeRepo();
  try {
    write(repo, "src/app.ts", `try { risky(); } catch (e) {}\n`);
    git(repo, "add", "src/app.ts");

    const output = runHook("git-guard.mjs", {
      cwd: repo,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "git commit -m 'check this'" },
    });

    const payload = JSON.parse(output.stdout);
    assert.equal(payload.hookSpecificOutput.permissionDecision, "deny");
    assert.match(payload.hookSpecificOutput.permissionDecisionReason, /commit/);
    assert.match(
      payload.hookSpecificOutput.permissionDecisionReason,
      /empty-catch/,
    );
  } finally {
    cleanup(repo);
  }
});

test("git guard ignores non-git commands and quoted text", () => {
  const repo = makeRepo();
  try {
    for (const command of [
      'echo "git commit"',
      "git status",
      "git commit --help",
      "git push --dry-run",
    ]) {
      const output = runHook("git-guard.mjs", {
        cwd: repo,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command },
      });

      assert.equal(output.stdout, "", `unexpected output for: ${command}`);
    }
  } finally {
    cleanup(repo);
  }
});

test("git guard allows a commit with no blockers", () => {
  const repo = makeRepo();
  try {
    write(repo, "src/app.ts", "export const fine = true;\n");
    git(repo, "add", "src/app.ts");

    const output = runHook("git-guard.mjs", {
      cwd: repo,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "git commit -m 'clean change'" },
    });

    assert.equal(output.stdout, "");
  } finally {
    cleanup(repo);
  }
});

test("git guard denies a push containing a sloppy commit", () => {
  const repo = makeRepo();
  try {
    write(repo, "src/app.ts", `try { risky(); } catch (e) {}\n`);
    git(repo, "add", "src/app.ts");
    git(repo, "commit", "-qm", "sloppy change");

    const output = runHook("git-guard.mjs", {
      cwd: repo,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "git push origin main" },
    });

    const payload = JSON.parse(output.stdout);
    assert.equal(payload.hookSpecificOutput.permissionDecision, "deny");
    assert.match(payload.hookSpecificOutput.permissionDecisionReason, /push/);
    assert.match(
      payload.hookSpecificOutput.permissionDecisionReason,
      /empty-catch/,
    );
  } finally {
    cleanup(repo);
  }
});
