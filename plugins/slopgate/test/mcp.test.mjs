import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  cleanup,
  makeEmptyDir,
  makeRepo,
  write,
} from "./helpers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(here, "..");
const serverPath = path.join(pluginDir, "server", "index.mjs");

async function withClient(run) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: pluginDir,
    stderr: "pipe",
  });
  const client = new Client({ name: "slopgate-test", version: "0.0.0" });

  try {
    await client.connect(transport);
    await run(client);
  } finally {
    await client.close().catch(() => {});
  }
}

function textOf(response) {
  return response.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

test("MCP server exposes the SlopGate tools", async () => {
  await withClient(async (client) => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();

    assert.deepEqual(names, ["rules", "scan", "scan_file"]);
  });
});

test("MCP scan returns Markdown and structured findings", async () => {
  const repo = makeRepo();
  try {
    write(repo, "src/app.ts", `try { risky(); } catch (e) {}\n`);

    await withClient(async (client) => {
      const response = await client.callTool({
        name: "scan",
        arguments: { cwd: repo, mode: "all" },
      });

      assert.notEqual(response.isError, true);
      const text = textOf(response);
      assert.match(text, /SlopGate/);
      assert.match(text, /empty-catch/);

      const result = response.structuredContent;
      assert.ok(result);
      assert.equal(result.clean, false);
      assert.ok(
        result.findings.some((finding) => finding.rule === "empty-catch"),
      );
    });
  } finally {
    cleanup(repo);
  }
});

test("MCP scan_file scans every line", async () => {
  const repo = makeRepo();
  try {
    write(repo, "src/app.ts", `console.log("hello");\n`);

    await withClient(async (client) => {
      const response = await client.callTool({
        name: "scan_file",
        arguments: { cwd: repo, path: "src/app.ts" },
      });

      assert.notEqual(response.isError, true);
      const result = response.structuredContent;
      assert.equal(result.mode, "file");
      assert.ok(
        result.findings.some((finding) => finding.rule === "debug-leftover"),
      );
    });
  } finally {
    cleanup(repo);
  }
});

test("MCP rules lists the six checks", async () => {
  await withClient(async (client) => {
    const response = await client.callTool({ name: "rules", arguments: {} });
    const text = textOf(response);

    for (const rule of [
      "empty-catch",
      "hardcoded-secret",
      "disabled-typecheck",
      "placeholder",
      "test-focus",
      "debug-leftover",
    ]) {
      assert.match(text, new RegExp(rule));
    }
  });
});

test("MCP scan reports a useful error outside a git repository", async () => {
  const emptyDir = makeEmptyDir();
  try {
    await withClient(async (client) => {
      const response = await client.callTool({
        name: "scan",
        arguments: { cwd: emptyDir, mode: "all" },
      });

      assert.equal(response.isError, true);
      assert.match(textOf(response), /git repository/i);
    });
  } finally {
    cleanup(emptyDir);
  }
});
