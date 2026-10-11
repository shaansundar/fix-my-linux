import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "@/lib/diff";
import { taskRows, toolStep, toolsHeader } from "@/lib/view";
import type { ToolItem } from "../../src/shared/session";

const tool = (over: Partial<ToolItem>): ToolItem => ({
  kind: "tool",
  id: "t1",
  callID: "c1",
  tool: "bash",
  status: "completed",
  subject: "df -h",
  title: "df -h",
  output: "Filesystem Size\n/dev/sda1 100G\n",
  exitCode: 0,
  error: null,
  explanation: null,
  input: {},
  startedAt: 1,
  endedAt: 2,
  ...over,
});

describe("toolStep", () => {
  it("shows the command and its last output lines", () => {
    expect(toolStep(tool({}))).toMatchObject({ label: "Ran", chip: "df -h", status: "done", detail: [{ text: "Filesystem Size" }, { text: "/dev/sda1 100G" }] });
  });
  it("marks non-zero exits as failed and says so", () => {
    const step = toolStep(tool({ exitCode: 100, output: "E: Unable to locate package" }));
    expect(step.status).toBe("failed");
    expect(step.detail.at(-1)?.text).toBe("Finished with error code 100");
  });
  it("shows a spinner while running", () => {
    expect(toolStep(tool({ status: "running", output: "" }))).toMatchObject({ status: "running", label: "Running", detail: [{ text: "Working…" }] });
  });
});

describe("toolsHeader", () => {
  it("counts commands and other steps", () => {
    expect(toolsHeader([tool({}), tool({ id: "t2", tool: "read" })])).toBe("Ran 1 command and 1 step");
    expect(toolsHeader([tool({ status: "running" })])).toBe("Running 1 command");
  });
});

describe("taskRows", () => {
  it("maps todo statuses", () => {
    const rows = taskRows([
      { content: "a", status: "completed", priority: "high" },
      { content: "b", status: "in_progress", priority: "high" },
      { content: "c", status: "pending", priority: "low" },
      { content: "d", status: "cancelled", priority: "low" },
    ]);
    expect(rows.map((r) => r.status)).toEqual(["done", "running", "pending", "failed"]);
  });
});

describe("parseUnifiedDiff", () => {
  it("numbers context, additions and removals", () => {
    const rows = parseUnifiedDiff("--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n keep\n-old\n+new\n tail\n");
    expect(rows.map((r) => [r.type, r.old, r.cur, r.pieces[0]!.text])).toEqual([
      ["ctx", 1, 1, "keep"],
      ["del", 2, null, "old"],
      ["add", null, 2, "new"],
      ["ctx", 3, 3, "tail"],
    ]);
  });
});
