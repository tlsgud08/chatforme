import type { CacheDiagnostic, PromptDiagnosticComponent, SystemParts, Usage } from './types';

interface DiagnosticSource { key: string; label: string; content: string }
interface PreviousRequest { hashes: Map<string, string>; historyHashes: string[] }

const previousBySession = new Map<string, PreviousRequest>();

// Provider tokenizers differ. This estimate is deliberately used only to locate an
// approximate boundary; OpenRouter's prompt/cached token totals remain authoritative.
function estimateTokens(value: string): number {
  if (!value) return 0;
  return Math.max(1, Math.ceil(new TextEncoder().encode(value).length / 4));
}

async function fingerprint(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value || '');
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest).slice(0, 8), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function diagnosticSources(
  parts: SystemParts,
  messages: { role: 'user' | 'assistant'; content: string }[],
): DiagnosticSource[] {
  const stable: DiagnosticSource[] = [
    { key: 'core', label: 'System Prompt + Main Prompt', content: parts.core },
    { key: 'persona', label: '{PC} Information', content: parts.persona },
    { key: 'userNote', label: 'User Notes', content: parts.userNote },
    { key: 'summary', label: 'Previous Story Summary', content: parts.summary },
    { key: 'storyNotes', label: 'Story Notes', content: parts.storyNotes ?? '' },
  ];
  const history = messages.slice(0, -1).map((message, index) => ({
    key: `history:${index}:${message.role}`,
    label: `${message.role === 'user' ? 'User' : 'Assistant'} History #${Math.floor(index / 2) + 1}`,
    content: message.content,
  }));
  const current = messages.at(-1);
  return [
    ...stable,
    ...history,
    // Active keywords stay a system instruction, but are physically placed after
    // stable history so their volatility cannot invalidate that prefix.
    { key: 'activeKeywords', label: 'Active Keywords', content: parts.keywords },
    ...(current ? [{ key: 'currentUserInput', label: 'Current User Input', content: current.content }] : []),
  ];
}

function historyChange(previous: string[] | undefined, current: string[]): CacheDiagnostic['historyChange'] {
  if (!previous) return 'NEW';
  if (previous.length === current.length && previous.every((hash, index) => hash === current[index])) return 'SAME';
  if (previous.length < current.length && previous.every((hash, index) => hash === current[index])) return 'EXTENDED';
  if (current.length < previous.length && current.every((hash, index) => hash === previous[index])) return 'TRUNCATED';
  return 'CHANGED';
}

export async function createCacheDiagnostic(args: {
  sessionId: string;
  model: string;
  sources: DiagnosticSource[];
  usage: Usage;
  requestId: string;
  generationId: string | null;
  upstreamProvider: string | null;
}): Promise<CacheDiagnostic> {
  const previous = previousBySession.get(args.sessionId);
  const sourceHashes = await Promise.all(args.sources.map((source) => fingerprint(source.content)));
  let consumed = 0;
  const cached = args.usage.cacheReadTokens;
  const components: PromptDiagnosticComponent[] = args.sources.map((source, index) => {
    const estimatedTokens = estimateTokens(source.content);
    const start = consumed;
    consumed += estimatedTokens;
    const cacheStatus = cached == null || cached <= start ? 'UNCACHED' : cached >= consumed ? 'CACHED' : 'PARTIAL';
    return {
      key: source.key,
      label: source.label,
      estimatedTokens,
      fingerprint: sourceHashes[index],
      change: previous ? (previous.hashes.get(source.key) === sourceHashes[index] ? 'SAME' : previous.hashes.has(source.key) ? 'CHANGED' : 'NEW') : 'NEW',
      cacheStatus,
    };
  });
  const historyHashes = components.filter((item) => item.key.startsWith('history:')).map((item) => item.fingerprint);
  previousBySession.set(args.sessionId, { hashes: new Map(components.map((item) => [item.key, item.fingerprint])), historyHashes });
  return {
    estimated: true,
    promptTokens: args.usage.inputTokens,
    cachedTokens: cached,
    cacheWriteTokens: args.usage.cacheCreationTokens,
    cacheReadRatio: cached == null || args.usage.inputTokens <= 0 ? null : cached / args.usage.inputTokens,
    model: args.model,
    upstreamProvider: args.upstreamProvider,
    sessionId: args.sessionId,
    requestId: args.requestId,
    generationId: args.generationId,
    historyChange: historyChange(previous?.historyHashes, historyHashes),
    components,
  };
}
