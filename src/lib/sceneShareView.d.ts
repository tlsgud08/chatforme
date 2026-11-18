import type { ReactElement } from 'react';

export interface SharedScene {
  title: string;
  thumbnail?: string | null;
  hasCard?: boolean;
  viewTheme?: { variant: 'dark' | 'light'; palette: unknown };
  display?: {
    interfaceDesign?: 'modern' | 'legacy';
    chatWidthLimited?: boolean;
    showImages?: boolean;
    codeBlockStyle?: string;
    fontSize?: number | null;
    fontWeight?: number | null;
    boldWeight?: number | null;
  };
  start: number;
  end: number;
  hideUser: boolean;
  messages: { turn: number; role: 'user' | 'assistant'; text: string | null }[];
}

export function sceneTurnLabel(start: number, end: number): string;
export default function SharedSceneContent(props: { scene: SharedScene }): ReactElement;
