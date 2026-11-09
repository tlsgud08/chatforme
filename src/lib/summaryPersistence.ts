interface SaveResult { error: { code?: string } | null }

/** A missing overload cannot have written anything. Keep every source/claim guard
 * when falling back to the pre-character-goal signature during a rolling deploy. */
export async function saveSummaryWithFallback<T extends SaveResult>(
  save: (args: Record<string, unknown>) => PromiseLike<T>,
  args: Record<string, unknown>,
): Promise<T> {
  const result = await save(args);
  if (result.error?.code !== 'PGRST202' || !('generation_narrative_config' in args)) return result;
  const { generation_narrative_config: _goal, ...compatible } = args;
  return save(compatible);
}
