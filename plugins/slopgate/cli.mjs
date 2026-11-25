#!/usr/bin/env node
import { parseArgs } from "node:util";
import {
  formatJson,
  formatMarkdown,
  formatRulesMarkdown,
  ruleMeta,
  scan,
  scanFile,
  VERSION,
} from "./core/index.mjs";

const HELP = `SlopGate ${VERSION} — catch AI code smell before it ships.

Usage:
  slopgate scan [options]
  slopgate rules
  slopgate --version

Scan options:
  --cwd <path>       Project directory (default: current directory)
  --mode <mode>      all | staged | unstaged | range (default: all)
  --range <range>    Git range for --mode range, e.g. origin/main..HEAD
  --file <path>      Scan one file as if every line were new
  --path <path>      Limit the scan to this file or directory (repeatable)
  --json             Print structured JSON

Exit codes:
  0  no blockers
  1  blockers found
  2  SlopGate error
`;

function usageError(message) {
  process.stderr.write(`SlopGate error: ${message}\n\n${HELP}`);
  process.exit(2);
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      cwd: { type: "string" },
      mode: { type: "string", default: "all" },
      range: { type: "string" },
      file: { type: "string" },
      path: { type: "string", multiple: true },
      json: { type: "boolean", default: false },
      rules: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  });

  if (values.help) {
    process.stdout.write(HELP);
    return;
  }

  if (values.version) {
    process.stdout.write(`SlopGate ${VERSION}\n`);
    return;
  }

  const command = positionals[0] ?? "scan";

  if (command === "rules" || values.rules) {
    process.stdout.write(`${formatRulesMarkdown(ruleMeta)}\n`);
    return;
  }

  if (command !== "scan") {
    usageError(`Unknown command: ${command}`);
  }

  const cwd = values.cwd ?? process.cwd();
  let result;

  try {
    if (values.file) {
      result = await scanFile({ cwd, path: values.file });
    } else {
      const mode =
        values.range && values.mode === "all" ? "range" : values.mode;
      result = await scan({
        cwd,
        mode,
        range: values.range,
        paths: values.path ?? [],
      });
    }
  } catch (error) {
    process.stderr.write(`SlopGate error: ${error.message}\n`);
    process.exit(2);
  }

  process.stdout.write(
    `${values.json ? formatJson(result) : formatMarkdown(result)}\n`,
  );
  process.exit(result.clean ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(`SlopGate error: ${error?.message ?? error}\n`);
  process.exit(2);
});
