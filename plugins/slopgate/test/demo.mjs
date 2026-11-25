import { cleanup, makeRepo, write } from "./helpers.mjs";
import { formatMarkdown, scan } from "../core/index.mjs";

const repo = makeRepo();

try {
  write(
    repo,
    "src/app.ts",
    `// TODO: replace this placeholder with the real API
const apiKey = "sk-proj-abcdefghijklmnopqrstuvwxyz123456";

// @ts-ignore
const payload = JSON.parse("{}") as any;

console.log("debug", payload);

export function run() {
  try { risky(); } catch (e) {}
}
`,
  );

  write(
    repo,
    "src/app.test.ts",
    `describe.only("demo", () => {
  it("works", () => {});
});
`,
  );

  const result = await scan({ cwd: repo, mode: "all" });
  process.stdout.write(formatMarkdown(result));
  process.stdout.write("\n");
} finally {
  cleanup(repo);
}
