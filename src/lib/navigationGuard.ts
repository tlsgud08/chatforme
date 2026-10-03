type NavigationGuard = () => boolean | Promise<boolean>;

let activeGuard: NavigationGuard | null = null;

export function registerNavigationGuard(guard: NavigationGuard) {
  activeGuard = guard;
  return () => {
    if (activeGuard === guard) activeGuard = null;
  };
}

export async function canLeaveCurrentPage() {
  return activeGuard ? activeGuard() : true;
}
