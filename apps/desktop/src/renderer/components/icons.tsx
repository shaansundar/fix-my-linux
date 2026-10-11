/**
 * Icon adapter. Beautiful UI ships with Central Icons (commercial license) and
 * iconoir; every icon here is backed by lucide-react (MIT) instead, exported
 * under the names the vendored components import. Swapping icon sets is a
 * change to this file only.
 */
import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  House,
  LogOut,
  MessageCircleQuestion,
  PanelLeft,
  Plus,
  RefreshCw,
  Scissors,
  Search,
  Settings,
  Smile,
  Sparkles,
  SquarePen,
  SquareTerminal,
  TextCursorInput,
  UserPlus,
  X,
  type LucideIcon,
  type LucideProps,
} from "lucide-react";

export type IconProps = LucideProps;

/* Central Icons names (round-outlined, radius 2, stroke 2). */
export const IconHome: LucideIcon = House;
export const IconUserAdd: LucideIcon = UserPlus;
export const IconCheckmark1Small: LucideIcon = Check;
export const IconPlusMedium: LucideIcon = Plus;
export const IconSettingsGear1: LucideIcon = Settings;
export const IconArrowBoxLeft: LucideIcon = LogOut;
/** Workspace logo slot; the upstream demo used a popsicle. */
export const IconPopsicle2: LucideIcon = SquareTerminal;
export const IconChevronDownSmall: LucideIcon = ChevronDown;
export const IconSidebarLeftArrow: LucideIcon = PanelLeft;
export const IconEditBig: LucideIcon = SquarePen;
export const IconMagnifyingGlass: LucideIcon = Search;
export const IconCrossSmall: LucideIcon = X;

/* iconoir names. */
export { ArrowUp, Check };
export const ChatBubbleQuestion: LucideIcon = MessageCircleQuestion;
export const EmojiSatisfied: LucideIcon = Smile;
export const NavArrowRight: LucideIcon = ChevronRight;
export const Refresh: LucideIcon = RefreshCw;
export const Scissor: LucideIcon = Scissors;
export const Spark: LucideIcon = Sparkles;
export const TextBox: LucideIcon = TextCursorInput;
export const Xmark: LucideIcon = X;
