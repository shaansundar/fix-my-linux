import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { askpassPath, binaryPath, pickVariant } from "../../src/main/opencode/binary";

const AVX2 = "processor\t: 0\nflags\t\t: fpu vme sse4_2 avx avx2 bmi2\n";
const NO_AVX2 = "processor\t: 0\nflags\t\t: fpu vme sse4_2 avx\n";

describe("pickVariant", () => {
  it.each([
    ["linux", "x64", AVX2, "linux-x64"],
    ["linux", "x64", NO_AVX2, "linux-x64-baseline"],
    ["linux", "x64", "", "linux-x64-baseline"],
    ["linux", "arm64", "", "linux-arm64"],
    ["darwin", "arm64", "", "darwin-arm64"],
  ] as const)("%s/%s → %s", (platform, arch, cpuinfo, expected) => {
    expect(pickVariant(platform, arch, cpuinfo)).toBe(expected);
  });

  it("does not mistake avx2 in another line for a CPU flag", () => {
    expect(pickVariant("linux", "x64", "model name\t: avx2 lover\nflags\t\t: sse4_2\n")).toBe("linux-x64-baseline");
  });

  it("rejects unsupported platforms", () => {
    expect(() => pickVariant("win32", "x64")).toThrow(/unsupported platform/);
    expect(() => pickVariant("linux", "ia32")).toThrow(/unsupported architecture/);
  });
});

describe("binaryPath", () => {
  const res = "/opt/fml/resources";

  it("uses the variant's own build when it's shipped", () => {
    expect(binaryPath(res, "linux-x64-baseline", () => true)).toBe(join(res, "bin/linux-x64-baseline/opencode"));
    expect(binaryPath(res, "linux-arm64", () => true)).toBe(join(res, "bin/linux-arm64/opencode"));
  });

  it("falls back to the regular x64 build when the baseline one isn't shipped", () => {
    expect(binaryPath(res, "linux-x64-baseline", () => false)).toBe(join(res, "bin/linux-x64/opencode"));
  });

  it("never swaps other variants", () => {
    expect(binaryPath(res, "linux-arm64", () => false)).toBe(join(res, "bin/linux-arm64/opencode"));
  });
});

describe("askpassPath", () => {
  it.each([
    ["linux-x64", "bin/linux-x64/fml-askpass"],
    ["linux-x64-baseline", "bin/linux-x64/fml-askpass"],
    ["linux-arm64", "bin/linux-arm64/fml-askpass"],
    ["darwin-arm64", "bin/darwin-arm64/fml-askpass"],
  ] as const)("%s → %s", (variant, rel) => {
    expect(askpassPath("/r", variant)).toBe(join("/r", rel));
  });
});
