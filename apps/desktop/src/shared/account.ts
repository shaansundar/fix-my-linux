/** The account as the backend reports it (GET /v1/me). */
export type Account = {
  email: string;
  state: "trial" | "active" | "expired";
  reason?: "trial_ended" | "trial_unavailable" | "payment_required" | string;
  trial_ends_at?: string;
  period_start?: string;
  period_end?: string;
  cancels_at?: string;
  budget_usd?: number;
  used_usd?: number;
  daily_limit?: number;
  used_today?: number;
};

export type AccountState = {
  status: "signed-out" | "signed-in" | "offline";
  /** No OS keyring: the saved sign-in is only obfuscated on disk. */
  weakStorage: boolean;
  account?: Account;
};
