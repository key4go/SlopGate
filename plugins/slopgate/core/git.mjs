import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { SlopGateError } from "./errors.mjs";

const execFileAsync = promisify(execFile);

const GIT_MAX_BUFFER = 20 * 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;

const IGNORED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".cache",
  "coverage",
  "vendor",
  "Pods",
  "DerivedData",
]);

const IGNORED_FILE_PATTERNS = [
  /^package-lock\.json$/i,
  /^npm-shrinkwrap\.json$/i,
  /^pnpm-lock\.yaml$/i,
  /^yarn\.lock$/i,
  /^bun\.lockb?$/i,
  /^Cargo\.lock$/i,
  /^composer\.lock$/i,
  /^Gemfile\.lock$/i,
  /\.min\.(?:js|css)$/i,
  /\.map$/i,
  /\.snap$/i,
  /^\.DS_Store$/,
];

const SOURCE_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
]);

function normalizePath(value) {
  return String(value).replaceAll("\\", "/");
}

function isInside(root, candidate) {
  const normalizedRoot = path.resolve(root);
  const normalizedCandidate = path.resolve(candidate);
  return (
    normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(normalizedRoot + path.sep)
  );
}

export async function runGit(args, { cwd, allowFailure = false, timeout = 15000 } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(
      "git",
      ["-c", "core.quotePath=false", ...args],
      {
        cwd,
        encoding: "utf8",
        maxBuffer: GIT_MAX_BUFFER,
        timeout,
        windowsHide: true,
      },
    );
    return { ok: true, stdout, stderr, code: 0 };
  } catch (error) {
    if (allowFailure) {
      return {
        ok: false,
        stdout: error.stdout ?? "",
        stderr: error.stderr ?? error.message ?? "",
        code: typeof error.code === "number" ? error.code : 1,
      };
    }

    const detail = String(error.stderr || error.message || "").trim();
    throw new SlopGateError(
      `git ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`,
      "GIT_FAILED",
    );
  }
}

export async function getRepoRoot(cwd) {
  const result = await runGit(["rev-parse", "--show-toplevel"], {
    cwd,
    allowFailure: true,
  });
  if (!result.ok) return null;
  const root = result.stdout.trim();
  return root ? path.resolve(root) : null;
}

export async function hasHead(cwd) {
  const result = await runGit(["rev-parse", "--verify", "HEAD"], {
    cwd,
    allowFailure: true,
  });
  return result.ok;
}

function validateRange(range) {
  if (typeof range !== "string" || range.length === 0) {
    throw new SlopGateError("A git range is required for range scans.", "INVALID_RANGE");
  }
  if (
    range.startsWith("-") ||
    /[\0\n\r]/.test(range) ||
    !/^[A-Za-z0-9_./~^@{}=:+\\-]+$/.test(range)
  ) {
    throw new SlopGateError(`Invalid git range: ${range}`, "INVALID_RANGE");
  }
  return range;
}

const DIFF_FLAGS = ["--unified=0", "--no-color", "--no-ext-diff"];

export async function getDiffText(cwd, mode = "all", { range } = {}) {
  if (mode === "staged") {
    const result = await runGit(["diff", "--cached", ...DIFF_FLAGS], { cwd });
    return result.stdout;
  }

  if (mode === "unstaged") {
    const result = await runGit(["diff", ...DIFF_FLAGS], { cwd });
    return result.stdout;
  }

  if (mode === "range") {
    const safeRange = validateRange(range);
    const result = await runGit(["diff", ...DIFF_FLAGS, safeRange], { cwd });
    return result.stdout;
  }

  if (mode === "all") {
    if (await hasHead(cwd)) {
      const result = await runGit(["diff", "HEAD", ...DIFF_FLAGS], { cwd });
      return result.stdout;
    }

    const staged = await runGit(["diff", "--cached", ...DIFF_FLAGS], { cwd });
    const unstaged = await runGit(["diff", ...DIFF_FLAGS], { cwd });
    return `${staged.stdout}\n${unstaged.stdout}`;
  }

  throw new SlopGateError(`Unknown scan mode: ${mode}`, "INVALID_MODE");
}

export async function getUntrackedFiles(cwd) {
  const result = await runGit(
    ["ls-files", "--others", "--exclude-standard", "-z"],
    { cwd },
  );
  return result.stdout.split("\0").filter(Boolean);
}

