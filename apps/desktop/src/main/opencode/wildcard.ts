/**
 * opencode 1.19's wildcard semantics (packages/core/src/util/wildcard.ts) and
 * last-match-wins evaluation (permission/index.ts `evaluate`), so the app can
 * predict what opencode will decide.
 */
export function match(subject: string, pattern: string): boolean {
  const s = subject.replaceAll("\\", "/");
  let src = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  // A trailing " *" also matches the bare command: "ls *" matches "ls".
  if (src.endsWith(" .*")) src = `${src.slice(0, -3)}( .*)?`;
  return new RegExp(`^${src}$`, "s").test(s);
}

export function decide<A extends string>(rules: Record<string, A>, subject: string, fallback: A): A {
  let result = fallback;
  for (const [pattern, action] of Object.entries(rules)) {
    if (match(subject, pattern)) result = action;
  }
  return result;
}

/**
 * Splits a shell command into its simple commands, approximating opencode's
 * tree-sitter walk. It over-splits rather than under-splits, which is the safe
 * direction for deny checks.
 */
export function simpleCommands(command: string): string[] {
  const out: string[] = [];
  const subs = [...command.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)].map((m) => m[1] ?? m[2] ?? "");
  for (const text of [command, ...subs]) {
    for (const piece of text.split(/\|\||&&|[;|&\n]/)) {
      const trimmed = piece.replace(/\$\([^()]*\)|`[^`]*`/g, "").trim();
      if (trimmed) out.push(trimmed);
    }
  }
  return out;
}
