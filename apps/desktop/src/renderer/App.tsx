import { useEffect } from "react";
import { IconHome, IconSettingsGear1 } from "@/components/icons";
import SidebarNav, { type SidebarRecent } from "@/components/bui/SidebarNav";
import { Activity as ActivityIcon } from "lucide-react";
import { store, useApp } from "@/state/store";
import { Activity } from "@/screens/Activity";
import { Chat } from "@/screens/Chat";
import { Starting } from "@/screens/Starting";
import { PasswordPrompt } from "@/components/fml/PasswordPrompt";
import { UsageMeter } from "@/components/fml/UsageMeter";
import { SignIn } from "@/screens/SignIn";
import { IconArrowBoxLeft } from "@/components/icons";
import { CreditCard } from "lucide-react";

export function App() {
  const engine = useApp((s) => s.engine);
  const view = useApp((s) => s.view);
  const sessions = useApp((s) => s.sessions);
  const passwords = useApp((s) => s.passwords);
  const account = useApp((s) => s.account);
  const { navigate, newChat, subscribe, manage, signOut } = store().actions;

  useEffect(() => {
    void store().actions.init();
  }, []);

  const recents: SidebarRecent[] = sessions.map((s) => ({ id: s.id, label: s.title || "New chat" }));
  const activeNav = view.kind === "chat" ? "chats" : view.kind;

  if (engine.state === "signed-out") {
    return (
      <div className="h-screen bg-canvas">
        <SignIn />
      </div>
    );
  }

  let main;
  if (engine.state !== "ready") main = <Starting />;
  else if (view.kind === "activity") main = <Activity />;
  else main = <Chat />;

  return (
    <div className="flex h-screen bg-page">
      <SidebarNav
        fill
        workspace={{ name: account.account?.email ?? "Fix My Linux", monogram: (account.account?.email ?? "F").charAt(0).toUpperCase() }}
        navItems={[
          { key: "home", label: "Home", icon: <IconHome size={18} /> },
          { key: "activity", label: "Activity", icon: <ActivityIcon size={18} strokeWidth={2} /> },
          { key: "settings", label: "Settings", icon: <IconSettingsGear1 size={18} /> },
        ]}
        menuItems={
          account.account
            ? [
                { label: "Manage subscription", icon: <CreditCard size={16} strokeWidth={2} />, onSelect: () => void manage() },
                { label: "Sign out", icon: <IconArrowBoxLeft size={16} />, separatorBefore: true, onSelect: () => void signOut() },
              ]
            : []
        }
        footer={
          account.account ? (
            <UsageMeter account={account.account} onSubscribe={() => void subscribe()} onManage={() => void manage()} />
          ) : undefined
        }
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
      <main className="relative min-w-0 flex-1 bg-canvas">
        {main}
        {passwords[0] && (
          <div className="absolute inset-0 z-40 flex items-end justify-center bg-[color-mix(in_srgb,var(--ink)_12%,transparent)] px-6 pb-24">
            <div className="w-full max-w-[460px]">
              <PasswordPrompt
                request={passwords[0]}
                onAnswer={(pw) => void store().actions.answerPassword(passwords[0]!.id, pw)}
              />
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
