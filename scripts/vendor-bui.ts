/**
 * One-time extractor for Beautiful UI (https://www.beautifului.dev) components.
 *
 * The site embeds each component's full source in its Next.js flight payload as
 * RSC text chunks (`<id>:T<hexByteLength>,<text>`). This script pulls those
 * chunks out and writes one file per component with the MIT notice prepended.
 *
 * After the first run the vendored files are the source of truth and are
 * adapted by hand; re-running overwrites them, so use --out to a scratch dir
 * when diffing against upstream.
 *
 *   node scripts/vendor-bui.ts [--out <dir>] [--html <saved-page.html>]
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const SITE = "https://www.beautifului.dev/";
const DEFAULT_OUT = "apps/desktop/src/renderer/components/bui";

const MIT_HEADER = `/**
 * Vendored from Beautiful UI — https://www.beautifului.dev
 * MIT License, Copyright (c) 2026 Shane Levine. See THIRD_PARTY_NOTICES.md.
 */
`;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function loadHtml(): Promise<string> {
  const saved = arg("--html");
  if (saved) return readFile(saved, "utf8");
  const res = await fetch(SITE);
  if (!res.ok) throw new Error(`failed to fetch ${SITE}: ${res.status}`);
  return res.text();
}

/** Concatenate every string pushed onto self.__next_f. */
export function flightPayload(html: string): string {
  const re = /self\.__next_f\.push\((\[.*?\])\)<\/script>/gs;
  let out = "";
  for (const m of html.matchAll(re)) {
    const arr = JSON.parse(m[1]) as unknown[];
    if (typeof arr[1] === "string") out += arr[1];
  }
  return out;
}

/** RSC text chunks are length-prefixed in UTF-8 bytes, so slice bytes, not chars. */
export function textChunks(flight: string): string[] {
  const bytes = Buffer.from(flight, "utf8");
  const header = /(?:^|\n)[0-9a-f]+:T([0-9a-f]+),/g;
  const chunks: string[] = [];
  for (const m of flight.matchAll(header)) {
    const startChar = (m.index ?? 0) + m[0].length;
    const startByte = Buffer.byteLength(flight.slice(0, startChar), "utf8");
    const len = parseInt(m[1], 16);
    chunks.push(bytes.subarray(startByte, startByte + len).toString("utf8"));
  }
  return chunks;
}

async function main(): Promise<void> {
  const out = resolve(arg("--out") ?? DEFAULT_OUT);
  const chunks = textChunks(flightPayload(await loadHtml()));
  await mkdir(out, { recursive: true });

  const written: string[] = [];
  for (const src of chunks) {
    const name = /export default function (\w+)/.exec(src)?.[1];
    if (!name) continue;
    await writeFile(join(out, `${name}.tsx`), MIT_HEADER + src.trimEnd() + "\n");
    written.push(name);
  }
  if (written.length === 0) throw new Error("no components found; site format may have changed");
  console.log(`wrote ${written.length} components to ${out}:\n  ${written.join("\n  ")}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
