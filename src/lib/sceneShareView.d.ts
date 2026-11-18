import type { ReactElement } from 'react';

export interface SharedScene {
  title: string;
  start: number;
  end: number;
  hideUser: boolean;
  messages: { turn: number; role: 'user' | 'assistant'; text: string | null }[];
}

export function sceneTurnLabel(start: number, end: number): string;
export default function SharedSceneContent(props: { scene: SharedScene }): ReactElement;
