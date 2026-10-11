import { useEffect } from "react";
import { Button } from "@/components/atoms/Button";
import ContextCards, { type ContextChunk } from "@/components/bui/ContextCards";
import InsightCards, { LiveCard, type InsightPage } from "@/components/bui/InsightCards";
import RecommendationCard, { type RecommendationOption } from "@/components/bui/RecommendationCard";
import { Shimmer } from "@/components/atoms/Shimmer";
import { store, useApp } from "@/state/store";

/**
 * Home: a live look at the computer and anything worth fixing. Built from
 * Insight Cards (live charts), Recommendation Card (health check) and
 * Context Cards (facts with their source). Everything here is read locally.
 */

const pct = (v: number) => `${Math.round(v)}%`;
function rate(bytes: number): string {
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB/s`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB/s`;
  return `${Math.round(bytes)} B/s`;
}

// Card components live at module level so the charts keep their identity
// between samples instead of remounting.
function UsageCard() {
  const samples = useApp((s) => s.samples);
  const last = samples.at(-1);
  return (
    <LiveCard
      label="Last two minutes"
      formatValue={pct}
      windowSecs={120}
      series={[
        { name: "Processor", color: "#3d8bfd", dot: "bg-accent", points: samples.map((s) => ({ time: s.time, value: s.cpu })), display: pct(last?.cpu ?? 0), sub: "busy" },
        { name: "Memory", color: "#f68f3c", dot: "bg-orange", points: samples.map((s) => ({ time: s.time, value: s.memory })), display: pct(last?.memory ?? 0), sub: "in use" },
      ]}
    />
  );
}

function NetworkCard() {
  const samples = useApp((s) => s.samples);
  const last = samples.at(-1);
  const kb = (b: number) => b / 1024;
  return (
    <LiveCard
      label="Last two minutes, KB/s"
      formatValue={(v) => `${Math.round(v)} KB/s`}
      windowSecs={120}
      series={[
        { name: "Download", color: "#22a06b", dot: "bg-green", points: samples.map((s) => ({ time: s.time, value: kb(s.rxRate) })), display: rate(last?.rxRate ?? 0), sub: "receiving" },
        { name: "Upload", color: "#8a63d2", dot: "bg-accent", points: samples.map((s) => ({ time: s.time, value: kb(s.txRate) })), display: rate(last?.txRate ?? 0), sub: "sending" },
      ]}
    />
  );
}

function prose(kind: "usage" | "network", samples: { cpu: number; memory: number; rxRate: number }[]): string {
  const last = samples.at(-1);
  if (!last) return "Measuring…";
  if (kind === "usage") {
    if (last.cpu > 85) return "Your processor is very busy right now, which can make things feel slow.";
    if (last.memory > 90) return "Memory is nearly full, which can make apps slow to switch.";
    return "Your computer has plenty of headroom right now.";
  }
  return last.rxRate > 1024 * 1024 ? "Something is downloading right now." : "Your network is quiet at the moment.";
}

export function Home() {
  const facts = useApp((s) => s.facts);
  const health = useApp((s) => s.health);
  const samples = useApp((s) => s.samples);
  const { loadHome, ask } = store().actions;

  useEffect(() => {
    void loadHome();
  }, [loadHome]);

  const pages: InsightPage[] = [
    { key: "usage", prose: prose("usage", samples), Card: UsageCard, pill: "Why is my computer slow?" },
    { key: "network", prose: prose("network", samples), Card: NetworkCard, pill: "Check my internet connection" },
  ];

  const recommendations: RecommendationOption[] = (health ?? []).map((h) => ({
    key: h.key,
    body: (
      <>
        <span className="font-medium text-ink">{h.title}.</span> {h.body}
      </>
    ),
    short: h.title,
    signal: h.confidence === "high" ? 3 : 2,
    tone: h.confidence === "high" ? "var(--red)" : "var(--orange)",
    label: h.confidence === "high" ? "Worth fixing" : "Good to check",
    cta: "Fix it",
    ctaVariant: "accent",
  }));

  const chunks: ContextChunk[] = facts.map((f) => ({
    title: f.title,
    chars: f.detail,
    body: f.body,
    source: f.source,
    badge: ">_",
    tone: "bg-ink",
  }));

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[920px] flex-col gap-6 px-6 py-8">
        <div className="flex items-end justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h1 className="text-[20px] font-semibold tracking-tight text-ink">Your computer</h1>
            <p className="text-[13.5px] text-ink-2">A quick look at how it's doing. Nothing here uses the assistant or leaves your computer.</p>
          </div>
          <Button variant="secondary" size="sm" onClick={() => void loadHome()}>
            Check again
          </Button>
        </div>

        <section className="flex flex-col gap-2" aria-label="Health check">
          {health === null ? (
            <Shimmer className="text-[13px]">Checking your computer…</Shimmer>
          ) : recommendations.length ? (
            <RecommendationCard
              fill
              options={recommendations}
              labels={{ title: "Want me to take care of this?", alternatives: `${recommendations.length - 1} more`, otherOptions: "Also found", accepted: "Starting…" }}
              onAccept={(key) => {
                const item = health.find((h) => h.key === key);
                if (item) void ask(item.prompt);
              }}
            />
          ) : (
            <div className="rounded-card bg-surface px-3 py-3 text-[13px] text-ink-2 shadow-card">
              <span className="font-medium text-green">Everything looks healthy.</span> No full disks, failed services or memory trouble.
            </div>
          )}
        </section>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          <InsightCards
            fill
            pages={pages}
            labels={{ title: "Right now" }}
            onPill={(key) => void ask(pages.find((p) => p.key === key)!.pill)}
          />
          {chunks.length > 0 && <ContextCards fill chunks={chunks} labels={{ header: "About this computer", count: String(chunks.length) }} />}
        </div>
      </div>
    </div>
  );
}
