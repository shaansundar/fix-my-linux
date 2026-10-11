/**
 * Cross-compiles tools/askpass into apps/desktop/resources/bin/<variant>/fml-askpass.
 * x64 targets the oldest CPUs (GOAMD64=v1), so the baseline opencode build
 * shares the linux-x64 helper.
 *
 *   node scripts/build-askpass.ts            # Linux release variants + this machine
 *   node scripts/build-askpass.ts --host     # only this machine (dev)
 */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const TARGETS: Record<string, { GOOS: string; GOARCH: string; GOAMD64?: string }> = {
  "linux-x64": { GOOS: "linux", GOARCH: "amd64", GOAMD64: "v1" },
  "linux-arm64": { GOOS: "linux", GOARCH: "arm64" },
  "darwin-arm64": { GOOS: "darwin", GOARCH: "arm64" },
  "darwin-x64": { GOOS: "darwin", GOARCH: "amd64" },
};

const host = `${process.platform}-${process.arch === "arm64" ? "arm64" : "x64"}`;
const variants = process.argv.includes("--host")
  ? [host]
  : [...new Set(["linux-x64", "linux-arm64", host])];

for (const variant of variants) {
  const target = TARGETS[variant];
  if (!target) throw new Error(`unknown variant ${variant}`);
  const out = resolve("apps/desktop/resources/bin", variant, "fml-askpass");
  execFileSync("go", ["build", "-trimpath", "-ldflags=-s -w", "-o", out, "."], {
    cwd: resolve("tools/askpass"),
    env: { ...process.env, CGO_ENABLED: "0", ...target },
    stdio: "inherit",
  });
  console.log(`fml-askpass ${variant} -> ${out}`);
}
