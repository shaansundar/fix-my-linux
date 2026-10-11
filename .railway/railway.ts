import { defineRailway, postgres, preserve, project, service } from "railway/iac";

/**
 * The Fix My Linux backend on Railway: the Go API in server/ and its
 * Postgres database (migrations run when the API starts).
 *
 *   railway config plan     # preview, changes nothing
 *   railway config apply    # apply after confirming
 *
 * Secrets are set in Railway itself (dashboard or `railway variables --set`)
 * and kept here with preserve(), so they never live in the repository. See
 * README, "Deploying the backend", for the list and how to generate them.
 */
export default defineRailway(() => {
  const db = postgres("postgres");

  const api = service("api", {
    rootDirectory: "server",
    build: { builder: "DOCKERFILE", dockerfilePath: "Dockerfile" },
    healthcheck: "/healthz",
    healthcheckTimeout: 60,
    deploy: { restartPolicyType: "ON_FAILURE", restartPolicyMaxRetries: 5 },
    env: {
      DATABASE_URL: db.env.DATABASE_URL,
      // Model replies stream for minutes; let them finish when redeploying.
      RAILWAY_DEPLOYMENT_DRAINING_SECONDS: "60",

      // Plan limits.
      BUDGET_USD: "8",
      TRIAL_DAYS: "5",
      TRIAL_DAILY_REQUESTS: "300",

      // Secrets and account-specific values.
      ZEN_API_KEY: preserve(),
      RESEND_API_KEY: preserve(),
      MAIL_FROM: preserve(),
      CODE_SECRET: preserve(),
      MACHINE_HMAC_SECRET: preserve(),
      LEMONSQUEEZY_API_KEY: preserve(),
      LEMONSQUEEZY_STORE_ID: preserve(),
      LEMONSQUEEZY_VARIANT_ID: preserve(),
      LEMONSQUEEZY_WEBHOOK_SECRET: preserve(),
      CHECKOUT_REDIRECT_URL: preserve(),
    },
  });

  return project("fix-my-linux", { resources: [api, db] });
});
