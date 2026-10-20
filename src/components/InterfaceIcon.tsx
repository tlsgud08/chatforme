import {
  ArrowLeft, ArrowUp, ArrowUpRight, BookOpen, Camera, Check, ChevronDown, ChevronRight,
  CircleDollarSign, Crown, TriangleAlert, FileText, GitBranch, Heart, KeyRound, Menu, MessageCircle, MoreHorizontal,
  Palette, PanelLeftClose, PanelLeftOpen, Pencil, Plus, RotateCcw, Save, Search, Settings,
  Shield, SlidersHorizontal, Square, Star, Sun, Moon, SunMoon, Trash2, UserRound, Users, X,
} from 'lucide-react';

// Share the same tree-shakable SVG icons across both interface designs.
const icons = {
  back: ArrowLeft, send: ArrowUp, external: ArrowUpRight, works: BookOpen, camera: Camera,
  check: Check, down: ChevronDown, next: ChevronRight, cost: CircleDollarSign, summary: FileText,
  branch: GitBranch, heart: Heart, key: KeyRound, menu: Menu, chat: MessageCircle,
  more: MoreHorizontal, palette: Palette, collapse: PanelLeftClose, expand: PanelLeftOpen,
  edit: Pencil, plus: Plus, reroll: RotateCcw, save: Save, search: Search, settings: Settings,
  host: Crown, warning: TriangleAlert, sun: Sun, moon: Moon, admin: Shield, output: SlidersHorizontal, stop: Square, star: Star, theme: SunMoon,
  delete: Trash2, my: UserRound, users: Users, close: X,
};
export type InterfaceIconName = keyof typeof icons;

export default function InterfaceIcon({ name, filled = false }: {
  name: InterfaceIconName; filled?: boolean;
}) {
  const Icon = icons[name];
  return <Icon className="interface-icon" size={17} strokeWidth={1.7} aria-hidden="true" fill={filled ? 'currentColor' : 'none'} />;
}
