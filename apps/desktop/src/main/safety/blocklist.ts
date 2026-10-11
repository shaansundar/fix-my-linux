import { DENY_BASH } from "../opencode/permissions";
import { match, simpleCommands } from "../opencode/wildcard";

/**
 * Deletions the app refuses outright, matched precisely: recursive rm of the
 * whole disk, a top-level system folder, or a whole home folder.
 */
const HARD_BLOCK: RegExp[] = [
  /^(sudo\s+)?rm\s+(?=(?:[^|;&]*\s)?(?:-\w*[rR]|--recursive))[^|;&]*\s(\/|\/\*|~|~\/|~\/\*|\$HOME\/?\*?|"\$HOME"\/?\*?|\/home\/?\*?|\/home\/[^/\s]+\/?\*?|\/(etc|usr|boot|bin|sbin|lib|lib64|var|opt|root|srv)\/?\*?)(\s|$)/,
];

export function isBlocked(command: string): boolean {
  return simpleCommands(command).some(
    (part) => DENY_BASH.some((pattern) => match(part, pattern)) || HARD_BLOCK.some((re) => re.test(part)),
  );
}

