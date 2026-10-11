import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import type { Account, AccountState } from "../shared/account";

/**
 * The signed-in account: sign-in with an email code, the device token
 * (encrypted at rest with the OS keyring), and the account's plan and usage.
 */

/** Encrypts the token at rest; Electron's safeStorage in the app. */
export interface Vault {
  available(): boolean;
  /** "basic_text" on Linux means no keyring: the token is only obfuscated. */
  weak(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(data: Buffer): string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** A stable per-computer id; the server only ever stores an HMAC of it. */
export async function machineID(): Promise<string> {
  for (const p of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
    try {
      const id = (await readFile(p, "utf8")).trim();
      if (id) return id;
    } catch {
      // try the next one
    }
  }
  // Development on macOS: derive something stable from the host name.
  return createHash("sha256").update(`fml-dev:${hostname()}`).digest("hex").slice(0, 32);
}

export type AccountDeps = {
  apiBase: string;
  tokenFile: string;
  vault: Vault;
  fetch?: typeof fetch;
  onChange(state: AccountState): void;
};

export class AccountService {
  private token: string | null = null;
  private state: AccountState = { status: "signed-out", weakStorage: false };

  constructor(private readonly deps: AccountDeps) {}

  get deviceToken(): string | null {
    return this.token;
  }

  current(): AccountState {
    return this.state;
  }

  private set(next: AccountState): void {
    this.state = next;
    this.deps.onChange(next);
  }

  private async call<T>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (auth && this.token) headers["authorization"] = `Bearer ${this.token}`;
    const res = await (this.deps.fetch ?? fetch)(`${this.deps.apiBase}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // not JSON
    }
    if (!res.ok) {
      const err = (json as { error?: { code?: string; message?: string } } | null)?.error;
      throw new ApiError(res.status, err?.code ?? "http_error", err?.message || `Request failed (${res.status})`);
    }
    return json as T;
  }

  /** Loads a saved token and the account behind it. */
  async restore(): Promise<void> {
    const weak = this.deps.vault.weak();
    try {
      const data = await readFile(this.deps.tokenFile);
      this.token = this.deps.vault.decrypt(data);
    } catch {
      this.token = null;
    }
    if (!this.token) {
      this.set({ status: "signed-out", weakStorage: weak });
      return;
    }
    try {
      await this.refresh();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        await this.forget();
        return;
      }
      // Offline: keep the token and try again later.
      this.set({ status: "offline", weakStorage: weak, account: this.state.account });
    }
  }

  async refresh(): Promise<Account> {
    const account = await this.call<Account>("GET", "/v1/me");
    this.set({ status: "signed-in", weakStorage: this.deps.vault.weak(), account });
    return account;
  }

  async startSignIn(email: string): Promise<void> {
    await this.call("POST", "/v1/auth/otp/start", { email }, false);
  }

  async verify(email: string, code: string): Promise<Account> {
    const out = await this.call<{ token: string; account: Account }>(
      "POST",
      "/v1/auth/otp/verify",
      { email, code, machine_id: await machineID() },
      false,
    );
    this.token = out.token;
    if (this.deps.vault.available()) {
      await writeFile(this.deps.tokenFile, this.deps.vault.encrypt(out.token), { mode: 0o600 });
    }
    this.set({ status: "signed-in", weakStorage: this.deps.vault.weak(), account: out.account });
    return out.account;
  }

  async checkoutURL(): Promise<string> {
    return (await this.call<{ url: string }>("POST", "/v1/billing/checkout")).url;
  }

  async portalURL(): Promise<string> {
    return (await this.call<{ url: string }>("GET", "/v1/billing/portal")).url;
  }

  async signOut(): Promise<void> {
    try {
      await this.call("POST", "/v1/auth/signout");
    } catch {
      // signing out locally is what matters
    }
    await this.forget();
  }

  private async forget(): Promise<void> {
    this.token = null;
    await rm(this.deps.tokenFile, { force: true });
    this.set({ status: "signed-out", weakStorage: this.deps.vault.weak() });
  }
}
