import { useSyncExternalStore } from 'react';
import { generationLabels, type GenerationProgress } from '@/lib/generationProgress';

export default function GenerationStatus({ progress, savingOnly = false }: { progress: GenerationProgress; savingOnly?: boolean }) {
  const stage = useSyncExternalStore(progress.subscribe, progress.getSnapshot, progress.getSnapshot);
  if (savingOnly && stage !== 'saving') return null;
  return <span role="status" aria-live="polite" className={savingOnly ? 'mt-1 block text-xs text-slate-400' : 'text-slate-400'}>{generationLabels[stage]}</span>;
}
