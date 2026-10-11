import { describe, expect, it } from "vitest";
import { parseMeminfo, parseNetDev, parseOsRelease } from "../../src/main/system";

describe("system parsers", () => {
  it("reads os-release", () => {
    expect(parseOsRelease('NAME="Ubuntu"\nVERSION_ID="24.04"\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\nID=ubuntu\n')).toMatchObject({
      PRETTY_NAME: "Ubuntu 24.04.1 LTS",
      ID: "ubuntu",
      VERSION_ID: "24.04",
    });
  });

  it("uses MemAvailable, not MemFree", () => {
    const raw = "MemTotal:       16000000 kB\nMemFree:          500000 kB\nMemAvailable:    8000000 kB\n";
    expect(parseMeminfo(raw)).toEqual({ totalKB: 16000000, availableKB: 8000000 });
    expect(parseMeminfo("garbage")).toBeNull();
  });

  it("sums real network interfaces and skips loopback and virtual ones", () => {
    const raw = [
      "Inter-|   Receive                                                |  Transmit",
      " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed",
      "    lo: 9999999    100    0    0    0     0          0         0 9999999    100    0    0    0     0       0          0",
      "wlp2s0: 1000    10    0    0    0     0          0         0 500    5    0    0    0     0       0          0",
      "enp3s0: 2000    10    0    0    0     0          0         0 700    5    0    0    0     0       0          0",
      "docker0: 5555    10    0    0    0     0          0         0 5555    5    0    0    0     0       0          0",
    ].join("\n");
    expect(parseNetDev(raw)).toEqual({ rx: 3000, tx: 1200 });
  });
});
