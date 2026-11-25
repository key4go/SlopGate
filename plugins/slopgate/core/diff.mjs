function cleanHeaderPath(raw) {
  let value = String(raw).split("\t")[0].trim();

  if (value.startsWith('"') && value.endsWith('"')) {
    value = value
      .slice(1, -1)
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\")
      .replace(/\\t/g, "\t")
      .replace(/\\n/g, "\n");
  }

  return value;
}

/**
 * Parse a unified git diff into files containing only added lines.
 * Deleted files, binary diffs, and files with no added lines are omitted.
 *
 * @param {string} diffText
 * @returns {Array<{ path: string, status: string, added: Array<{ line: number, text: string }> }>}
 */
export function parseUnifiedDiff(diffText) {
  const files = [];
  let current = null;
  let inHunk = false;
  let newLine = 0;
  let isNewFile = false;
  let isDeletedFile = false;
  let isRenamed = false;

  const finishCurrent = () => {
    if (!current) return;
    if (isDeletedFile) {
      current = null;
      return;
    }
    if (current.added.length === 0) {
      current = null;
      return;
    }

    const seenLines = new Set();
    current.added = current.added.filter((entry) => {
      if (seenLines.has(entry.line)) return false;
      seenLines.add(entry.line);
      return true;
    });

    if (current.added.length === 0) {
      current = null;
      return;
    }

    current.status = isNewFile
      ? "added"
      : isRenamed
        ? "renamed"
        : current.status;
    files.push(current);
    current = null;
  };

  for (const rawLine of String(diffText).split(/\r?\n/)) {
    if (rawLine.startsWith("diff --git ")) {
      finishCurrent();
      inHunk = false;
      isNewFile = false;
      isDeletedFile = false;
      isRenamed = false;
      continue;
    }

    if (!inHunk && rawLine.startsWith("--- ")) {
      const oldPath = cleanHeaderPath(rawLine.slice(4));
      isNewFile = oldPath === "/dev/null";
      continue;
    }

    if (!inHunk && rawLine.startsWith("+++ ")) {
      const newPath = cleanHeaderPath(rawLine.slice(4));
      if (newPath === "/dev/null") {
        isDeletedFile = true;
        current = null;
        continue;
      }

      const path = newPath.startsWith("b/") ? newPath.slice(2) : newPath;
      current = {
        path,
        status: isNewFile ? "added" : "modified",
        added: [],
      };
      continue;
    }

    if (!inHunk && rawLine.startsWith("rename to ")) {
      isRenamed = true;
      continue;
    }

    if (!inHunk && rawLine.startsWith("@@")) {
      const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(rawLine);
      if (hunk) newLine = Number(hunk[3]);
      else newLine = 1;
      inHunk = true;
      continue;
    }

    if (!inHunk) continue;

    if (rawLine.startsWith("+")) {
      if (current) {
        current.added.push({ line: newLine, text: rawLine.slice(1) });
      }
      newLine += 1;
      continue;
    }

    if (rawLine.startsWith("-")) {
      // Deleted line: the new-file line counter does not move.
      continue;
    }

    if (rawLine.startsWith(" ")) {
      newLine += 1;
      continue;
    }

    if (rawLine.startsWith("\\")) {
      continue;
    }
  }

  finishCurrent();
  return files;
}
