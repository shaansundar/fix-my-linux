/**
 * Fixed programs the app itself runs on the computer (package dry runs,
 * the Home screen's checks). The Flatpak build lives in a sandbox with its
 * own /usr and /etc, so there they go through `flatpak-spawn --host`, which
 * starts from the host session's environment: extra variables are passed
 * as --env.
 */

export type HostCommand = { file: string; args: string[]; env: Record<string, string> };

export function hostCommand(flatpak: boolean, file: string, args: string[], env: Record<string, string> = {}): HostCommand {
  if (!flatpak) return { file, args, env };
  const passed = Object.entries(env).map(([k, v]) => `--env=${k}=${v}`);
  // flatpak-spawn stops reading options at the first non-option: the program.
  return { file: "flatpak-spawn", args: ["--host", "--watch-bus", ...passed, file, ...args], env: {} };
}
