import { normalizeThemePeriods, stripThemeDirectives } from '../themeDirectives';
import type { ChatMessage, SystemParts } from '@/lib/llm/types';
import type { ActivePlugin, Message, Persona } from '@/types/db';

export interface AssembleInput {
  systemPrompt: string;
  mainPrompt: string;
  autoThemeEnabled?: boolean;
  dayNightThemeNames?: string[];
  themePrompt?: string;
  themeCatalog?: string;
  keywordBookContents?: string[];
  summary?: string;
  storyNotes?: string[];
  persona?: Pick<Persona, 'name' | 'description'> | null;
  userNote?: string;
  plugins?: ActivePlugin[];
  history: (Pick<Message, 'role' | 'content'> & { cacheBreakpoint?: boolean })[];
  latestUserMessage: string;
}

export interface AssembledPrompt {
  systemParts: SystemParts;
  messages: ChatMessage[];
}

function section(title: string, body: string): string {
  return `# ${title}\n${body.trim()}`;
}

export function assemblePrompt(input: AssembleInput): AssembledPrompt {
  // L1: core — 플랫폼 시스템 + 메인 프롬프트 (세션 내 불변)
  const coreParts: string[] = [];
  if (input.systemPrompt.trim()) coreParts.push(input.systemPrompt.trim());
  if (input.mainPrompt.trim()) coreParts.push(section('Main Prompt', input.mainPrompt));

  if (input.autoThemeEnabled) {
    if (input.themePrompt?.trim()) coreParts.push(section('Theme Change Rules', input.themePrompt));
    if (input.themeCatalog?.trim()) coreParts.push(section('Available Work Themes', input.themeCatalog));
  }
  const outgoing = (text: string) => input.autoThemeEnabled ? normalizeThemePeriods(text,input.dayNightThemeNames) : stripThemeDirectives(text);

  // L2: persona — 희소 변경
  let persona = '';
  if (input.persona && (input.persona.name || input.persona.description)) {
    persona = section(
      '{PC} Information',
      `{PC} = ${input.persona.name}\n{PC} Name: ${input.persona.name}\n{PC} Description: ${input.persona.description}`,
    );
  }

  // L3: userNote — 종종 변경
  let userNote = '';
  if (input.userNote && input.userNote.trim()) {
    userNote = section('User Notes', input.userNote);
  }

  // Session plugins are persistent instructions, adjacent to user notes.
  const plugins = (input.plugins ?? []).filter((plugin) => plugin.prompt.trim());
  if (plugins.length) {
    userNote = [userNote, section('session prompts', plugins.map((plugin) =>
      section(plugin.name, plugin.prompt)).join('\n\n'))].filter(Boolean).join('\n\n');
  }

  // L4: summary — 재요약 시 변경
  const summary = input.summary?.trim() ? section('Previous Story Summary', input.summary) : '';
  const storyNotes = input.storyNotes?.length
    ? section('Story Notes', input.storyNotes.join('\n\n'))
    : '';

  // Dynamic: keywords — 메시지마다 변경, 캐싱 안 함
  const keywords = input.keywordBookContents?.length
    ? section('Active Keywords', input.keywordBookContents.join('\n\n'))
    : '';

  const messages: ChatMessage[] = [
    ...input.history.map((m) => ({ role: m.role, content: outgoing(m.content), ...(m.cacheBreakpoint && { cacheBreakpoint: true }) })),
    ...(input.latestUserMessage ? [{ role: 'user' as const, content: outgoing(input.latestUserMessage) }] : []),
  ];

  return {
    systemParts: { core: outgoing(coreParts.join('\n\n')), persona:outgoing(persona), userNote:outgoing(userNote), summary:outgoing(summary), storyNotes:outgoing(storyNotes), keywords:outgoing(keywords) },
    messages,
  };
}
