import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readEvents } from "../core/history.mjs";
import { buildStats, normalizeDays } from "../core/stats.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const HTML_PATH = path.join(here, "index.html");
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4717;
const MAX_PORT_ATTEMPTS = 20;

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

function sendText(res, status, text, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
}

function createHandler({ cwd, days }) {
  return async (req, res) => {
    try {
      const url = new URL(
        req.url ?? "/",
        `http://${req.headers.host ?? "localhost"}`,
      );

      if (req.method !== "GET" && req.method !== "HEAD") {
        sendText(res, 405, "Method not allowed");
        return;
      }

      if (url.pathname === "/health") {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (url.pathname === "/api/stats") {
        const requestedDays = url.searchParams.get("days") ?? days;
        const events = readEvents(cwd);
        const stats = buildStats(events, {
          days: normalizeDays(requestedDays),
        });
        sendJson(res, 200, stats);
        return;
      }

      if (url.pathname === "/" || url.pathname === "/index.html") {
        const html = await readFile(HTML_PATH, "utf8");
        sendText(res, 200, html, "text/html; charset=utf-8");
        return;
      }

      sendJson(res, 404, { error: "Not found" });
    } catch (error) {
      sendJson(res, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

export async function startDashboard({
  cwd = process.cwd(),
  port = DEFAULT_PORT,
  host = DEFAULT_HOST,
  days = 30,
  open = false,
} = {}) {
  const projectRoot = path.resolve(cwd);
  let lastError;

  for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt += 1) {
    const candidate = port === 0 ? 0 : port + attempt;
    const server = http.createServer(createHandler({ cwd: projectRoot, days }));

    try {
      await listen(server, candidate, host);

      const address = server.address();
      const actualPort =
        typeof address === "object" && address ? address.port : candidate;
      const displayHost =
        host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
      const url = `http://${displayHost}:${actualPort}`;

      if (open) openBrowser(url);

      return {
        url,
        host,
        port: actualPort,
        close: () =>
          new Promise((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          }),
      };
    } catch (error) {
      lastError = error;
      server.close(() => {});
      if (port === 0 || error?.code !== "EADDRINUSE") break;
    }
  }

  throw lastError ?? new Error("Could not start the dashboard server");
}

export function openBrowser(url) {
  const platform = process.platform;
  const command =
    platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];

  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
