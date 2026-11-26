#!/usr/bin/env node
import { parseArgs } from "node:util";
import {
  buildStats,
  formatJson,
  formatMarkdown,
  formatRulesMarkdown,
  formatStatsMarkdown,
  normalizeDays,
  readEvents,
  recordScan,
  ruleMeta,
  scan,
  scanFile,
  VERSION,
} from "./core/index.mjs";
import { startDashboard } from "./dashboard/server.mjs";

const HELP = `SlopGate ${VERSION} — catch AI code smell before it ships.

Usage:
  slopgate scan [options]
  slopgate stats [options]
  slopgate dashboard [options]
  slopgate rules
  slopgate --version

Scan options:
  --cwd <path>       Project directory (default: current directory)
  --mode <mode>      all | staged | unstaged | range (default: all)
  --range <range>    Git range for --mode range, e.g. origin/main..HEAD
  --file <path>      Scan one file as if every line were new
  --path <path>      Limit the scan to this file or directory (repeatable)
  --json             Print structured JSON
  --no-history       Do not record this scan in .slopgate/events.jsonl

Stats options:
  --cwd <path>       Project directory (default: current directory)
  --days <n|all>     Time range (default: 30)
  --json             Print the stats object as JSON

Dashboard options:
  --cwd <path>       Project directory (default: current directory)
  --port <n>         Port to listen on (default: 4717)
  --host <host>      Bind address (default: 127.0.0.1)
  --days <n|all>     Initial time range (default: 30)
  --open             Open the dashboard in your browser

Exit codes:
  0  no blockers / success
  1  blockers found
  2  SlopGate error
`;

function usageError(message) {
  process.stderr.write(`SlopGate error: ${message}\n\n${HELP}`);
  process.exit(2);
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    usageError(`Invalid port: ${value}`);
  }
  return port;
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
      days: { type: "string" },
      port: { type: "string" },
      host: { type: "string" },
      open: { type: "boolean", default: false },
      "no-history": { type: "boolean", default: false },
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
  const cwd = values.cwd ?? process.cwd();
  const days = normalizeDays(values.days ?? 30);

  if (command === "rules" || values.rules) {
    process.stdout.write(`${formatRulesMarkdown(ruleMeta)}\n`);
    return;
  }

  if (command === "stats") {
    try {
      const stats = buildStats(readEvents(cwd), { days });
      process.stdout.write(
        `${values.json ? `${JSON.stringify(stats, null, 2)}\n` : `${formatStatsMarkdown(stats)}\n`}`,
      );
    } catch (error) {
      process.stderr.write(`SlopGate error: ${error.message}\n`);
      process.exit(2);
    }
    return;
  }

  if (command === "dashboard") {
    const port = values.port === undefined ? 4717 : parsePort(values.port);

    try {
      const dashboard = await startDashboard({
        cwd,
        port,
        host: values.host ?? "127.0.0.1",
        days,
        open: values.open,
      });

      process.stdout.write(
        [
          `SlopGate dashboard: ${dashboard.url}`,
          `Project: ${cwd}`,
          "Press Ctrl+C to stop.",
          "",
        ].join("\n"),
      );

      const shutdown = async () => {
        try {
          await dashboard.close();
        } catch {
          // The server may already be closed.
        }
        process.exit(0);
      };

      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    } catch (error) {
      process.stderr.write(`SlopGate error: ${error.message}\n`);
      process.exit(2);
    }
    return;
  }

  if (command !== "scan") {
    usageError(`Unknown command: ${command}`);
  }

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

  recordScan(result, {
    source: "cli",
    enabled: !values["no-history"],
  });

  process.stdout.write(
    `${values.json ? formatJson(result) : formatMarkdown(result)}\n`,
  );
  process.exit(result.clean ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(`SlopGate error: ${error?.message ?? error}\n`);
  process.exit(2);
});
