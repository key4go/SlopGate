import test from "node:test";
import assert from "node:assert/strict";
import { parseUnifiedDiff } from "../core/diff.mjs";
import { scan, scanFile } from "../core/index.mjs";
import { scoreFindings } from "../core/score.mjs";
import {
  commitScansAllChanges,
  isCommitCommand,
  isPushCommand,
  parseGitCommand,
} from "../core/git-command.mjs";
import { cleanup, git, makeRepo, write } from "./helpers.mjs";

test("parseUnifiedDiff maps added lines to new-file line numbers", () => {
  const diff = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -10,0 +11,3 @@
+const a = 1;
+const b = 2;
+const c = 3;
`;

  const [file] = parseUnifiedDiff(diff);
  assert.equal(file.path, "src/app.ts");
  assert.deepEqual(file.added.map((entry) => entry.line), [11, 12, 13]);
  assert.equal(file.added[0].text, "const a = 1;");
});

test("parseUnifiedDiff advances through context lines", () => {
  const diff = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,2 +1,3 @@
 context one
+added
 context two
`;

  const [file] = parseUnifiedDiff(diff);
  assert.deepEqual(file.added, [{ line: 2, text: "added" }]);
});

test("parseUnifiedDiff handles paths with spaces and new files", () => {
  const diff = `diff --git a/src/my file.ts b/src/my file.ts
new file mode 100644
--- /dev/null
+++ b/src/my file.ts
@@ -0,0 +1,2 @@
+one
+two
`;

  const [file] = parseUnifiedDiff(diff);
  assert.equal(file.path, "src/my file.ts");
  assert.equal(file.status, "added");
  assert.deepEqual(file.added.map((entry) => entry.line), [1, 2]);
});

test("clean diff scores 100 and has no findings", async () => {
  const repo = makeRepo();
  try {
    const result = await scan({ cwd: repo, mode: "all" });
    assert.equal(result.clean, true);
    assert.equal(result.score, 100);
    assert.equal(result.addedLines, 0);
    assert.deepEqual(result.findings, []);
  } finally {
    cleanup(repo);
  }
});

test("scan finds an empty catch", async () => {
  const repo = makeRepo();
  try {
    write(
      repo,
      "src/app.ts",
      `export const ok = true;

export function run() {
  try { risky(); } catch (e) {}
}
`,
    );

    const result = await scan({ cwd: repo, mode: "all" });
    const finding = result.findings.find((item) => item.rule === "empty-catch");

    assert.ok(finding);
    assert.equal(finding.line, 4);
    assert.equal(finding.severity, "block");
    assert.equal(result.clean, false);
    assert.ok(result.score < 100);
  } finally {
    cleanup(repo);
  }
});

test("scan redacts hardcoded secrets", async () => {
  const repo = makeRepo();
  const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz123456";

  try {
    write(repo, "src/app.ts", `export const apiKey = "${secret}";\n`);

    const result = await scan({ cwd: repo, mode: "all" });
    const finding = result.findings.find(
      (item) => item.rule === "hardcoded-secret",
    );

    assert.ok(finding);
    assert.equal(finding.severity, "block");
    assert.ok(!finding.snippet.includes(secret));
    assert.ok(!JSON.stringify(result).includes(secret));
  } finally {
    cleanup(repo);
  }
});

test("scan catches secrets in an untracked .env file", async () => {
  const repo = makeRepo();
  try {
    write(repo, ".env", "API_KEY=abcdef1234567890\n");

    const result = await scan({ cwd: repo, mode: "all" });
    const finding = result.findings.find(
      (item) => item.rule === "hardcoded-secret",
    );

    assert.ok(finding);
    assert.equal(finding.severity, "block");
    assert.ok(!finding.snippet.includes("abcdef1234567890"));
  } finally {
    cleanup(repo);
  }
});

test("a suppression with a reason removes the finding", async () => {
  const repo = makeRepo();
  try {
    write(
      repo,
      "src/app.ts",
      `// slopgate-ignore-next-line empty-catch -- cleanup must continue
try { risky(); } catch (e) {}
`,
    );

    const result = await scan({ cwd: repo, mode: "all" });
    assert.equal(
      result.findings.some((item) => item.rule === "empty-catch"),
      false,
    );
    assert.equal(result.counts.suppressed, 1);
  } finally {
    cleanup(repo);
  }
});

test("a suppression without a reason does nothing", async () => {
  const repo = makeRepo();
  try {
    write(
      repo,
      "src/app.ts",
      `// slopgate-ignore-next-line empty-catch
try { risky(); } catch (e) {}
`,
    );

    const result = await scan({ cwd: repo, mode: "all" });
    assert.ok(result.findings.some((item) => item.rule === "empty-catch"));
    assert.equal(result.counts.suppressed, 0);
  } finally {
    cleanup(repo);
  }
});

test("test-focus only applies to test files and blocks .only", async () => {
  const repo = makeRepo();
  try {
    write(repo, "src/app.test.ts", `describe.only("demo", () => {});\n`);

    const result = await scan({ cwd: repo, mode: "all" });
    const finding = result.findings.find((item) => item.rule === "test-focus");

    assert.ok(finding);
    assert.equal(finding.severity, "block");
  } finally {
    cleanup(repo);
  }
});

test("staged and unstaged modes see different sides of the index", async () => {
  const repo = makeRepo();
  try {
    write(repo, "src/app.ts", `try { risky(); } catch (e) {}\n`);
    git(repo, "add", "src/app.ts");

    const staged = await scan({ cwd: repo, mode: "staged" });
    const unstaged = await scan({ cwd: repo, mode: "unstaged" });

    assert.ok(staged.findings.some((item) => item.rule === "empty-catch"));
    assert.equal(unstaged.findings.length, 0);
  } finally {
    cleanup(repo);
  }
});

