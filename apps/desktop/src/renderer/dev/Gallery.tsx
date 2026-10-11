import { useEffect, useState, type ComponentType } from "react";
import AgentScreen from "@/components/bui/AgentScreen";
import ApprovalCard from "@/components/bui/ApprovalCard";
import ChatComposer from "@/components/bui/ChatComposer";
import CodeBlock from "@/components/bui/CodeBlock";
import ContextCards from "@/components/bui/ContextCards";
import DiffTable, { ChangeTable } from "@/components/bui/DiffTable";
import FilterTable from "@/components/bui/FilterTable";
import FineTuneCard from "@/components/bui/FineTuneCard";
import Flowchart from "@/components/bui/Flowchart";
import InsightCards from "@/components/bui/InsightCards";
import LoadingState from "@/components/bui/LoadingState";
import PromptBar from "@/components/bui/PromptBar";
import RecommendationCard from "@/components/bui/RecommendationCard";
import RecordsTable from "@/components/bui/RecordsTable";
import SearchList from "@/components/bui/SearchList";
import SelectionActions from "@/components/bui/SelectionActions";
import SidebarNav from "@/components/bui/SidebarNav";
import StreamingText from "@/components/bui/StreamingText";
import TaskRows from "@/components/bui/TaskRows";
import ThinkingState from "@/components/bui/ThinkingState";
import ToolChips from "@/components/bui/ToolChips";

/**
 * Dev-only parity check: every vendored component with its upstream demo
 * data, for side-by-side comparison with https://www.beautifului.dev.
 * Open with #/gallery in a dev build.
 */
const ENTRIES: Array<[title: string, Component: ComponentType]> = [
  ["Loading State", LoadingState],
  ["Thinking", ThinkingState],
  ["Streaming Text", StreamingText],
  ["Approval Card", ApprovalCard],
  ["Tool Chips", ToolChips],
  ["Task Rows", TaskRows],
  ["Chat", ChatComposer],
  ["Prompt Bar", PromptBar],
  ["Recommendation Card", RecommendationCard],
  ["Context Cards", ContextCards],
  ["Diff Table", DiffTable],
  [
    "Change Table",
    () => (
      <ChangeTable
        title="What this changes: 1 new, 1 updated, 2 removed"
        columns={["Package", "Change", "Version"]}
        rows={[
          { key: "a", kind: "remove", name: "libreoffice-core", tag: "Removed", detail: "4:24.2.7-0ubuntu0.24.04.1" },
          { key: "b", kind: "remove", name: "libreoffice-writer", tag: "Removed", detail: "4:24.2.7-0ubuntu0.24.04.1" },
          { key: "c", kind: "add", name: "vlc", tag: "New", detail: "3.0.20-3build6" },
          { key: "d", kind: "update", name: "firefox", tag: "Update", detail: "128.0 → 129.0" },
        ]}
      />
    ),
  ],
  ["Records Table", RecordsTable],
  ["Filter Table", FilterTable],
  ["Sidebar Nav", SidebarNav],
  ["Search", SearchList],
  ["Flowchart", Flowchart],
  ["Insight Cards", InsightCards],
  ["Code Block", CodeBlock],
  ["Fine-tune Card", FineTuneCard],
  ["Selection Actions", SelectionActions],
  ["Agent Screen", AgentScreen],
];

export default function Gallery() {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);

  return (
    <div className="min-h-screen bg-page px-8 py-10">
      <header className="mx-auto mb-8 flex max-w-6xl items-center justify-between">
        <h1 className="text-[15px] font-semibold text-ink">Beautiful UI gallery</h1>
        <button
          type="button"
          onClick={() => setDark((d) => !d)}
          className="rounded-full bg-surface px-3 py-1.5 text-[12.5px] text-ink shadow-btn"
        >
          {dark ? "Light" : "Dark"}
        </button>
      </header>
      <div className="mx-auto grid max-w-6xl grid-cols-1 gap-6 lg:grid-cols-2">
        {ENTRIES.map(([title, Component]) => (
          <section key={title} id={title.toLowerCase().replace(/\s+/g, "-")} className="flex flex-col gap-3">
            <h2 className="text-[12px] font-medium text-ink-3">{title}</h2>
            <div className="flex min-h-[320px] items-center justify-center overflow-hidden rounded-window bg-canvas p-6 shadow-hairline">
              <Component />
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
