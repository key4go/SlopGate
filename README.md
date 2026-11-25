# SlopGate

**Your AI says it's done. SlopGate checks the diff.**

SlopGate is a local, diff-first smoke detector for AI-assisted JavaScript and TypeScript. It runs the moment Codex tries to finish, commit, or push, and blocks the predictable stuff that looks fine in review but breaks later:

- a swallowed `catch`
- a hardcoded API key
- a `@ts-ignore` or `as any`
- a TODO or "not implemented" shipped as if it were done
- a `.only` test that hides the rest of the suite
- a leftover `console.log` or `debugger`

No server. No account. No API key. No code leaves your machine.

---

## What it does

SlopGate has three layers:

1. **A skill** that tells Codex when to check its own work.
2. **An MCP server** with `scan`, `scan_file`, and `rules` tools.
3. **Lifecycle hooks** that enforce the result:
   - `Stop` blocks the end of a turn while BLOCK findings remain.
   - `PreToolUse` on `Bash` denies `git commit` and `git push` while BLOCK findings remain.

The loop is simple:

```
Codex edits -> Stop hook scans -> clean? end the turn
                              -> blockers? Codex gets the findings and keeps fixing
```

Before Git, the second hook checks the staged diff (or the outgoing push range) so a blocker cannot slip through.

---

## Install into Codex desktop

Prerequisites: Node.js 20+, Git, and the ChatGPT desktop app with Codex.

From this repository:

```bash
npm run setup
npm run build
```

Register the local marketplace:

```bash
codex plugin marketplace add /Users/key2go/Documents/SlopGate
```

Then:

1. Restart the ChatGPT desktop app.
2. Open **Plugins** and install **SlopGate** from the local marketplace.
3. Open **Settings > Hooks** and trust the SlopGate hooks. Codex will not run unreviewed hooks.
4. Open a Git repository and ask Codex to make a change.

If the marketplace command is unavailable in your Codex version, use the plugin installer in the Codex desktop app, or see the Codex plugin docs for the personal marketplace layout.

> Local plugins that use hooks are for manual installation. They are not eligible for the public plugin directory.

---

## CLI

The same engine works without Codex, which is useful for debugging and CI.

```bash
# Scan all uncommitted changes (tracked + untracked)
node plugins/slopgate/cli.mjs --cwd /path/to/project

# Scan only staged changes
node plugins/slopgate/cli.mjs --cwd /path/to/project --mode staged

# Scan a committed range
node plugins/slopgate/cli.mjs --cwd /path/to/project --range origin/main..HEAD

# Scan one file as if every line were new
node plugins/slopgate/cli.mjs --cwd /path/to/project --file src/app.ts

# Machine-readable output
node plugins/slopgate/cli.mjs --cwd /path/to/project --json

# List the rules
node plugins/slopgate/cli.mjs --rules
```

Exit codes:

| Code | Meaning |
| --- | --- |
| `0` | No BLOCK findings |
| `1` | At least one BLOCK finding |
| `2` | SlopGate could not run (not a Git repo, bad arguments, etc.) |

---

## Rules

| Rule | Severity | What it catches |
| --- | --- | --- |
| `empty-catch` | BLOCK | `catch (e) {}`, comment-only catches, and `.catch(() => {})` |
| `hardcoded-secret` | BLOCK (WARN in tests) | Known token prefixes, private keys, password/secret assignments, `.env` values |
| `disabled-typecheck` | WARN | `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, `as any`, blanket eslint disables |
| `placeholder` | WARN | TODO/FIXME/XXX/HACK, "not implemented", lorem ipsum, stub throws |
| `test-focus` | BLOCK for `.only`; WARN for skip | `.only`, `.skip`, `xit`, `xdescribe`, `fit`, `fdescribe` in tests |
| `debug-leftover` | WARN (INFO in tests) | `console.log`, `console.debug`, `console.dir`, `console.trace`, `debugger`, `alert` |

The default score starts at 100 and subtracts 15 per BLOCK, 5 per WARN, and 1 per INFO, clamped at 0. `clean` means **zero BLOCK findings**, not a perfect score.

### Suppression

Suppress one finding only when it is intentional, and always write the reason:

```ts
// slopgate-ignore-next-line empty-catch -- the cleanup path must never throw
try { cleanup(); } catch (e) {}
```

```ts
doSomething(); // slopgate-ignore-line debug-leftover -- this is a CLI command
```

A suppression without `-- reason` is ignored. There is no "make it green" switch.

---

## What gets scanned

SlopGate only reports findings on **added lines**. Existing code does not suddenly fail because you opened an old project. It understands:

- `all` — `HEAD` vs the worktree, plus untracked files
- `staged` — index vs `HEAD`
- `unstaged` — worktree vs index
- `range` — any Git range, used for pushes
- `file` — one file, with every line treated as new

Ignored: `node_modules`, `dist`, `build`, `.next`, `coverage`, `vendor`, lockfiles, minified files, source maps, snapshots, `.d.ts`, and generated files. Binary and very large files are skipped.

---

## Development

```bash
npm run setup       # install plugin dependencies
npm test            # core, hook, and MCP tests
npm run build       # bundle the MCP server
npm run demo        # print a scan with all six rules
```

Plugin layout:

```
.agents/plugins/marketplace.json
plugins/slopgate/
  plugin.json
  mcp.json
  hooks/hooks.json
  skills/slopgate/SKILL.md
  skills/slopgate/agents/openai.yaml
  core/                 # diff parser, Git adapter, rules, scoring, formatting
  server/index.mjs      # MCP server (bundled to server/dist/index.mjs)
  server/dist/          # generated by npm run build
  scripts/stop-check.mjs
  scripts/git-guard.mjs
  cli.mjs
  test/
```

The MCP server is bundled so the installed plugin does not need `node_modules` at runtime. Run `npm run build` after changing the server or core.

---

## Limitations

- **JavaScript and TypeScript only.** Python, Go, Rust, and AST-based rules are future work.
- **Diff-first, not a full audit.** SlopGate checks the lines you just changed, not the entire codebase.
- **Not a type checker or security auditor.** It catches specific, high-signal smells. It does not replace `tsc`, ESLint, tests, or a real security review.
- **Pre-existing uncommitted changes count.** Until a baseline is added, the Stop hook scans all uncommitted changes in the repository, including work you had already started.
- **Hooks are local to Codex desktop.** Hosted coding agents and web-based commits bypass local hooks. Use the CLI in CI for a non-bypassable gate.
- **No MCP Apps UI yet.** The report is Markdown with structured content. A visual report is planned.

---

## Troubleshooting

**"SlopGate needs a Git repository"**
Run `git init` in the project, or point the tool at a repository with `--cwd`.

**Hooks do not fire**
Open **Settings > Hooks** in the desktop app and trust the SlopGate hooks. Restart the app after installing or updating the plugin.

**The MCP tools are missing**
Run `npm run build` and confirm `plugins/slopgate/server/dist/index.mjs` exists. Check that `${PLUGIN_ROOT}` resolves in `mcp.json` for your Codex version.

**The plugin does not appear in Plugins**
Re-run `codex plugin marketplace add /Users/key2go/Documents/SlopGate` and restart the app. The marketplace root must contain `.agents/plugins/marketplace.json` and `plugins/slopgate`.

**A commit is blocked by old work**
The hook scans the staged diff. Unstage the old files, or commit them separately after reviewing the findings.

---

## Privacy

SlopGate reads local files and runs local Git commands. It makes no network requests, sends no telemetry, and stores no code. Secrets are redacted in the report before they are printed.

## License

MIT.
