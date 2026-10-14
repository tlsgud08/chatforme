import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { showToast } from '@/lib/toast';
import { applyTheme, bothVariants, loadTheme, paletteFor, requestThemeRefresh, type SavedTheme, type ThemeVariant } from '@/lib/theme';
import ThemeMenu from './ThemeMenu';

type Pref = { prefer_work_theme:boolean; preferred_theme_mode:'dark'|'light'|'custom'|null; preferred_theme_id:string|null; preferred_theme_variant:ThemeVariant };
export default function ThemePreferences({userId}:{userId:string|null}){
  const [pref,setPref]=useState<Pref>({prefer_work_theme:true,preferred_theme_mode:null,preferred_theme_id:null,preferred_theme_variant:'light'});
  const [chosen,setChosen]=useState<SavedTheme|null>(null);
  const [picker,setPicker]=useState(false);
  const [loading,setLoading]=useState(!!userId);
  useEffect(()=>{
    if(!userId)return;
    let live=true;
    void (async()=>{
      const {data,error}=await supabase.from('profiles').select('prefer_work_theme,preferred_theme_mode,preferred_theme_id,preferred_theme_variant').eq('id',userId).single();
      if(!live)return;
      if(!error&&data)setPref(data as Pref);
      setLoading(false);
      if(data?.preferred_theme_id) {
        const {data:theme}=await supabase.from('themes').select('*').eq('id',data.preferred_theme_id).maybeSingle();
        if(live)setChosen(theme as SavedTheme|null);
      }
    })();
    return ()=>{live=false;};
  },[userId]);
  async function update(patch:Partial<Pref>, theme?:SavedTheme|null){
    const next={...pref,...patch};
    if(!userId){
      if(next.preferred_theme_mode==='dark'||next.preferred_theme_mode==='light')applyTheme(next.preferred_theme_mode);
      setPref(next);return;
    }
    const {error}=await supabase.from('profiles').update(patch).eq('id',userId);
    if(error){showToast('테마 설정 저장 실패: '+error.message);return;}
    setPref(next);
    if(theme!==undefined)setChosen(theme);
    requestThemeRefresh();
  }
  const currentMode=pref.preferred_theme_mode??(loadTheme()==='dark'?'dark':'light');
  return <section className="flex flex-col gap-3">
    <h2 className="font-semibold text-white">화면 테마</h2>
    <p className="text-xs text-slate-500">{userId?'테마 설정은 로그인한 모든 기기에 저장됩니다.':'비회원 모드는 이 기기에만 저장됩니다.'}</p>
    {loading?<p className="text-sm text-slate-400">불러오는 중…</p>:<>
      <div className="grid grid-cols-3 gap-1 rounded-xl bg-surface p-1.5" role="group" aria-label="기본 테마">
        {(['dark','light','custom']as const).map(mode=><button key={mode} aria-pressed={currentMode===mode} onClick={()=>mode==='custom'?setPicker(true):void update({preferred_theme_mode:mode,preferred_theme_id:null,preferred_theme_variant:mode},null)} className={`rounded-lg px-2 py-2.5 text-xs font-semibold ${currentMode===mode?'bg-brand text-white':'text-slate-400'}`}>{mode==='dark'?'🌙 다크':mode==='light'?'☀️ 라이트':'🎨 커스텀'}</button>)}
      </div>
      {currentMode==='custom'&&<div className="rounded-xl bg-surface p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm text-white">{chosen?.name??'테마 미선택'}</span>
          <button onClick={()=>setPicker(true)} className="rounded-lg bg-surface2 px-3 py-2 text-xs text-brand">테마 변경</button>
        </div>
        {chosen&&bothVariants(chosen)&&<div className="mt-3 grid grid-cols-2 gap-2">{(['dark','light']as const).map(v=><button key={v} onClick={()=>void update({preferred_theme_variant:v})} className={`rounded-lg px-3 py-2 text-xs ${pref.preferred_theme_variant===v?'bg-brand text-white':'bg-surface2 text-slate-400'}`}>{v==='dark'?'🌙 다크':'☀️ 라이트'}</button>)}</div>}
      </div>}
      {userId&&<label className="flex items-start justify-between gap-3 rounded-xl bg-surface p-3">
        <span className="flex flex-col gap-1"><strong className="text-sm text-white">작품 테마 기본 사용</strong><span className="text-xs text-slate-400">채팅방에서 별도로 설정하지 않은 경우 작품 제작자의 기본 테마를 사용합니다.</span></span>
        <input type="checkbox" checked={pref.prefer_work_theme} onChange={e=>void update({prefer_work_theme:e.target.checked})} className="mt-1"/>
      </label>}
    </>}
    {picker&&userId&&<div className="rounded-xl border border-surface2 bg-bg">
      <ThemeMenu userId={userId} onClose={()=>setPicker(false)} onSelect={t=>{
        const v=paletteFor(t,pref.preferred_theme_variant)?.variant??'light';
        void update({preferred_theme_mode:'custom',preferred_theme_id:t.id,preferred_theme_variant:v},t);
        setPicker(false);
      }}/>
    </div>}
  </section>;
}
