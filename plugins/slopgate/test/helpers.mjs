import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function makeEmptyDir() {
  return mkdtempSync(path.join(tmpdir(), "slopgate-empty-"));
}

export function makeRepo() {
  const repo = mkdtempSync(path.join(tmpdir(), "slopgate-test-"));

  git(repo, "init", "-q");
  git(repo, "config", "user.email", "test@slopgate.local");
  git(repo, "config", "user.name", "SlopGate Test");
  git(repo, "config", "commit.gpgsign", "false");

  write(repo, "src/app.ts", "export const ok = true;\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "initial");

  return repo;
}

export function write(cwd, relPath, content) {
  const absolute = path.join(cwd, relPath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

export function cleanup(repo) {
  rmSync(repo, { recursive: true, force: true });
}
