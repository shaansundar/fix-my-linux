import { Button } from "@/components/atoms/Button";
import FineTuneCard from "@/components/bui/FineTuneCard";
import { store, useApp } from "@/state/store";
import type { Theme } from "../../shared/settings";

/** Settings, built from Fine-tune Cards (one per group) and Buttons. */

const THEMES: Theme[] = ["system", "light", "dark"];
const THEME_LABELS = ["System", "Light", "Dark"];

export function Settings() {
  const settings = useApp((s) => s.settings);
  const models = useApp((s) => s.models);
  const model = useApp((s) => s.model);
  const account = useApp((s) => s.account.account);
  const { updateSettings, setModel, manage, subscribe, signOut } = store().actions;
  const current = models.find((m) => m.id === model);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[640px] flex-col gap-6 px-6 py-8">
        <div className="flex flex-col gap-1">
          <h1 className="text-[20px] font-semibold tracking-tight text-ink">Settings</h1>
          <p className="text-[13.5px] text-ink-2">Changes save as you make them.</p>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FineTuneCard
            fill
            noStatus
            noType
            labels={{ title: "Appearance", layout: "Theme" }}
            segments={THEME_LABELS}
            segment={Math.max(0, THEMES.indexOf(settings.theme))}
            fields={[{ key: "zoom", label: "Text size", value: settings.zoom, min: 80, max: 150, step: 5, suffix: "%" }]}
            onChange={(st) => void updateSettings({ theme: THEMES[st.segment] ?? "system", zoom: st.values["zoom"] ?? settings.zoom })}
          />
          <FineTuneCard
            fill
            noStatus
            noType
            labels={{ title: "Safety", layout: "Before changing anything" }}
            segments={["Ask every time", "Allow similar"]}
            segment={settings.alwaysAsk ? 0 : 1}
            fields={[]}
            onChange={(st) => void updateSettings({ alwaysAsk: st.segment === 0 })}
          />
        </div>

        {models.length > 1 && (
          <FineTuneCard
            fill
            noStatus
            labels={{ title: "Assistant", layout: "", type: "Model", placeholder: current?.name ?? "Recommended" }}
            segments={[]}
            fields={[]}
            options={models.map((m) => m.name)}
            type={current?.name}
            onChange={(st) => {
              const next = models.find((m) => m.name === st.type);
              if (next) setModel(next.id);
            }}
          />
        )}

        {account && (
          <div className="overflow-hidden rounded-card bg-surface shadow-card">
            <div className="primitive-card-pad flex flex-col gap-1">
              <span className="text-[12px] font-medium text-ink-3">Account</span>
              <span className="text-[14px] font-medium text-ink">{account.email}</span>
              <span className="text-[13px] text-ink-2">
                {account.state === "active" ? "Subscribed" : account.state === "trial" ? "Free trial" : "No active plan"}
              </span>
            </div>
            <div className="primitive-card-footer flex justify-end gap-1.5 border-t border-line">
              <Button variant="ghost" size="sm" onClick={() => void signOut()}>
                Sign out
              </Button>
              {account.state === "active" ? (
                <Button variant="secondary" size="sm" onClick={() => void manage()}>
                  Manage subscription
                </Button>
              ) : (
                <Button variant="accent" size="sm" onClick={() => void subscribe()}>
                  Subscribe
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
