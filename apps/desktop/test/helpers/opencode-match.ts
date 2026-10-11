import { decide as decideWith } from "../../src/main/opencode/wildcard";

export function decide(rules: Record<string, string>, subject: string): string {
  return decideWith(rules, subject, "ask");
}
