// Account-bound work can outlive the screen that started it.
const resetListeners = new Set<() => void>();
export function subscribeAccountTaskReset(listener: () => void) { resetListeners.add(listener); return () => { resetListeners.delete(listener); }; }

const controllers = new Set<AbortController>();

export function registerAccountTask(controller: AbortController): () => void {
  controllers.add(controller);
  return () => { controllers.delete(controller); };
}

export function abortAccountTasks() {
  const pending = [...controllers];
  controllers.clear();
  for (const controller of pending) controller.abort('계정이 변경되어 요청을 중단했습니다.');
  resetListeners.forEach(listener => listener());
}
