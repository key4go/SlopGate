#!/usr/bin/env node
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  formatMarkdown,
  formatRulesMarkdown,
  ruleMeta,
  scan,
  scanFile,
  VERSION,
} from "../core/index.mjs";

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

function resolveProjectCwd(requestedCwd) {
  const candidate =
    requestedCwd ||
    process.env.SLOPGATE_CWD ||
    process.env.CODEX_WORKSPACE_ROOT ||
    process.env.PWD ||
    process.cwd();

  return path.resolve(candidate);
}

function errorResult(error) {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `SlopGate error: ${error?.message ?? error}`,
      },
    ],
  };
}

const server = new McpServer(
  {
    name: "slopgate",
    version: VERSION,
  },
  {
    instructions:
      "SlopGate scans the current git diff for AI-code smell. Call `scan` with the absolute project root as `cwd` before finishing or committing. BLOCK findings must be fixed. WARN findings are judgment calls. Suppress only with a written reason. Never claim the code is clean without running a scan.",
  },
);

server.registerTool(
  "scan",
  {
    title: "Scan the current diff",
    description:
      "Scan added lines in the current git diff for empty catches, hardcoded secrets, disabled type checks, placeholders, test focus/skip, and debug leftovers. Returns blockers, warnings, a score, and file/line fixes.",
    inputSchema: {
      cwd: z
        .string()
        .optional()
        .describe(
          "Absolute path to the project root. Use the current workspace directory.",
        ),
      mode: z
        .enum(["all", "staged", "unstaged", "range", "file"])
        .optional()
        .describe("Which changes to scan. Defaults to all uncommitted changes."),
      range: z
        .string()
        .optional()
        .describe("Git range for mode=range, for example origin/main..HEAD."),
      paths: z
        .array(z.string())
        .optional()
        .describe(
          "Optional file or directory filters. For mode=file, pass exactly one path.",
        ),
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  async ({ cwd, mode, range, paths }) => {
    try {
      const result = await scan({
        cwd: resolveProjectCwd(cwd),
        mode: mode ?? "all",
        range,
        paths: paths ?? [],
      });

      return {
        content: [
          {
            type: "text",
            text: formatMarkdown(result),
          },
        ],
        structuredContent: result,
      };
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "scan_file",
  {
    title: "Scan one file",
    description:
      "Scan one file as if every line were newly added. Useful for a quick check before a large edit or when the file is not in git yet.",
    inputSchema: {
      cwd: z
        .string()
        .optional()
        .describe("Absolute path to the project root."),
      path: z.string().describe("File path, relative to the project root."),
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  async ({ cwd, path: filePath }) => {
    try {
      const result = await scanFile({
        cwd: resolveProjectCwd(cwd),
        path: filePath,
      });

      return {
        content: [
          {
            type: "text",
            text: formatMarkdown(result),
          },
        ],
        structuredContent: result,
      };
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "rules",
  {
    title: "List SlopGate rules",
    description:
      "List the SlopGate rules, their severities, why each one matters, and how to fix it.",
    annotations: READ_ONLY_ANNOTATIONS,
  },
  async () => ({
    content: [
      {
        type: "text",
        text: formatRulesMarkdown(ruleMeta),
      },
    ],
    structuredContent: {
      rules: ruleMeta,
    },
  }),
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  process.stderr.write(`SlopGate MCP server failed: ${error?.message ?? error}\n`);
  process.exit(1);
});
