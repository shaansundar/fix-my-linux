import type { DiffRow } from "@/components/bui/CodeBlock";

/** Parses a unified diff (as opencode sends for edits) into Code Block rows. */
export function parseUnifiedDiff(diff: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  for (const line of diff.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      continue;
    }
    if (line.startsWith("---") || line.startsWith("+++") || line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("\\")) {
      continue;
    }
    if (line.startsWith("+")) {
      rows.push({ old: null, cur: newLine++, type: "add", pieces: [{ text: line.slice(1) }] });
    } else if (line.startsWith("-")) {
      rows.push({ old: oldLine++, cur: null, type: "del", pieces: [{ text: line.slice(1) }] });
    } else if (line.startsWith(" ") && (oldLine || newLine)) {
      rows.push({ old: oldLine++, cur: newLine++, type: "ctx", pieces: [{ text: line.slice(1) }] });
    }
  }
  return rows;
}
