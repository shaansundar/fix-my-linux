import type { ChatRequest, Turn } from "./fake-zen";

/**
 * A scripted "model" for demo mode (FML_DEMO=1): lets you try the whole app
 * offline. It picks a scenario from the last user message and advances one
 * step per tool result. Commands it proposes go through the normal approval
 * flow, so nothing changes without a click.
 */

type Step = (lastToolOutput: string) => Turn;

const SCENARIOS: Array<{ match: RegExp; steps: Step[] }> = [
  {
    match: /disk|space|storage|full/i,
    steps: [
      () => ({
        text: "Let me make a quick plan.",
        tools: [{ name: "todowrite", args: { todos: [
          { content: "Check how full the disk is", status: "in_progress", priority: "high" },
          { content: "Find what's taking up space", status: "pending", priority: "high" },
          { content: "Clear safe-to-delete caches", status: "pending", priority: "medium" },
        ] } }],
      }),
      () => ({ text: "I'll check how much space is left on your disk.", tools: [{ name: "bash", args: { command: "df -h" } }] }),
      () => ({
        text: "Now I'll see which of your folders are the biggest.",
        tools: [{ name: "bash", args: { command: "du -sh ~/Downloads ~/.cache" } }],
      }),
      () => ({
        reasoning: "Thumbnail cache is safe to remove; it regenerates.",
        text: "I'll clear the thumbnail cache. These are small preview images your computer recreates automatically.",
        tools: [{ name: "bash", args: { command: "rm -rf ~/.cache/thumbnails" } }],
      }),
      () => ({
        text: "Done! I cleared the thumbnail cache. Your Downloads folder is the biggest one; you might want to look through it for old files you no longer need.",
      }),
    ],
  },
  {
    match: /wi-?fi|internet|network|connect/i,
    steps: [
      () => ({ text: "I'll check whether your computer can see your Wi-Fi.", tools: [{ name: "bash", args: { command: "nmcli device status" } }] }),
      () => ({
        text: "I'll check whether the network service is running.",
        tools: [{ name: "bash", args: { command: "systemctl status NetworkManager --no-pager" } }],
      }),
      () => ({
        text: "I'll restart the network service, which often fixes a Wi-Fi connection that keeps dropping.",
        tools: [{ name: "bash", args: { command: "sudo systemctl restart NetworkManager" } }],
      }),
      () => ({ text: "The network service has been restarted. Try your Wi-Fi again; it should reconnect within a few seconds." }),
    ],
  },
  {
    match: /install|video|player|vlc|app/i,
    steps: [
      () => ({
        text: "There are a couple of good options.",
        tools: [{ name: "question", args: { questions: [{
          question: "Which video player would you like?",
          header: "Player",
          options: [
            { label: "VLC", description: "Plays almost any video file" },
            { label: "Celluloid", description: "Simple and clean" },
          ],
        }] } }],
      }),
      (answer) => {
        const app = /celluloid/i.test(answer) ? "io.github.celluloid_player.Celluloid" : "org.videolan.VLC";
        const name = /celluloid/i.test(answer) ? "Celluloid" : "VLC";
        return {
          text: `I'll install ${name} from Flathub, the app store most Linux computers use.`,
          tools: [{ name: "bash", args: { command: `flatpak install -y flathub ${app}` } }],
        };
      },
      () => ({ text: "All set! You'll find the new video player in your applications menu." }),
    ],
  },
];

function lastUserIndex(body: ChatRequest): number {
  for (let i = body.messages.length - 1; i >= 0; i--) {
    const m = body.messages[i]!;
    if (m.role === "user" && !String(textOf(m.content)).startsWith("The user rejected")) return i;
  }
  return -1;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text) : "")).join(" ");
  return "";
}

export function demoBrain(body: ChatRequest): Turn {
  const start = lastUserIndex(body);
  const prompt = start >= 0 ? textOf(body.messages[start]!.content) : "";
  const after = body.messages.slice(start + 1);
  const toolResults = after.filter((m) => m.role === "tool");
  const lastOutput = textOf(toolResults.at(-1)?.content);

  if (/rejected|chose not to/i.test(lastOutput)) {
    return { text: "No problem, I won't do that. Is there another way you'd like me to help?" };
  }

  const scenario = SCENARIOS.find((s) => s.match.test(prompt));
  if (!scenario) {
    return {
      text:
        "I can help with things like a full disk, Wi-Fi that keeps dropping, installing apps, sound, printers and more. Tell me what's going on in your own words.",
    };
  }
  const step = scenario.steps[Math.min(toolResults.length, scenario.steps.length - 1)]!;
  return step(lastOutput);
}
