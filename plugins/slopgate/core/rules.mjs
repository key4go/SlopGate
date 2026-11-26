function lineOfIndex(text, index) {
  return text.slice(0, index).split("\n").length;
}

function collapse(value, max = 180) {
  const text = String(value).replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function withGlobal(pattern) {
  return pattern.global
    ? pattern
    : new RegExp(pattern.source, `${pattern.flags}g`);
}

function dedupeByLine(findings) {
  const seen = new Set();
  return findings.filter((finding) => {
    if (seen.has(finding.line)) return false;
    seen.add(finding.line);
    return true;
  });
}

function scanLinePatterns(ctx, patterns, { severityFor } = {}) {
  const findings = [];

  for (let index = 0; index < ctx.lines.length; index += 1) {
    const text = ctx.lines[index];

    for (const pattern of patterns) {
      const regex = withGlobal(pattern);
      let match;
      while ((match = regex.exec(text)) !== null) {
        findings.push({
          line: index + 1,
          column: match.index + 1,
          snippet: text,
          severity: severityFor?.(ctx, match),
          match: match[0],
        });
        if (match[0].length === 0) break;
      }
    }
  }

  return dedupeByLine(findings);
}

function redactValue(value) {
  const text = String(value).replace(/^["'`]|["'`]$/g, "");
  if (text.length <= 8) return "***";
  return `${text.slice(0, 4)}…${text.slice(-4)}`;
}

function redactSecretText(text, secret) {
  let result = String(text);
  if (secret) result = result.split(secret).join(redactValue(secret));
  return result
    .replace(/(["'`])([^"'`\n]{12,})\1/g, (match, quote, value) =>
      `${quote}${redactValue(value)}${quote}`,
    )
    .replace(
      /\b(?:sk-|sk_live_|rk_live_|ghp_|github_pat_|xox[baprs]-|AKIA|AIza)[A-Za-z0-9_-]{8,}\b/g,
      (match) => redactValue(match),
    );
}

function looksPlaceholder(value) {
  const text = String(value).trim().replace(/^["'`]|["'`]$/g, "");

  if (text.length < 8) return true;
  if (/^(?:\$\{|process\.env|import\.meta\.env|os\.environ|env\.)/i.test(text)) {
    return true;
  }
  if (
    /(?:your[_-]?|example|sample|changeme|change[_-]?me|replace[_-]?me|placeholder|dummy|fake|test|redacted|xxxx|<[^>]+>|\*{3,}|\.\.\.)/i.test(
      text,
    )
  ) {
    return true;
  }
  if (/^[.\-_/]+$/.test(text)) return true;
  if (/^[A-Z0-9_]+$/.test(text) && text.length < 12) return true;

  return false;
}

function isDotEnv(path) {
  const base = String(path).split("/").pop() ?? String(path);
  return base === ".env" || base.startsWith(".env.");
}

const emptyCatchRule = {
  id: "empty-catch",
  title: "Empty catch block",
  severity: "block",
  why: "An empty catch hides failures, so the app keeps running with bad state.",
  fix: "Handle the error, log it with context, or rethrow it.",
  detect(ctx) {
    const findings = [];
    const seenLines = new Set();

    const emptyCatch = /catch\s*(?:\([^)]*\))?\s*\{\s*(?:(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/)\s*)*\}/g;
    let match;
    while ((match = emptyCatch.exec(ctx.text)) !== null) {
      const line = lineOfIndex(ctx.text, match.index);
      if (seenLines.has(line)) continue;
      seenLines.add(line);
      findings.push({
        line,
        column: 1,
        snippet: collapse(match[0]),
        severity: "block",
      });
    }

    const silentPromiseCatch =
      /\.catch\s*\(\s*(?:(?:\(\s*[\w$]*\s*\)|[\w$]+)\s*=>|function\s*\(\s*[\w$]*\s*\))\s*\{\s*\}\s*\)/g;
    while ((match = silentPromiseCatch.exec(ctx.text)) !== null) {
      const line = lineOfIndex(ctx.text, match.index);
      if (seenLines.has(line)) continue;
      seenLines.add(line);
      findings.push({
        line,
        column: 1,
        snippet: collapse(match[0]),
        severity: "block",
      });
    }

    return findings;
  },
};

const hardcodedSecretRule = {
  id: "hardcoded-secret",
  title: "Hardcoded secret",
  severity: "block",
  why: "A secret in source will be committed, copied, and shared with everyone who sees the repo.",
  fix: "Move it to an environment variable and rotate the exposed secret.",
  detect(ctx) {
    const findings = [];
    const seenLines = new Set();
    const defaultSeverity = ctx.isTest ? "warn" : "block";

    const add = (line, column, snippet) => {
      if (seenLines.has(line)) return;
      seenLines.add(line);
      findings.push({
        line,
        column,
        snippet,
        severity: defaultSeverity,
      });
    };

    const tokenPatterns = [
      /\b(?:sk-[A-Za-z0-9_-]{20,}|sk_live_[A-Za-z0-9]{10,}|rk_live_[A-Za-z0-9]{10,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35})\b/g,
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
    ];

    for (let index = 0; index < ctx.lines.length; index += 1) {
      const text = ctx.lines[index];

      for (const pattern of tokenPatterns) {
        const regex = withGlobal(pattern);
        let match;
        while ((match = regex.exec(text)) !== null) {
          add(
            index + 1,
            match.index + 1,
            redactSecretText(text, match[0]),
          );
          if (match[0].length === 0) break;
        }
      }

      const assignment =
        /\b(api[_-]?key|secret|password|passwd|token|access[_-]?key|private[_-]?key)\b\s*[:=]\s*(["'`])([^"'`\n]{8,})\2/gi;
      let assignmentMatch;
      while ((assignmentMatch = assignment.exec(text)) !== null) {
        const value = assignmentMatch[3];
        if (!looksPlaceholder(value)) {
          add(
            index + 1,
            assignmentMatch.index + 1,
            redactSecretText(text, value),
          );
        }
        if (assignmentMatch[0].length === 0) break;
      }

      if (isDotEnv(ctx.path)) {
        const envMatch =
          /^\s*([A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASS|PRIVATE)[A-Z0-9_]*)\s*=\s*(.+?)\s*$/i.exec(
            text,
          );
        if (envMatch) {
          const value = envMatch[2];
          if (!looksPlaceholder(value) && !/^\$/.test(value)) {
            add(index + 1, 1, redactSecretText(text, value));
          }
        }
      }
    }

    return findings;
  },
};

const disabledTypecheckRule = {
  id: "disabled-typecheck",
  title: "Disabled type checking",
  severity: "warn",
  why: "Suppressing the type checker hides the mismatch that often becomes the runtime bug.",
  fix: "Fix or narrow the type. If it is intentional, add a short written reason.",
  detect(ctx) {
    return scanLinePatterns(ctx, [
      /@ts-ignore\b/g,
      /@ts-expect-error\b/g,
      /@ts-nocheck\b/g,
      /\bas\s+any\b/g,
      /\/\/\s*eslint-disable(?:-next-line|-line)?\s*$/g,
      /\/\*\s*eslint-disable\s*\*\//g,
    ]);
  },
};

const placeholderRule = {
  id: "placeholder",
  title: "Placeholder or unfinished code",
  severity: "warn",
  why: "Placeholder code ships when the task looks finished but the behavior is not there.",
  fix: "Implement it, or mark it with a tracked issue before finishing.",
  detect(ctx) {
    return scanLinePatterns(ctx, [
      /(?:\/\/|\/\*|\*)\s*(?:TODO|FIXME|XXX|HACK)\b/gi,
      /\bnot implemented\b/gi,
      /lorem ipsum/gi,
      /\bthrow\s+new\s+Error\(\s*["'`](?:todo|not implemented|coming soon)/gi,
      // slopgate-ignore-next-line placeholder -- this pattern detects unfinished Swift code
      ...(ctx.path.toLowerCase().endsWith(".swift") ? [/\bfatalError\s*\(\s*"(?:todo|not implemented|coming soon)/gi] : []),
    ]);
  },
};

const testFocusRule = {
  id: "test-focus",
  title: "Focused or skipped test",
  severity: "warn",
  why: "A focused test silently skips the rest of the suite. A skipped test hides a failure.",
  fix: "Remove focus and skip markers before committing.",
  detect(ctx) {
    if (!ctx.isTest) return [];

    const findings = [];
    const byLine = new Map();

    const add = (line, column, snippet, severity) => {
      const existing = byLine.get(line);
      if (existing) {
        if (severity === "block") existing.severity = "block";
        return;
      }
      const finding = { line, column, snippet, severity };
      byLine.set(line, finding);
      findings.push(finding);
    };

    for (let index = 0; index < ctx.lines.length; index += 1) {
      const text = ctx.lines[index];

      const only = /\.only\s*\(/g;
      let match;
      while ((match = only.exec(text)) !== null) {
        add(index + 1, match.index + 1, text, "block");
      }

      const skip = /\.skip\s*\(/g;
      while ((match = skip.exec(text)) !== null) {
        add(index + 1, match.index + 1, text, "warn");
      }

      if (ctx.path.toLowerCase().endsWith(".swift")) {
        const swiftSkip = /(?:\bXCTSkip(?:If|Unless)?\s*\(|\.disabled\s*\()/g;
        while ((match = swiftSkip.exec(text)) !== null) {
          add(index + 1, match.index + 1, text, "warn");
        }
      }

      const xit = /\b(?:xit|xdescribe|fit|fdescribe)\s*\(/g;
      while ((match = xit.exec(text)) !== null) {
        add(index + 1, match.index + 1, text, "warn");
      }
    }

    return findings;
  },
};

const debugLeftoverRule = {
  id: "debug-leftover",
  title: "Debug leftover",
  severity: "warn",
  why: "Debug output leaks internals, clutters logs, and is easy to forget.",
  fix: "Remove it, or use the project logger at the right level.",
  detect(ctx) {
    return scanLinePatterns(
      ctx,
      [
        /console\.(?:log|debug|dir|trace)\s*\(/g,
        /\bdebugger\b/g,
        /\balert\s*\(/g,
        ...(ctx.path.toLowerCase().endsWith(".swift") ? [/\b(?:print|debugPrint|dump)\s*\(/g] : []),
      ],
      {
        severityFor: () => (ctx.isTest ? "info" : "warn"),
      },
    );
  },
};

export const RULES = [
  emptyCatchRule,
  hardcodedSecretRule,
  disabledTypecheckRule,
  placeholderRule,
  testFocusRule,
  debugLeftoverRule,
];

export const RULES_BY_ID = new Map(RULES.map((rule) => [rule.id, rule]));

export function isKnownRule(ruleId) {
  return RULES_BY_ID.has(ruleId);
}

export function findSuppression(lines, line, ruleId) {
  const previous = line - 2 >= 0 ? lines[line - 2] : "";
  const current = line - 1 >= 0 ? lines[line - 1] : "";

  const check = (text) => {
    if (!text) return null;
    const match =
      /slopgate-ignore(?:-next-line|-line)?\s+([a-z0-9-]+)\s+--\s+(.+?)(?:\*\/)?\s*$/i.exec(
        text,
      );
    if (!match) return null;
    if (match[1].toLowerCase() !== ruleId) return null;
    const reason = match[2].trim();
    return reason.length > 0 ? reason : null;
  };

  return check(current) ?? check(previous);
}

export const ruleMeta = RULES.map(({ id, title, severity, why, fix }) => ({
  id,
  title,
  severity,
  why,
  fix,
}));
