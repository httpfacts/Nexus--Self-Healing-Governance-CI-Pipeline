import { diffLines } from "diff";

// Turns two full file strings into small, git-diff-style hunks (changed
// lines plus a couple of lines of context) instead of showing the whole
// file twice -- that's the "small patch" NEXUS shows next to a
// failure, not a full before/after dump.
export function buildHunks(before, after, context = 2) {
  const parts = diffLines(before || "", after || "");
  const lines = [];
  for (const part of parts) {
    const type = part.added ? "add" : part.removed ? "remove" : "context";
    const partLines = part.value.replace(/\n$/, "").split("\n");
    for (const text of partLines) lines.push({ type, text });
  }

  const changedIdx = lines.map((l, i) => (l.type !== "context" ? i : -1)).filter((i) => i >= 0);
  if (changedIdx.length === 0) return [];

  const windows = [];
  let start = Math.max(0, changedIdx[0] - context);
  let end = Math.min(lines.length - 1, changedIdx[0] + context);
  for (let k = 1; k < changedIdx.length; k++) {
    const idx = changedIdx[k];
    const newStart = Math.max(0, idx - context);
    if (newStart <= end + 1) {
      end = Math.min(lines.length - 1, idx + context);
    } else {
      windows.push([start, end]);
      start = newStart;
      end = Math.min(lines.length - 1, idx + context);
    }
  }
  windows.push([start, end]);

  return windows.map(([s, e]) => lines.slice(s, e + 1));
}
