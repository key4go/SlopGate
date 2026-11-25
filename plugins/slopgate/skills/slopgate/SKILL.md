---
name: slopgate
description: Use before finishing, committing, or pushing code, or when the user asks whether a change is ready. Scans the current git diff for empty catches, hardcoded secrets, disabled type checks, placeholders, focused or skipped tests, and debug leftovers, then reports blockers with file, line, why, and fix.
---

# SlopGate

SlopGate is a local diff scanner for AI-assisted code. It catches the failure modes that look fine in a quick review but break later.

## When to use

- Before you tell the user a coding task is done.
- Before `git commit` or `git push`.
- After a large edit or a multi-file change.
- When the user asks "is this ready?", "check this", or "did you finish?"

## Workflow

1. Call the `scan` tool with `cwd` set to the **absolute project root** and `mode: "all"`.
2. If `counts.block > 0`, fix every blocker in the code.
3. Re-run `scan` until `counts.block === 0`.
4. Review warnings. Fix the clear ones. Leave intentional ones only with a written suppression reason.
5. In your final message, include this line:
   `SlopGate: X blockers, Y warnings, score Z/100.`

Do not claim the change is clean unless you actually ran the scan.

## What the severities mean

- `BLOCK` — must fix before finishing or committing.
- `WARN` — judgment call; fix it or explain why it stays.
- `INFO` — optional cleanup.

## Rules

| Rule | Default | Catches |
|---|---|---|
| `empty-catch` | BLOCK | Empty catch blocks and silent `.catch(() => {})` handlers |
| `hardcoded-secret` | BLOCK | API keys, tokens, passwords, private key material |
| `disabled-typecheck` | WARN | `@ts-ignore`, `@ts-expect-error`, `as any`, blanket eslint disables |
| `placeholder` | WARN | TODO/FIXME, "not implemented", lorem ipsum, stub copy |
| `test-focus` | BLOCK/WARN | `.only` (block), `.skip`/`xit`/`xdescribe` (warn) |
| `debug-leftover` | WARN | `console.log`, `debugger`, `alert()` |

## Suppression

Only suppress a finding when it is intentional and you can say why:

```js
// slopgate-ignore-next-line empty-catch -- the cache failure is non-fatal and already reported upstream
try { cache.set(key, value); } catch {}
```

A suppression without a written reason does nothing. Never add a suppression just to make the score green.

## Reporting

Keep the summary short. For blockers, show `file:line [rule] — why`. If the scan is clean, say so plainly. If warnings remain, name the important ones and leave the rest out.
