import { existsSync } from "node:fs";
import { join } from "node:path";

export type Variant = "linux-x64" | "linux-x64-baseline" | "linux-arm64" | "darwin-arm64" | "darwin-x64";

/**
 * The regular x64 build needs AVX2; older laptops get the baseline build.
 * macOS variants exist only for development.
 */
export function pickVariant(platform: NodeJS.Platform, arch: string, cpuinfo = ""): Variant {
  if (platform === "darwin") return arch === "arm64" ? "darwin-arm64" : "darwin-x64";
  if (platform !== "linux") throw new Error(`unsupported platform: ${platform}`);
  if (arch === "arm64") return "linux-arm64";
  if (arch !== "x64") throw new Error(`unsupported architecture: ${arch}`);
  return /^flags\s*:.*\bavx2\b/m.test(cpuinfo) ? "linux-x64" : "linux-x64-baseline";
}

/**
 * Where the variant's opencode lives. Some releases publish the same binary
 * for x64 and baseline, and packaging then ships only the regular copy.
 */
export function binaryPath(resourcesDir: string, variant: Variant, exists: (path: string) => boolean = existsSync): string {
  const path = join(resourcesDir, "bin", variant, "opencode");
  if (variant === "linux-x64-baseline" && !exists(path)) return join(resourcesDir, "bin", "linux-x64", "opencode");
  return path;
}

/** fml-askpass is built for the oldest x64 CPUs, so there's one per architecture. */
export function askpassPath(resourcesDir: string, variant: Variant): string {
  return join(resourcesDir, "bin", variant.replace(/-baseline$/, ""), "fml-askpass");
}
