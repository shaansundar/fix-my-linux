import { useEffect } from "react";
import { IconHome, IconSettingsGear1 } from "@/components/icons";
import SidebarNav, { type SidebarRecent } from "@/components/bui/SidebarNav";
import { Activity as ActivityIcon } from "lucide-react";
import { store, useApp } from "@/state/store";
import { Activity } from "@/screens/Activity";
import { Chat } from "@/screens/Chat";
import { Starting } from "@/screens/Starting";

export function App() {
  const engine = useApp((s) => s.engine);
  const view = useApp((s) => s.view);
  const sessions = useApp((s) => s.sessions);
  const { navigate, newChat } = store().actions;

  useEffect(() => {
    void store().actions.init();
  }, []);

  const recents: SidebarRecent[] = sessions.map((s) => ({ id: s.id, label: s.title || "New chat" }));
  const activeNav = view.kind === "chat" ? "chats" : view.kind;

  let main;
  if (engine.state !== "ready") main = <Starting />;
  else if (view.kind === "activity") main = <Activity />;
  else main = <Chat />;

  return (
    <div className="flex h-screen bg-page">
      <SidebarNav
        fill
        workspace={{ name: "Fix My Linux", monogram: "F" }}
        navItems={[
          { key: "home", label: "Home", icon: <IconHome size={18} /> },
          { key: "activity", label: "Activity", icon: <ActivityIcon size={18} strokeWidth={2} /> },
          { key: "settings", label: "Settings", icon: <IconSettingsGear1 size={18} /> },
        ]}
        menuItems={[]}
        activeNav={activeNav}
        onNavigate={(key) => {
          if (key === "activity" || key === "home" || key === "settings") navigate({ kind: key });
        }}
        recents={recents}
        activeId={view.kind === "chat" ? view.sessionID : null}
        onNewChat={newChat}
        onPick={(id) => navigate({ kind: "chat", sessionID: id })}
        footerLabel="New chat"
        onFooterClick={newChat}
      />
      <main className="min-w-0 flex-1 bg-canvas">{main}</main>
    </div>
  );
}
