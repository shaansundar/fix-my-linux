/** Home screen data, read locally by the main process. */

export type SystemFact = {
  key: string;
  title: string;
  body: string;
  detail: string;
  /** The command or file the fact came from, shown as its source. */
  source: string;
};

export type SystemSample = {
  /** Seconds since the epoch. */
  time: number;
  cpu: number;
  memory: number;
  disk: number;
  /** Bytes per second. */
  rxRate: number;
  txRate: number;
};

export type HealthItem = {
  key: string;
  title: string;
  body: string;
  confidence: "high" | "medium";
  /** What to ask the assistant when the person says "Fix it". */
  prompt: string;
};
