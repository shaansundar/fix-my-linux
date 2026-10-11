import { Button } from "@/components/atoms/Button";
import LoadingState from "@/components/bui/LoadingState";
import { store, useApp } from "@/state/store";

export function Starting() {
  const engine = useApp((s) => s.engine);
  if (engine.state === "error") {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <div className="w-full max-w-[420px] overflow-hidden rounded-card bg-surface shadow-card" style={{ animation: "fade-up 380ms cubic-bezier(0.23,1,0.32,1) both" }}>
          <div className="primitive-card-pad flex flex-col gap-1.5">
            <p className="text-[14px] font-medium text-ink">The assistant couldn't start</p>
            <p className="text-[13px] text-ink-2">{engine.message}</p>
          </div>
          <div className="primitive-card-footer flex justify-end border-t border-line">
            <Button variant="accent" size="sm" onClick={() => void store().actions.restartEngine()}>
              Try again
            </Button>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="flex h-full items-center justify-center">
      <LoadingState variant="Drive" label="Getting the assistant ready" />
    </div>
  );
}
