import { registerAccountTask, subscribeAccountTaskReset } from '../accountTasks';
import { generateKnowledgeNow } from './manual';

export interface KnowledgeJob {
  status: 'running' | 'stopping' | 'completed' | 'stopped' | 'error';
  processed: number;
  total: number;
  message: string;
}
const jobs = new Map<string, { state: KnowledgeJob; controller: AbortController }>();
const listeners = new Set<() => void>();
const publish = () => listeners.forEach(listener => listener());
subscribeAccountTaskReset(() => { jobs.clear(); publish(); });
export function forgetKnowledgeJob(id: string) { jobs.get(id)?.controller.abort(); jobs.delete(id); publish(); }
export function getKnowledgeJob(id: string): KnowledgeJob | null { return jobs.get(id)?.state ?? null; }
export function subscribeKnowledgeJobs(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function stopKnowledgeJob(id: string) {
  const job = jobs.get(id);
  if (!job || job.state.status !== 'running') return;
  job.state = { ...job.state, status: 'stopping', message: '정보 정리를 중단하고 있어요…' };
  job.controller.abort(); publish();
}
/** A screen subscribes to the job; it does not own its lifetime. */
export function startKnowledgeJob(id: string, apiKey: string) {
  const current = jobs.get(id);
  if (current && ['running', 'stopping'].includes(current.state.status)) return;
  const controller = new AbortController(), unregister = registerAccountTask(controller);
  const job = { controller, state: { status: 'running', processed: 0, total: 0, message: '정보 정리를 준비하고 있어요…' } as KnowledgeJob };
  jobs.set(id, job); publish();
  void generateKnowledgeNow(id, apiKey, controller.signal, (processed, total) => {
    if (jobs.get(id) !== job || controller.signal.aborted) return;
    job.state = { ...job.state, processed, total, message: `${total}개 중 ${processed}개 응답 정리 완료` }; publish();
  }).then(result => {
    controller.signal.throwIfAborted();
    if (jobs.get(id) !== job) return;
    job.state = { ...job.state, status: 'completed', message: result.processed ? '정보표 생성/갱신을 완료했어요.' : '새로 반영할 정보가 없어요. 최신 정보표예요.' };
    window.dispatchEvent(new CustomEvent('inuchat:knowledge-updated', { detail: id }));
  }).catch(error => {
    if (jobs.get(id) !== job) return;
    job.state = { ...job.state, status: controller.signal.aborted ? 'stopped' : 'error', message: controller.signal.aborted ? '정보 정리를 중단했어요. 완료한 부분은 유지되며 다음 실행에서 이어서 처리해요.' : (error as Error).message };
  }).finally(() => { unregister(); publish(); });
}
