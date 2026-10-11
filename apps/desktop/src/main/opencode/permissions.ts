/**
 * The opencode permission ruleset. opencode's rules are wildcard matches over
 * the whole command string or path, which flags, globs and extra arguments
 * slip past, so nothing is auto-allowed here: every bash call and file access
 * comes to the app as a permission request and the approval broker decides
 * with a real parser (see safety/policy.ts). The deny rules below are a
 * backstop that holds even if the broker were bypassed.
 *
 * Facts this relies on (opencode 1.19, re-check before upgrading):
 * - Rules are evaluated last-match-wins, so key order matters.
 * - Bash commands are split with tree-sitter and each simple command is
 *   matched on its own; any deny wins.
 * - Subagents don't inherit agent rules, so everything is top-level and
 *   `task` is denied.
 * - Replying "always" overrides deny rules process-wide; the broker never does.
 */

export type Action = "allow" | "ask" | "deny";
export type RuleMap = Record<string, Action>;

/** Patterns refused outright. */
export const DENY_BASH = [
  // Exact forms only: opencode's `*` cannot match a literal asterisk, so
  // "rm -rf /*" would also block "rm -rf /var/cache/apt/archives/*". Broader
  // whole-disk and whole-home deletions are caught by the broker (blocklist.ts).
  "rm -rf /", "rm -fr /", "rm -rf ~", "rm -rf ~/", "rm -fr ~", "rm -fr ~/",
  "rm -rf $HOME", "rm -rf $HOME/", "rm --no-preserve-root*", "rm * --no-preserve-root*",
  "mkfs*", "dd * of=/dev/*", "chmod -R 777 /*", "chown -R * /",
  // A shell reading from a pipe is how `curl ... | sh` runs; each side of a pipe is matched on its own.
  "sh", "bash", "zsh", "sh -s*", "bash -s*", "sh -", "bash -",
  ":(){*",
  "shutdown*", "poweroff*", "halt*", "init 0*",
];

export function bashRules(): RuleMap {
  const rules: RuleMap = { "*": "ask" };
  for (const p of DENY_BASH) rules[p] = "deny";
  return rules;
}

export type PermissionConfig = Record<string, Action | RuleMap>;

export function permissionConfig(): PermissionConfig {
  return {
    bash: bashRules(),
    // File tools ask so the broker can resolve paths and protect private files.
    read: "ask",
    glob: "ask",
    grep: "ask",
    list: "ask",
    external_directory: "ask",
    edit: "ask",
    webfetch: "ask",
    // Would call a third-party search API directly, bypassing our proxy.
    websearch: "deny",
    task: "deny",
    skill: "deny",
    lsp: "deny",
    todowrite: "allow",
    question: "allow",
    doom_loop: "ask",
  };
}

/**
 * Deny rules passed to session.create. Unlike agent rules, session rules also
 * reach child sessions, so they back up the config if a subagent ever runs.
 */
export function sessionDenyRules(): Array<{ permission: string; pattern: string; action: "deny" }> {
  return [
    ...DENY_BASH.map((pattern) => ({ permission: "bash", pattern, action: "deny" as const })),
    { permission: "task", pattern: "*", action: "deny" },
    { permission: "websearch", pattern: "*", action: "deny" },
  ];
}
