import { describe, expect, it } from "vitest";
import { pickVariant } from "../../src/main/opencode/binary";

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
