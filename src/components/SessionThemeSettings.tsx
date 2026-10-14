import { useEffect, useState } from 'react';
import type { Session } from '@/types/db';
import { supabase } from '@/lib/supabase';
import { showToast } from '@/lib/toast';
import { bothVariants, paletteFor, requestThemeRefresh, type SavedTheme, type ThemeVariant } from '@/lib/theme';
import ThemeMenu from './ThemeMenu';

type Props={session:Session;userId:string;onUpdate:(patch:Partial<Session>)=>void;busy?:boolean};
type SavedChoice={id:string;variant:ThemeVariant;theme:SavedTheme|null};
export default function SessionThemeSettings({session,userId,onUpdate,busy=false}:Props){
  const [theme,setTheme]=useState<SavedTheme|null>(null);
  const [open,setOpen]=useState(false);
  const [saving,setSaving]=useState(false);
  const [lastCustom,setLastCustom]=useState<SavedChoice|null>(null);
  useEffect(()=>{
    if(!session.theme_id){setTheme(null);return;}
    let active=true;
    void supabase.from('themes').select('*').eq('id',session.theme_id).maybeSingle().then(({data})=>{
      if(active)setTheme(data as SavedTheme|null);
    });
    return ()=>{active=false;};
  },[session.theme_id]);
  useEffect(()=>{
    if(session.theme_override==='custom'&&session.theme_id){
      setLastCustom({id:session.theme_id,variant:session.theme_variant??'light',theme});
    }
  },[session.theme_override,session.theme_id,session.theme_variant,theme]);

  // A theme can be changed/deleted in another tab; update the displayed choice
  // rather than leaving a stale selected name or a dangling custom override.
  useEffect(()=>{
    let active=true;
    const refresh=async()=>{
      const {data}=await supabase.from('sessions').select('theme_override,theme_id,theme_variant').eq('id',session.id).eq('user_id',userId).maybeSingle();
      if(!active||!data)return;
      if(data.theme_override!==session.theme_override||data.theme_id!==session.theme_id||data.theme_variant!==session.theme_variant){
        onUpdate(data);
      }
      if(session.theme_id){
        const {data:latest}=await supabase.from('themes').select('*').eq('id',session.theme_id).maybeSingle();
        if(active)setTheme(latest as SavedTheme|null);
      }
    };
    const listener=()=>{void refresh();};
    window.addEventListener('inuchat:theme-changed',listener);
    window.addEventListener('focus',listener);
    return ()=>{active=false;window.removeEventListener('inuchat:theme-changed',listener);window.removeEventListener('focus',listener);};
  },[session.id,session.theme_override,session.theme_id,session.theme_variant,userId,onUpdate]);

  async function save(override:'builtin'|'custom'|null,id:string|null,variant:ThemeVariant|null,selected?:SavedTheme):Promise<boolean>{
    if(saving)return false;
    setSaving(true);
    const {data,error}=await supabase.from('sessions').update({
      theme_override:override,theme_id:id,theme_variant:variant,
    }).eq('id',session.id).eq('user_id',userId).select('*').single();
    setSaving(false);
    if(error||!data){showToast('채팅방 테마 저장 실패: '+(error?.message??'권한 오류'));return false;}
    onUpdate(data as Session);
    if(selected)setTheme(selected);
    if(override==='custom'&&id)setLastCustom({id,variant:variant??'light',theme:selected??theme});
    requestThemeRefresh();
    return true;
  }
  const mode=session.theme_override??'inherit';
  const shownMode=open?'custom':mode;
  const variant=session.theme_variant??'light';
  async function chooseMode(next:'inherit'|'builtin'|'custom'){
    if(busy||saving)return;
    if(next==='custom'){
      if(lastCustom?.id){
        const ok=await save('custom',lastCustom.id,lastCustom.variant,lastCustom.theme??undefined);
        if(ok){setOpen(false);return;}
      }
      setOpen(true);
      return;
    }
    setOpen(false);
    await save(next==='inherit'?null:'builtin',null,next==='builtin'?variant:null);
  }
  return <section className="mt-4 border-t border-surface2 pt-4">
    <h3 className="mb-2 text-sm font-semibold text-white">채팅방 테마</h3>
    <p className="mb-3 text-xs text-slate-500">개별 선택이 가장 우선하며, 모든 기기에 동기화됩니다.</p>
    <div className="grid grid-cols-3 gap-1 rounded-lg bg-surface p-1">
      {([{value:'inherit',label:'기본값'},{value:'builtin',label:'기본 테마'},{value:'custom',label:'커스텀'}]as const).map(o=>
        <button key={o.value} disabled={busy||saving} aria-pressed={shownMode===o.value}
          onClick={()=>void chooseMode(o.value)}
          className={`rounded-lg px-1 py-2 text-xs ${shownMode===o.value?'bg-brand text-white':'text-slate-400'}`}>{o.label}</button>)}
    </div>
    {mode==='inherit'&&!open&&<p className="mt-2 text-xs text-slate-500">개인 설정에 따라 작품 기본 테마 또는 사용자 기본 테마를 사용합니다.</p>}
    {mode==='custom'&&!open&&<div className="mt-2 flex items-center justify-between gap-2 rounded-lg bg-surface p-2">
      <span className="truncate text-xs text-white">{theme?.name??'테마를 다시 선택해 주세요'}</span>
      <button disabled={busy||saving} onClick={()=>setOpen(true)} className="text-xs text-brand">변경</button>
    </div>}
    {(mode==='builtin'&&!open||(mode==='custom'&&!open&&theme&&bothVariants(theme)))&&<div className="mt-2 grid grid-cols-2 gap-2">
      {(['dark','light']as const).map(v=>
        <button key={v} disabled={busy||saving} onClick={()=>void save(mode==='custom'?'custom':'builtin',mode==='custom'?session.theme_id??null:null,v)}
          className={`rounded-lg px-3 py-2 text-xs ${variant===v?'bg-brand text-white':'bg-surface2 text-slate-400'}`}>
          {v==='dark'?'🌙 다크':'☀️ 라이트'}
        </button>)}
    </div>}
    {open&&<div className="mt-3 rounded-lg border border-surface2">
      <ThemeMenu userId={userId} workId={session.work_id} selectedId={session.theme_id}
        onClose={()=>setOpen(false)} onSelect={selected=>{
          const next=paletteFor(selected,session.theme_variant??'light')?.variant??'light';
          void save('custom',selected.id,next,selected).then(ok=>{if(ok)setOpen(false);});
        }}/>
    </div>}
  </section>;
}