test("range mode scans committed changes", async () => {
  const repo = makeRepo();
  try {
    write(repo, "src/app.ts", `try { risky(); } catch (e) {}\n`);
    git(repo, "add", "src/app.ts");
    git(repo, "commit", "-qm", "sloppy change");

    const result = await scan({
      cwd: repo,
      mode: "range",
      range: "HEAD~1..HEAD",
    });

    assert.ok(result.findings.some((item) => item.rule === "empty-catch"));
  } finally {
    cleanup(repo);
  }
});

test("scanFile treats every line as new", async () => {
  const repo = makeRepo();
  try {
    write(repo, "src/app.ts", `try { risky(); } catch (e) {}\n`);

    const result = await scanFile({ cwd: repo, path: "src/app.ts" });
    assert.equal(result.mode, "file");
    assert.ok(result.findings.some((item) => item.rule === "empty-catch"));
  } finally {
    cleanup(repo);
  }
});

test("scoreFindings subtracts weighted severities", () => {
  assert.deepEqual(
    scoreFindings([{ severity: "block" }, { severity: "block" }]),
    { counts: { block: 2, warn: 0, info: 0 }, score: 70 },
  );

  assert.deepEqual(
    scoreFindings([
      { severity: "block" },
      { severity: "warn" },
      { severity: "info" },
    ]),
    { counts: { block: 1, warn: 1, info: 1 }, score: 79 },
  );
});

test("git command parsing ignores quoted text and understands global options", () => {
  assert.equal(parseGitCommand('git commit -m "x"')?.subcommand, "commit");
  assert.equal(
    parseGitCommand('git -C repo commit -am "x"')?.subcommand,
    "commit",
  );
  assert.equal(parseGitCommand('echo "git commit"'), null);
  assert.equal(parseGitCommand("git push origin main")?.subcommand, "push");

  assert.equal(isCommitCommand(parseGitCommand("git commit --help")), false);
  assert.equal(isPushCommand(parseGitCommand("git push --dry-run")), false);
  assert.equal(
    commitScansAllChanges(parseGitCommand("git commit -am x")),
    true,
  );
  assert.equal(
    commitScansAllChanges(parseGitCommand("git commit -m x")),
    false,
  );
});

test("scans Swift changes and Swift test conventions", async () => {
  const repo = makeRepo();
  try {
    // slopgate-ignore-next-line empty-catch -- intentional scanner test fixture
    write(repo, "Sources/App.swift", `do { try run() } catch {}
let apiKey = "${"abc123def456ghi789"}"
// ${"TODO"}: implement
fatalError("${"not " + "implemented"}")
print("debug")
`);
    write(repo, "AppTests.swift", `@Test(.disabled("broken")) func example() {}
func testExample() throws { throw XCTSkip("broken") }
`);
    const result = await scan({ cwd: repo, mode: "all" });
    assert.deepEqual(result.findings.filter((item) => item.file === "Sources/App.swift").map((item) => item.rule).sort(),
      ["debug-leftover", "empty-catch", "hardcoded-secret", "placeholder", "placeholder"].sort());
    assert.equal(result.findings.filter((item) => item.file === "AppTests.swift" && item.rule === "test-focus").length, 2);
    assert.ok((await scanFile({ cwd: repo, path: "Sources/App.swift" })).findings.some((item) => item.rule === "empty-catch"));
  } finally {
    cleanup(repo);
  }
});

test("recognizes Swift test targets without treating Contest.swift as a test", async () => {
  const repo = makeRepo();
  try {
    write(repo, "MyAppTests/NetworkChecks.swift", '@Test(.disabled("reason")) func check() {}\n');
    write(repo, "Sources/Contest.swift", 'print("diagnostic")\n');
    const result = await scan({ cwd: repo, mode: "all" });
    assert.ok(result.findings.some((item) => item.file === "MyAppTests/NetworkChecks.swift" && item.rule === "test-focus"));
    assert.equal(result.findings.find((item) => item.file === "Sources/Contest.swift" && item.rule === "debug-leftover")?.severity, "warn");
  } finally {
    cleanup(repo);
  }
});

test("does not flag SwiftUI .disabled modifiers in Swift tests", async () => {
  const repo = makeRepo();
  try {
    write(
      repo,
      "MyAppTests/UITests.swift",
      `Button("Save").disabled(!isEnabled)\n`,
    );

    const result = await scan({ cwd: repo, mode: "all" });
    assert.equal(
      result.findings.filter((item) => item.rule === "test-focus").length,
      0,
    );
  } finally {
    cleanup(repo);
  }
});

test("catches empty Swift catch bindings and where clauses", async () => {
  const repo = makeRepo();
  try {
    // slopgate-ignore-next-line empty-catch -- intentional scanner test fixture
    write(repo, "Sources/Binding.swift", `func f() { do { try run() } catch let error {} }\n`);
    // slopgate-ignore-next-line empty-catch -- intentional scanner test fixture
    write(repo, "Sources/Cast.swift", `func f() { do { try run() } catch let error as NSError {} }\n`);
    // slopgate-ignore-next-line empty-catch -- intentional scanner test fixture
    write(repo, "Sources/Where.swift", `func f() { do { try run() } catch where shouldIgnore {} }\n`);

    const result = await scan({ cwd: repo, mode: "all" });
    for (const file of [
      "Sources/Binding.swift",
      "Sources/Cast.swift",
      "Sources/Where.swift",
    ]) {
      assert.ok(
        result.findings.some(
          (item) => item.file === file && item.rule === "empty-catch",
        ),
        `${file} should produce an empty-catch finding`,
      );
    }
  } finally {
    cleanup(repo);
  }
});
