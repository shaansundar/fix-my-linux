/**
 * Downloads the pinned opencode binaries from npm, verifies each tarball
 * against the registry's sha512 integrity value, and extracts the single
 * executable into apps/desktop/resources/bin/<variant>/opencode.
 *
 *   node scripts/fetch-opencode.ts                 # all Linux release variants
 *   node scripts/fetch-opencode.ts --host          # only the current machine (dev)
 *   node scripts/fetch-opencode.ts --variants linux-arm64,darwin-arm64
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const OPENCODE_VERSION = "1.19.0";
const RELEASE_VARIANTS = ["linux-x64", "linux-x64-baseline", "linux-arm64"];
const OUT_DIR = resolve("apps/desktop/resources/bin");

type Dist = { tarball: string; integrity: string };

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function hostVariant(): string {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `${process.platform}-${arch}`;
}

async function dist(variant: string): Promise<Dist> {
  const url = `https://registry.npmjs.org/opencode-${variant}/${OPENCODE_VERSION}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`registry lookup failed for ${variant}: ${res.status}`);
  const body = (await res.json()) as { dist?: Partial<Dist> };
  if (!body.dist?.tarball || !body.dist.integrity) throw new Error(`no dist info for ${variant}`);
  return { tarball: body.dist.tarball, integrity: body.dist.integrity };
}

export function verifyIntegrity(data: Buffer, integrity: string): void {
  const [algo, expected] = integrity.split("-", 2);
  if (algo !== "sha512" || !expected) throw new Error(`unsupported integrity format: ${integrity}`);
  const actual = createHash("sha512").update(data).digest("base64");
  if (actual !== expected) throw new Error(`integrity mismatch: expected ${expected}, got ${actual}`);
}

async function fetchVariant(variant: string): Promise<void> {
  const { tarball, integrity } = await dist(variant);
  const res = await fetch(tarball);
  if (!res.ok) throw new Error(`download failed for ${variant}: ${res.status}`);
  const data = Buffer.from(await res.arrayBuffer());
  verifyIntegrity(data, integrity);

  const work = await mkdtemp(join(tmpdir(), "fml-opencode-"));
  try {
    const archive = join(work, "pkg.tgz");
    await writeFile(archive, data);
    execFileSync("tar", ["-xzf", archive, "-C", work, "package/bin/opencode"]);
    const dest = join(OUT_DIR, variant);
    await mkdir(dest, { recursive: true });
    execFileSync("cp", [join(work, "package/bin/opencode"), join(dest, "opencode")]);
    await chmod(join(dest, "opencode"), 0o755);
    await writeFile(join(dest, "VERSION"), `${OPENCODE_VERSION}\n`);
    console.log(`opencode ${OPENCODE_VERSION} ${variant} -> ${dest}`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

/**
 * Some releases publish the same binary as both x64 and baseline. Keeping
 * one copy saves ~180 MB per x64 package; the app falls back to linux-x64
 * when the baseline directory is missing.
 */
async function dropDuplicateBaseline(): Promise<void> {
  const regular = join(OUT_DIR, "linux-x64", "opencode");
  const baseline = join(OUT_DIR, "linux-x64-baseline", "opencode");
  if ((await sha256(regular)) !== (await sha256(baseline))) return;
  await rm(join(OUT_DIR, "linux-x64-baseline"), { recursive: true, force: true });
  console.log("linux-x64-baseline is identical to linux-x64; keeping one copy");
}

async function main(): Promise<void> {
  const variants = process.argv.includes("--host")
    ? [hostVariant()]
    : (arg("--variants")?.split(",") ?? RELEASE_VARIANTS);
  for (const v of variants) await fetchVariant(v);
  if (variants.includes("linux-x64") && variants.includes("linux-x64-baseline")) await dropDuplicateBaseline();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
