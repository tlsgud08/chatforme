import { useEffect, useState } from 'react';
import type { Session } from '@/types/db';
import { supabase } from '@/lib/supabase';
import { showToast } from '@/lib/toast';
import { loadTheme, requestThemeRefresh, type SavedTheme, type ThemeVariant } from '@/lib/theme';
import ThemeMenu from './ThemeMenu';

type Props={session:Session;userId:string;onUpdate:(patch:Partial<Session>)=>void;busy?:boolean};
type SavedChoice={id:string;variant:ThemeVariant;theme:SavedTheme|null};
export default function SessionThemeSettings({session,userId,onUpdate,busy=false}:Props){
  const [theme,setTheme]=useState<SavedTheme|null>(null);
  const [open,setOpen]=useState(false);
  const [pickerScope,setPickerScope]=useState<'work'|'global'>('global');
  const [saving,setSaving]=useState(false);
  const [lastCustom,setLastCustom]=useState<SavedChoice|null>(null);
  const [siteMode,setSiteMode]=useState<'light'|'dark'|'custom'|null>(null);
  const [siteSaving,setSiteSaving]=useState(false);
  useEffect(()=>{
    let active=true;
    const refresh=async()=>{
      const {data,error}=await supabase.from('profiles').select('preferred_theme_mode').eq('id',userId).maybeSingle();
      if(!active||error)return;
      setSiteMode(data?.preferred_theme_mode??(loadTheme()==='dark'?'dark':'light'));
    };
    const listener=()=>{void refresh();};
    void refresh();
    window.addEventListener('inuchat:theme-changed',listener);
    window.addEventListener('focus',listener);
    return ()=>{active=false;window.removeEventListener('inuchat:theme-changed',listener);window.removeEventListener('focus',listener);};
  },[userId]);
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
  const selectedMode=mode==='custom'&&theme?.work_id?'work':mode;
  const shownMode=open?(pickerScope==='work'?'work':'custom'):selectedMode;
  const variant=session.theme_variant??'light';
  async function chooseSiteTheme(next:ThemeVariant){
    if(busy||saving||siteSaving)return;
    setSiteSaving(true);
    // The "기본값" buttons edit the same profile field as 화면 테마 in settings.
    // Do not create a per-chat override or disable the work-theme preference.
    const {error}=await supabase.from('profiles').update({preferred_theme_mode:next}).eq('id',userId);
    setSiteSaving(false);
    if(error){showToast('사이트 테마 변경 실패: '+error.message);return;}
    setSiteMode(next);
    requestThemeRefresh();
  }
  async function chooseMode(next:'inherit'|'work'|'builtin'|'custom'){
    if(busy||saving)return;
    if(next==='work'){setPickerScope('work');setOpen(true);return;}
    if(next==='custom'){
      setPickerScope('global');
      if(lastCustom?.id&&!lastCustom.theme?.work_id){
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
    <label className="mb-3 flex items-center justify-between gap-2 text-sm text-slate-200">
      자동 테마 변경
      <input type="checkbox" checked={session.auto_theme_enabled??false} disabled={busy||saving} onChange={async e=>{
        const enabled=e.target.checked;setSaving(true);
        const {error}=await supabase.from('sessions').update({auto_theme_enabled:enabled}).eq('id',session.id).eq('user_id',userId);
        setSaving(false);
        if(error){showToast('자동 테마 변경 설정 실패: '+error.message);return;}
        onUpdate({auto_theme_enabled:enabled});
      }}/>
    </label>
    <p className="mb-3 text-xs text-slate-500">응답의 테마 태그로 변경합니다. 끄면 태그와 테마 지침을 AI에게 전송하지 않습니다.</p>
    <div className="grid grid-cols-4 gap-1 rounded-lg bg-surface p-1">
      {([{value:'inherit',label:'기본값'},{value:'work',label:'작품테마'},{value:'builtin',label:'기본 테마'},{value:'custom',label:'커스텀'}]as const).map(o=>
        <button key={o.value} disabled={busy||saving} aria-pressed={shownMode===o.value}
          onClick={()=>void chooseMode(o.value)}
          className={`rounded-lg px-1 py-2 text-xs ${shownMode===o.value?'bg-brand text-white':'text-slate-400'}`}>{o.label}</button>)}
    </div>
    {mode==='inherit'&&!open&&<>
      <div className="mt-2 grid grid-cols-2 gap-2" role="group" aria-label="사이트 기본 테마">
        {(['light','dark']as const).map(v=><button key={v} type="button" disabled={busy||saving||siteSaving||siteMode===null}
          aria-pressed={siteMode===v} onClick={()=>void chooseSiteTheme(v)}
          className={`rounded-lg px-3 py-2 text-xs ${siteMode===v?'bg-brand text-white':'bg-surface2 text-slate-400'}`}>
          {v==='light'?'☀️ 라이트':'🌙 다크'}
        </button>)}
      </div>
      <p className="mt-2 text-xs text-slate-500">사이트의 화면 테마 설정과 연동됩니다. 변경 시 다른 채팅방에도 적용되며, 작품 기본 테마 사용 설정은 유지됩니다.</p>
      {siteMode==='custom'&&<p className="mt-1 text-xs text-slate-500">현재 사이트 기본 설정은 커스텀 테마입니다. 라이트 또는 다크를 선택하면 기본 테마로 전환됩니다.</p>}
    </>}
    {mode==='custom'&&!open&&<div className="mt-2 flex items-center justify-between gap-2 rounded-lg bg-surface p-2">
      <span className="truncate text-xs text-white">{theme?.name??'테마를 다시 선택해 주세요'}</span>
      <button disabled={busy||saving} onClick={()=>{setPickerScope(theme?.work_id?'work':'global');setOpen(true);}} className="text-xs text-brand">변경</button>
    </div>}
    {(mode==='builtin'||mode==='custom')&&!open&&<div className="mt-2 grid grid-cols-2 gap-2">
      {(['light','dark']as const).map(v=>
        <button key={v} disabled={busy||saving} aria-pressed={variant===v} onClick={()=>void save(mode==='custom'?'custom':'builtin',mode==='custom'?session.theme_id??null:null,v)}
          className={`rounded-lg px-3 py-2 text-xs ${variant===v?'bg-brand text-white':'bg-surface2 text-slate-400'}`}>
          {v==='dark'?'🌙 다크':'☀️ 라이트'}
        </button>)}
    </div>}
    {mode==='custom'&&!open&&<p className="mt-2 text-xs text-slate-500">자동으로 테마가 바뀌어도 선택한 라이트·다크를 유지합니다. 해당 색상이 없는 테마는 제공되는 색상으로 표시됩니다.</p>}
    {open&&<div className="mt-3 rounded-lg border border-surface2">
      <ThemeMenu userId={userId} workId={session.work_id} scope={pickerScope} selectedId={session.theme_id}
        onClose={()=>setOpen(false)} onSelect={selected=>{
          const next=session.theme_variant??'light';
          void save('custom',selected.id,next,selected).then(ok=>{if(ok)setOpen(false);});
        }}/>
    </div>}
  </section>;
}
