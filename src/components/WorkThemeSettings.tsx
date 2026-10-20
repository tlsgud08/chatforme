import InterfaceIcon from './InterfaceIcon';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { showToast } from '@/lib/toast';
import { bothVariants, type SavedTheme, type ThemeVariant } from '@/lib/theme';
import ThemeMenu from './ThemeMenu';

export default function WorkThemeSettings({userId,workId,themeId,variant,onChange}:{
  userId:string;workId:string;themeId:string|null|undefined;variant:ThemeVariant|null|undefined;
  onChange:(id:string|null,variant:ThemeVariant|null)=>void;
}){
  const [selected,setSelected]=useState<SavedTheme|null>(null);
  const [show,setShow]=useState(false);
  useEffect(()=>{
    let live=true;
    const refresh=async()=>{
      if(!themeId){setSelected(null);return;}
      const {data,error}=await supabase.from('themes').select('*').eq('id',themeId).maybeSingle();
      if(!live||error)return;
      setSelected(data as SavedTheme|null);
      // Theme deletion automatically clears works.default_theme_id in the DB.
      if(!data)onChange(null,null);
    };
    const listener=()=>{void refresh();};
    void refresh();
    window.addEventListener('inuchat:theme-changed',listener);
    return ()=>{live=false;window.removeEventListener('inuchat:theme-changed',listener);};
  },[themeId,show]);
  return <section className="rounded-xl border border-surface2 p-3">
    <h3 className="mb-1 text-sm font-semibold text-white">작품 기본 테마</h3>
    <p className="mb-3 text-xs text-slate-400">테마 허브에서 고르거나, 이 작품에서만 사용하는 전용 테마를 제작할 수 있습니다.</p>
    <div className="flex items-center justify-between gap-2">
      <span className="truncate text-sm text-slate-200">{selected?.name??(themeId?'테마를 불러오는 중…':'기본 테마 지정 안 함')}</span>
      <button onClick={()=>setShow(o=>!o)} type="button" className="shrink-0 rounded-lg bg-surface2 px-3 py-2 text-xs text-brand">선택 / 제작</button>
    </div>
    {selected&&!bothVariants(selected)&&<p className="mt-2 text-xs text-slate-400">단일 테마 · 라이트·다크 설정에 관계없이 같은 색상으로 표시됩니다.</p>}
    {selected&&bothVariants(selected)&&<div className="mt-3 grid grid-cols-2 gap-2">
      {(['light','dark']as const).map(v=><button key={v} type="button" aria-pressed={(variant??'light')===v} onClick={()=>onChange(themeId!,v)} className={`rounded-lg px-3 py-2 text-xs ${(variant??'light')===v?'bg-brand text-white':'bg-surface2 text-slate-400'}`}><InterfaceIcon name={v==='dark'?'moon':'sun'} legacy={v==='dark'?'🌙':'☀️'} /> {v==='dark'?'다크':'라이트'}</button>)}
    </div>}
    {themeId&&<button type="button" onClick={()=>onChange(null,null)} className="mt-2 text-xs text-slate-400 underline">작품 기본 테마 해제</button>}
    {show&&<div className="mt-3 rounded-lg border border-surface2">
      <ThemeMenu userId={userId} workId={workId} allowWorkCreate embedded selectedId={themeId} onSelect={t=>{
        if(t.work_shared===false&&t.work_id||!t.work_id&&!t.is_published){showToast('개인 비공개 테마는 작품 기본값으로 사용할 수 없어요. 허브 공개하거나 작품 전용 테마를 만들어 주세요.');return;}
        onChange(t.id,variant??'light');
        setShow(false);
      }}/>
    </div>}
  </section>;
}
