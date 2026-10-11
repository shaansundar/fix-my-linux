import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccountService, ApiError, type Vault } from "../../src/main/account";
import type { AccountState } from "../../src/shared/account";

const vault = (weak = false): Vault => ({
  available: () => true,
  weak: () => weak,
  encrypt: (s) => Buffer.from(`enc:${s}`),
  decrypt: (b) => b.toString().replace(/^enc:/, ""),
});

type Call = { method: string; url: string; auth: string | null; body: unknown };

function fakeApi(routes: Record<string, (body: unknown, auth: string | null) => [number, unknown]>) {
  const calls: Call[] = [];
  const f: typeof fetch = async (input, init) => {
    const url = String(input);
    const auth = (init?.headers as Record<string, string>)["authorization"] ?? null;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init?.method ?? "GET", url, auth, body });
    const key = `${init?.method ?? "GET"} ${new URL(url).pathname}`;
    const route = routes[key];
    if (!route) return new Response("not found", { status: 404 });
    const [status, payload] = route(body, auth);
    return new Response(status === 204 ? null : JSON.stringify(payload), { status });
  };
  return { f, calls };
}

describe("AccountService", () => {
  let dir: string;
  let states: AccountState[];
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "fml-acct-"));
    states = [];
  });
  afterEach(async () => rm(dir, { recursive: true, force: true }));

  const trial = { email: "ana@example.com", state: "trial", daily_limit: 300, used_today: 0 };

  it("signs in with an email code, saves the token encrypted, and reports the account", async () => {
    const api = fakeApi({
      "POST /v1/auth/otp/start": () => [204, null],
      "POST /v1/auth/otp/verify": (b) => ((b as { code: string }).code === "123456" ? [200, { token: "fml_tok", account: trial }] : [400, { error: { code: "invalid_code", message: "That code isn't right" } }]),
    });
    const svc = new AccountService({ apiBase: "https://api.test", tokenFile: join(dir, "t"), vault: vault(), fetch: api.f, onChange: (s) => states.push(s) });
    await svc.startSignIn("ana@example.com");
    await expect(svc.verify("ana@example.com", "000000")).rejects.toMatchObject({ code: "invalid_code", status: 400 });
    await svc.verify("ana@example.com", "123456");

    expect(svc.deviceToken).toBe("fml_tok");
    expect(states.at(-1)).toMatchObject({ status: "signed-in", account: { state: "trial" } });
    expect((await readFile(join(dir, "t"))).toString()).toBe("enc:fml_tok");
    expect((await stat(join(dir, "t"))).mode & 0o777).toBe(0o600);
    const verify = api.calls.find((c) => c.url.endsWith("/verify"))!;
    expect((verify.body as { machine_id: string }).machine_id).toMatch(/\w{16,}/);
    expect(verify.auth).toBeNull();
  });

  it("restores a saved session and sends the token", async () => {
    const api = fakeApi({ "GET /v1/me": (_b, auth) => (auth === "Bearer fml_saved" ? [200, trial] : [401, { error: { code: "signed_out" } }]) });
    const svc = new AccountService({ apiBase: "https://api.test", tokenFile: join(dir, "t"), vault: vault(), fetch: api.f, onChange: (s) => states.push(s) });
    await (await import("node:fs/promises")).writeFile(join(dir, "t"), "enc:fml_saved");
    await svc.restore();
    expect(states.at(-1)).toMatchObject({ status: "signed-in", account: { email: "ana@example.com" } });
  });

  it("forgets a revoked token", async () => {
    const api = fakeApi({ "GET /v1/me": () => [401, { error: { code: "signed_out" } }] });
    const svc = new AccountService({ apiBase: "https://api.test", tokenFile: join(dir, "t"), vault: vault(), fetch: api.f, onChange: (s) => states.push(s) });
    await (await import("node:fs/promises")).writeFile(join(dir, "t"), "enc:old");
    await svc.restore();
    expect(svc.deviceToken).toBeNull();
    expect(states.at(-1)?.status).toBe("signed-out");
    await expect(stat(join(dir, "t"))).rejects.toThrow();
  });

  it("stays signed in but offline when the server can't be reached", async () => {
    const f: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };
    const svc = new AccountService({ apiBase: "https://api.test", tokenFile: join(dir, "t"), vault: vault(), fetch: f, onChange: (s) => states.push(s) });
    await (await import("node:fs/promises")).writeFile(join(dir, "t"), "enc:tok");
    await svc.restore();
    expect(svc.deviceToken).toBe("tok");
    expect(states.at(-1)?.status).toBe("offline");
  });

  it("reports weak token storage when there is no keyring", async () => {
    const svc = new AccountService({ apiBase: "https://api.test", tokenFile: join(dir, "t"), vault: vault(true), fetch: fakeApi({}).f, onChange: (s) => states.push(s) });
    await svc.restore();
    expect(states.at(-1)).toEqual({ status: "signed-out", weakStorage: true });
  });

  it("signs out locally even if the server call fails", async () => {
    const api = fakeApi({ "POST /v1/auth/otp/verify": () => [200, { token: "fml_t", account: trial }] });
    const svc = new AccountService({ apiBase: "https://api.test", tokenFile: join(dir, "t"), vault: vault(), fetch: api.f, onChange: (s) => states.push(s) });
    await svc.verify("ana@example.com", "123456");
    await svc.signOut();
    expect(svc.deviceToken).toBeNull();
    expect(states.at(-1)?.status).toBe("signed-out");
  });

  it("surfaces API errors with their code", async () => {
    const svc = new AccountService({
      apiBase: "https://api.test",
      tokenFile: join(dir, "t"),
      vault: vault(),
      fetch: fakeApi({ "POST /v1/auth/otp/start": () => [429, { error: { code: "too_many_codes", message: "Too many codes" } }] }).f,
      onChange: () => undefined,
    });
    const err = await svc.startSignIn("a@b.co").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 429, code: "too_many_codes", message: "Too many codes" });
  });
});
