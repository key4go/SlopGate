#!/usr/bin/env node
import path from "node:path";
import {
  commitScansAllChanges,
  isCommitCommand,
  isPushCommand,
  parseGitCommand,
} from "../core/git-command.mjs";
import { getOutgoingRange } from "../core/git.mjs";
import { formatHookReason, recordCheck, scan } from "../core/index.mjs";

const FAIL_OPEN_TIMEOUT_MS = 25000;

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

function resolveCommandCwd(parsed, fallbackCwd) {
  const index = parsed.tokens.indexOf("-C");
  if (index !== -1 && parsed.tokens[index + 1]) {
    return path.resolve(fallbackCwd, parsed.tokens[index + 1]);
  }
  return fallbackCwd;
}

async function main() {
  const timeout = setTimeout(() => process.exit(0), FAIL_OPEN_TIMEOUT_MS);
  timeout.unref();

  const raw = await readStdin();
  if (!raw.trim()) return;

  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }

  if (input.tool_name !== "Bash") return;

  const command = input.tool_input?.command;
  if (typeof command !== "string") return;

  const parsed = parseGitCommand(command);
  if (!parsed) return;

  const isCommit = isCommitCommand(parsed);
  const isPush = isPushCommand(parsed);
  if (!isCommit && !isPush) return;

  const baseCwd = input.cwd || process.env.SLOPGATE_CWD || process.cwd();
  const cwd = resolveCommandCwd(parsed, baseCwd);

  let mode;
  let range;

  try {
    if (isCommit) {
      mode = commitScansAllChanges(parsed) ? "all" : "staged";
    } else {
      range = await getOutgoingRange(cwd);
      mode = range ? "range" : "all";
    }
  } catch (error) {
    process.stderr.write(
      `SlopGate git check skipped: ${error?.message ?? error}\n`,
    );
    return;
  }

  let result;
  try {
    result = await scan({ cwd, mode, range });
  } catch (error) {
    process.stderr.write(
      `SlopGate git check skipped: ${error?.message ?? error}\n`,
    );
    return;
  }

  const action = isCommit ? "commit" : "push";
  const blocked = result.counts.block > 0;

  recordCheck(result, {
    source: "hook",
    action,
    blocked,
    waived: false,
    sessionId: input.session_id,
  });

  if (!blocked) return;

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `SlopGate blocked this ${action}. ${formatHookReason(result, { maxFindings: 3 })}`,
      },
    }),
  );
}

main().catch((error) => {
  process.stderr.write(
    `SlopGate git hook skipped: ${error?.message ?? error}\n`,
  );
  process.exit(0);
});
