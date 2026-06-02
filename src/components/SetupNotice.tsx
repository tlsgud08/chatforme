// .env(Supabase 키) 미설정 시 안내 화면
export default function SetupNotice() {
  return (
    <div className="mx-auto flex h-full max-w-app flex-col justify-center gap-4 p-6 text-slate-200">
      <h1 className="text-xl font-bold text-white">설정이 필요합니다</h1>
      <p className="text-sm leading-relaxed text-slate-400">
        Supabase 프로젝트 연결값이 없습니다. 프로젝트 루트에 <code>.env</code> 파일을 만들고 아래
        값을 채워주세요.
      </p>
      <pre className="overflow-x-auto rounded-lg bg-surface p-4 text-xs text-slate-300">
{`VITE_SUPABASE_URL=https://xxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGci...
VITE_ADMIN_EMAIL=your@email.com`}
      </pre>
      <p className="text-sm text-slate-400">
        값은 Supabase 대시보드 → Project Settings → API 에서 확인할 수 있습니다. 저장 후 개발 서버를
        다시 시작하세요.
      </p>
    </div>
  );
}