export async function getOutgoingRange(cwd) {
  const upstream = await runGit(
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    { cwd, allowFailure: true },
  );
  if (upstream.ok && upstream.stdout.trim()) {
    return `${upstream.stdout.trim()}..HEAD`;
  }

  const current = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd,
    allowFailure: true,
  });
  const currentBranch = current.ok ? current.stdout.trim() : "";

  for (const base of ["origin/main", "origin/master", "main", "master"]) {
    if (base === currentBranch) continue;
    const exists = await runGit(["rev-parse", "--verify", base], {
      cwd,
      allowFailure: true,
    });
    if (exists.ok) return `${base}..HEAD`;
  }

  const parent = await runGit(["rev-parse", "--verify", "HEAD~1"], {
    cwd,
    allowFailure: true,
  });
  if (parent.ok) return "HEAD~1..HEAD";

  return null;
}

export function rightSideOfRange(range) {
  if (!range) return "HEAD";
  const parts = String(range).split(/\.\.\.?/);
  return parts.length > 1 ? parts[parts.length - 1] || "HEAD" : "HEAD";
}

export function isIgnoredPath(relPath) {
  const normalized = normalizePath(relPath);
  const segments = normalized.split("/").filter(Boolean);

  if (segments.some((segment) => IGNORED_DIRS.has(segment))) return true;

  const base = segments[segments.length - 1] ?? normalized;
  if (IGNORED_FILE_PATTERNS.some((pattern) => pattern.test(base))) return true;
  if (/\.d\.ts$/i.test(base)) return true;
  if (/\.(?:generated|gen)\.(?:js|jsx|ts|tsx|mjs|cjs)$/i.test(base)) return true;

  return false;
}

export function isScannablePath(relPath) {
  const normalized = normalizePath(relPath);
  if (isIgnoredPath(normalized)) return false;

  const base = normalized.split("/").pop() ?? normalized;
  if (base === ".env" || base.startsWith(".env.")) return true;
  if (/\.(?:pem|key)$/i.test(base)) return true;

  return SOURCE_EXTENSIONS.has(path.extname(base).toLowerCase());
}

export function isTestPath(relPath) {
  const normalized = normalizePath(relPath);
  const base = normalized.split("/").pop() ?? normalized;

  if (/(^|\/)(?:__tests__|tests?|specs?)\//i.test(normalized)) return true;
  if (/\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(base)) return true;
  if (/_(?:test|spec)\.(?:py|rb|go)$/i.test(base)) return true;

  return false;
}

function isBinaryBuffer(buffer) {
  return buffer.subarray(0, 8000).includes(0);
}

function linesFromText(text, relPath, absPath = null) {
  const lines = String(text).split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return {
    path: normalizePath(relPath),
    absPath,
    text: String(text),
    lines,
  };
}

/**
 * Read a file from the worktree, the index, or a git ref.
 * Returns null for missing, binary, or oversized files.
 */
export async function readFileForChange(
  root,
  relPath,
  { source = "worktree", ref = "HEAD" } = {},
) {
  const normalized = normalizePath(relPath);
  const absolute = path.resolve(root, normalized);
  if (!isInside(root, absolute)) return null;

  if (source === "index" || source === "ref") {
    const spec = source === "index" ? `:${normalized}` : `${ref}:${normalized}`;
    const result = await runGit(["show", spec], {
      cwd: root,
      allowFailure: true,
    });
    if (result.ok) {
      const buffer = Buffer.from(result.stdout, "utf8");
      if (buffer.length <= MAX_FILE_BYTES && !isBinaryBuffer(buffer)) {
        return linesFromText(result.stdout, normalized, absolute);
      }
    }
  }

  try {
    const stat = await fs.stat(absolute);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;

    const buffer = await fs.readFile(absolute);
    if (isBinaryBuffer(buffer)) return null;

    return linesFromText(buffer.toString("utf8"), normalized, absolute);
  } catch {
    return null;
  }
}

export async function getFileChange(root, relPath) {
  const normalized = normalizePath(relPath);
  if (!isScannablePath(normalized)) return null;

  const file = await readFileForChange(root, normalized, { source: "worktree" });
  if (!file) return null;

  return {
    path: normalized,
    status: "untracked",
    added: file.lines.map((text, index) => ({ line: index + 1, text })),
  };
}

export function normalizeRelPath(value) {
  return normalizePath(value).replace(/^\.\//, "");
}

export function pathIsInside(root, candidate) {
  return isInside(root, candidate);
}
