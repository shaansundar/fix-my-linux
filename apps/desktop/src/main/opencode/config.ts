import { permissionConfig } from "./permissions";

/** Which models the current plan may use; IDs are Zen model IDs without the provider prefix. */
export type ModelPlan = {
  defaultModel: string;
  /** Used for titles and summaries; must be free on the trial plan. */
  smallModel: string;
  allowed: string[];
};

export type ConfigInput = {
  /** Loopback relay origin, e.g. http://127.0.0.1:41234 */
  relayOrigin: string;
  /** Per-launch secret opencode sends to the relay; never the account token. */
  relayNonce: string;
  plan: ModelPlan;
  promptFile: string;
  shellPath: string;
};

export const PROVIDER_ID = "opencode";
export const AGENT_ID = "fixer";

export function qualified(modelID: string): string {
  return `${PROVIDER_ID}/${modelID}`;
}

/** The complete opencode config; passed inline via OPENCODE_CONFIG_CONTENT. */
export function buildConfig(input: ConfigInput): Record<string, unknown> {
  const { plan } = input;
  const allowed = [...new Set([...plan.allowed, plan.defaultModel, plan.smallModel])];
  return {
    $schema: "https://opencode.ai/config.json",
    enabled_providers: [PROVIDER_ID],
    provider: {
      [PROVIDER_ID]: {
        options: { baseURL: `${input.relayOrigin}/zen/v1`, apiKey: input.relayNonce },
        whitelist: allowed,
      },
    },
    model: qualified(plan.defaultModel),
    small_model: qualified(plan.smallModel),
    share: "disabled",
    autoupdate: false,
    lsp: false,
    formatter: false,
    // A dotfiles repo in $HOME would otherwise make opencode snapshot the whole home directory.
    snapshot: false,
    shell: input.shellPath,
    default_agent: AGENT_ID,
    agent: {
      [AGENT_ID]: {
        mode: "primary",
        description: "Diagnoses and fixes Linux problems for people who don't use the terminal.",
        prompt: `{file:${input.promptFile}}`,
        steps: 40,
      },
      build: { disable: true },
      plan: { disable: true },
      general: { disable: true },
      explore: { disable: true },
    },
    permission: permissionConfig(),
  };
}
