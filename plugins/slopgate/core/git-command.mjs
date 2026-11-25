const GLOBAL_OPTIONS_WITH_VALUE = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--config-env",
  "--exec-path",
  "--super-prefix",
]);

/**
 * Split a shell-ish command into rough tokens.
 * This is intentionally not a full shell parser. It is only used to decide
 * whether a Bash command is a git commit or push.
 */
export function tokenize(command) {
  const tokens = [];
  let current = "";
  let quote = null;
  let escaped = false;

  for (const char of String(command)) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }

    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current) tokens.push(current);
  return tokens;
}

function segments(command) {
  return String(command).split(/(?:&&|\|\||[;|])/);
}

/**
 * Return the first real git subcommand in a Bash command.
 * Ignores quoted text and unrelated commands.
 *
 * @param {string} command
 * @returns {{ subcommand: string, args: string[], tokens: string[], segment: string } | null}
 */
export function parseGitCommand(command) {
  for (const rawSegment of segments(command)) {
    const tokens = tokenize(rawSegment);
    if (tokens.length === 0 || tokens[0] !== "git") continue;

    let index = 1;
    while (index < tokens.length) {
      const token = tokens[index];
      if (GLOBAL_OPTIONS_WITH_VALUE.has(token)) {
        index += 2;
        continue;
      }
      if (token.startsWith("-")) {
        index += 1;
        continue;
      }
      break;
    }

    const subcommand = tokens[index];
    if (!subcommand) continue;

    return {
      subcommand,
      args: tokens.slice(index + 1),
      tokens,
      segment: rawSegment.trim(),
    };
  }

  return null;
}

export function isHelpOrDryRun(parsed) {
  if (!parsed) return true;
  const args = parsed.args;
  if (args.includes("--help") || args.includes("-h")) return true;
  if (args.includes("--dry-run")) return true;
  if (parsed.subcommand === "push" && (args.includes("-n") || args.includes("--dry-run"))) {
    return true;
  }
  return false;
}

export function isCommitCommand(parsed) {
  return parsed?.subcommand === "commit" && !isHelpOrDryRun(parsed);
}

export function isPushCommand(parsed) {
  return parsed?.subcommand === "push" && !isHelpOrDryRun(parsed);
}

export function commitScansAllChanges(parsed) {
  if (!parsed) return false;
  const args = parsed.args;
  return (
    args.includes("-a") ||
    args.includes("--all") ||
    args.includes("--amend") ||
    args.some((arg) => /^-[a-zA-Z]*a[a-zA-Z]*$/.test(arg))
  );
}
