import { useEffect, useState } from 'react';
import type { Session } from '@/types/db';
import { supabase } from '@/lib/supabase';
import { showToast } from '@/lib/toast';
import { bothVariants, paletteFor, requestThemeRefresh, type SavedTheme, type ThemeVariant } from '@/lib/theme';
import ThemeMenu from './ThemeMenu';

export default function SessionThemeSettings({session,userId,onUpdate,busy=false}:{session:Session;userId:string;onUpdate:(session:Session)=>void;busy?:boolean}){
  const [theme,setTheme]=useState<SavedTheme|null>(null);
  const [open,setOpen]=useState(false);
  const [saving,setSaving]=useState(false);
  useEffect(()=>{
    if(!session.theme_id){setTheme(null);return;}
    let active=true;
    void supabase.from('themes').select('*').eq('id',session.theme_id).maybeSingle().then(({data})=>{if(active)setTheme(data as SavedTheme|null);});
    return ()=>{active=false;};
  },[session.theme_id]);
  async function set(override:'builtin'|'custom'|null,id:string|null,variant:ThemeVariant|null,selected?:SavedTheme){
    setSaving(true);
    const payload={theme_override:override,theme_id:id,theme_variant:variant};
    const {data,error}=await supabase.from('sessions').update(payload).eq('id',session.id).eq('user_id',userId).select('*').single();
    setSaving(false);
    if(error||!data){showToast('채팅방 테마 저장 실패: '+(error?.message??'권한 오류'));return;}
    onUpdate(data as Session);
    if(selected)setTheme(selected);
    requestThemeRefresh();
  }
  const mode=session.theme_override??'inherit';
  const variant=session.theme_variant??'light';
  return <section className="mt-4 border-t border-surface2 pt-4">
    <h3 className="mb-2 text-sm font-semibold text-white">채팅방 테마</h3>
    <p className="mb-3 text-xs text-slate-500">개별 선택이 가장 우선하며, 모든 기기에 동기화됩니다.</p>
    <div className="grid grid-cols-3 gap-1 rounded-lg bg-surface p-1">
      {([{value:'inherit',label:'기본값'},{value:'builtin',label:'기본 테마'},{value:'custom',label:'커스텀'}]as const).map(o=><button key={o.value} disabled={busy||saving} onClick={()=>o.value==='custom'?setOpen(true):void set(o.value==='inherit'?null:'builtin',null,o.value==='builtin'?variant:null)} className={`rounded-lg px-1 py-2 text-xs ${mode===o.value?'bg-brand text-white':'text-slate-400'}`}>{o.label}</button>)}
    </div>
    {mode==='inherit'&&<p className="mt-2 text-xs text-slate-500">개인 설정에 따라 작품 기본 테마 또는 사용자 기본 테마를 사용합니다.</p>}
    {mode==='custom'&&<div className="mt-2 flex items-center justify-between gap-2 rounded-lg bg-surface p-2">
      <span className="truncate text-xs text-white">{theme?.name??'선택한 테마'}</span>
      <button disabled={busy||saving} onClick={()=>setOpen(true)} className="text-xs text-brand">변경</button>
    </div>}
    {(mode==='builtin'||(mode==='custom'&&theme&&bothVariants(theme)))&&<div className="mt-2 grid grid-cols-2 gap-2">
      {(['dark','light']as const).map(v=><button key={v} disabled={busy||saving} onClick={()=>void set(mode==='custom'?'custom':'builtin',mode==='custom'?session.theme_id??null:null,v)} className={`rounded-lg px-3 py-2 text-xs ${variant===v?'bg-brand text-white':'bg-surface2 text-slate-400'}`}>{v==='dark'?'🌙 다크':'☀️ 라이트'}</button>)}
    </div>}
    {open&&<div className="mt-3 rounded-lg border border-surface2">
      <ThemeMenu userId={userId} workId={session.work_id} selectedId={session.theme_id} onClose={()=>setOpen(false)} onSelect={selected=>{
        const next=paletteFor(selected,session.theme_variant??'light')?.variant??'light';
        void set('custom',selected.id,next,selected);
        setOpen(false);
      }}/>
    </div>}
  </section>;
}
