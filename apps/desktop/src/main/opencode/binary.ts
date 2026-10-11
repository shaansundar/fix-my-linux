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

export function binaryPath(resourcesDir: string, variant: Variant): string {
  return join(resourcesDir, "bin", variant, "opencode");
}
