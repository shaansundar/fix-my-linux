import { lazy, Suspense, useSyncExternalStore } from "react";

const Gallery = import.meta.env.DEV ? lazy(() => import("./dev/Gallery")) : null;

function subscribe(cb: () => void) {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
}

export function Root() {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  if (Gallery && hash === "#/gallery") {
    return (
      <Suspense fallback={null}>
        <Gallery />
      </Suspense>
    );
  }
  return (
    <main className="flex h-screen items-center justify-center text-ink-2">
      <a href="#/gallery" className="text-accent-ink">Open component gallery</a>
    </main>
  );
}
