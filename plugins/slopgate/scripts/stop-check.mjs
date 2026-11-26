#!/usr/bin/env node
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

  const cwd = input.cwd || process.env.SLOPGATE_CWD || process.cwd();

  let result;
  try {
    result = await scan({ cwd, mode: "all" });
  } catch (error) {
    process.stderr.write(
      `SlopGate: scan skipped: ${error?.message ?? error}\n`,
    );
    return;
  }

  const blocked = result.counts.block > 0 && !input.stop_hook_active;
  const waived = result.counts.block > 0 && Boolean(input.stop_hook_active);

  recordCheck(result, {
    source: "hook",
    action: "handoff",
    blocked,
    waived,
    sessionId: input.session_id,
  });

  if (result.counts.block === 0) {
    return;
  }

  if (input.stop_hook_active) {
    process.stdout.write(
      JSON.stringify({
        systemMessage: `SlopGate: ${result.counts.block} blocker(s) still present; allowing completion to avoid a loop.`,
      }),
    );
    return;
  }

  process.stdout.write(
    JSON.stringify({
      decision: "block",
      reason: formatHookReason(result),
    }),
  );
}

main().catch((error) => {
  process.stderr.write(`SlopGate stop hook skipped: ${error?.message ?? error}\n`);
  process.exit(0);
});
