import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { bothVariants, paletteFor, type SavedTheme, type ThemeVariant } from '@/lib/theme';
import ThemeMenu from './ThemeMenu';

export default function WorkThemeSettings({userId,workId,themeId,variant,onChange}:{
  userId:string;workId:string;themeId:string|null|undefined;variant:ThemeVariant|null|undefined;
  onChange:(id:string|null,variant:ThemeVariant|null)=>void;
}){
  const [selected,setSelected]=useState<SavedTheme|null>(null);
  const [show,setShow]=useState(false);
  useEffect(()=>{
    let live=true;
    if(!themeId){setSelected(null);return;}
    void supabase.from('themes').select('*').eq('id',themeId).maybeSingle().then(({data})=>{if(live)setSelected(data as SavedTheme|null);});
    return ()=>{live=false;};
  },[themeId,show]);
  return <section className="rounded-xl border border-surface2 p-3">
    <h3 className="mb-1 text-sm font-semibold text-white">작품 기본 테마</h3>
    <p className="mb-3 text-xs text-slate-400">테마 허브에서 고르거나, 이 작품에서만 사용하는 전용 테마를 제작할 수 있습니다.</p>
    <div className="flex items-center justify-between gap-2">
      <span className="truncate text-sm text-slate-200">{selected?.name??(themeId?'테마를 불러오는 중…':'기본 테마 지정 안 함')}</span>
      <button onClick={()=>setShow(o=>!o)} type="button" className="shrink-0 rounded-lg bg-surface2 px-3 py-2 text-xs text-brand">선택 / 제작</button>
    </div>
    {selected&&bothVariants(selected)&&<div className="mt-3 grid grid-cols-2 gap-2">
      {(['dark','light']as const).map(v=><button key={v} onClick={()=>onChange(themeId!,v)} className={`rounded-lg px-3 py-2 text-xs ${(variant??'light')===v?'bg-brand text-white':'bg-surface2 text-slate-400'}`}>{v==='dark'?'🌙 다크':'☀️ 라이트'}</button>)}
    </div>}
    {themeId&&<button type="button" onClick={()=>onChange(null,null)} className="mt-2 text-xs text-slate-400 underline">작품 기본 테마 해제</button>}
    {show&&<div className="mt-3 rounded-lg border border-surface2">
      <ThemeMenu userId={userId} workId={workId} allowWorkCreate embedded selectedId={themeId} onSelect={t=>{
        onChange(t.id,paletteFor(t,variant??'light')?.variant??'light');
        setShow(false);
      }}/>
    </div>}
  </section>;
}
