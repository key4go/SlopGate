import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(here, "..");
const distServer = path.join(pluginDir, "server", "dist", "index.mjs");

test(
  "bundled MCP server starts and exposes tools",
  { skip: !existsSync(distServer) },
  async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [distServer],
      cwd: pluginDir,
      stderr: "pipe",
    });
    const client = new Client({ name: "slopgate-dist-test", version: "0.0.0" });

    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      assert.deepEqual(
        tools.map((tool) => tool.name).sort(),
        ["rules", "scan", "scan_file", "stats"],
      );
    } finally {
      await client.close().catch(() => {});
    }
  },
);
