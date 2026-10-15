import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Session } from '@/types/db';
import { supabase } from '@/lib/supabase';
import { showToast } from '@/lib/toast';
import { appliedThemeIsSingle, appliedThemeLabel, appliedThemeVariant, bothVariants, loadTheme, preferredThemeVariant, previewThemeVariant, requestThemeRefresh, subscribeAppliedTheme, themeVariantPreferencePatch, type SavedTheme, type ThemeVariant } from '@/lib/theme';
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
  const [siteVariant,setSiteVariant]=useState<ThemeVariant>('light');
  const [siteSaving,setSiteSaving]=useState(false);
  const appliedVariant=useSyncExternalStore(subscribeAppliedTheme,appliedThemeVariant,()=> 'light' as const);
  const appliedSingle=useSyncExternalStore(subscribeAppliedTheme,appliedThemeIsSingle,()=>false);
  const appliedLabel=useSyncExternalStore(subscribeAppliedTheme,appliedThemeLabel,()=> '기본 테마 · 라이트');
  const shownVariant=appliedSingle?(siteMode===null?null:siteVariant):appliedVariant;
  const mutationRevision=useRef(0);
  const writePending=useRef(false);
  const isFluid=session.theme_override==null;
  useEffect(()=>{
    let active=true;
    let generation=0;
    const refresh=async()=>{
      if(writePending.current)return;
      const run=++generation,revision=mutationRevision.current;
      const {data,error}=await supabase.from('profiles').select('preferred_theme_mode,preferred_theme_variant').eq('id',userId).maybeSingle();
      if(!active||error||run!==generation||revision!==mutationRevision.current)return;
      setSiteMode(data?.preferred_theme_mode??(loadTheme()==='dark'?'dark':'light'));
      setSiteVariant(preferredThemeVariant(data,loadTheme()==='dark'?'dark':'light'));
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
    let generation=0;
    const refresh=async()=>{
      if(writePending.current)return;
      const run=++generation,revision=mutationRevision.current;
      const {data}=await supabase.from('sessions').select('theme_override,theme_id,theme_variant').eq('id',session.id).eq('user_id',userId).maybeSingle();
      if(!active||!data||run!==generation||revision!==mutationRevision.current)return;
      if(data.theme_override!==session.theme_override||data.theme_id!==session.theme_id||data.theme_variant!==session.theme_variant){
        onUpdate(data);
      }
      if(session.theme_id){
        const {data:latest}=await supabase.from('themes').select('*').eq('id',session.theme_id).maybeSingle();
        if(active&&run===generation&&revision===mutationRevision.current)setTheme(latest as SavedTheme|null);
      }
    };
    const listener=()=>{void refresh();};
    window.addEventListener('inuchat:theme-changed',listener);
    window.addEventListener('focus',listener);
    return ()=>{active=false;window.removeEventListener('inuchat:theme-changed',listener);window.removeEventListener('focus',listener);};
  },[session.id,session.theme_override,session.theme_id,session.theme_variant,userId,onUpdate]);

  async function save(override:'builtin'|'custom'|null,id:string|null,variant:ThemeVariant|null,selected?:SavedTheme):Promise<boolean>{
    if(busy||writePending.current)return false;
    writePending.current=true;
    mutationRevision.current++;
    setSaving(true);
    const {data,error}=await supabase.from('sessions').update({
      theme_override:override,theme_id:id,theme_variant:variant,
      // Keep the legacy column compatible; behavior is determined by mode alone.
      auto_theme_enabled:override===null,
    }).eq('id',session.id).eq('user_id',userId).select('*').single();
    writePending.current=false;
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
  const singlePreference=siteMode===null?previewThemeVariant():siteVariant;
  async function chooseSiteTheme(next:ThemeVariant){
    if(busy||writePending.current)return;
    writePending.current=true;
    mutationRevision.current++;
    setSiteSaving(true);
    try{
      // Read the current mode so an edit in another settings surface is retained.
      const {data:preference,error:readError}=await supabase.from('profiles')
        .select('preferred_theme_mode,preferred_theme_variant').eq('id',userId).single();
      if(readError)throw readError;
      const {data,error}=await supabase.from('profiles').update(themeVariantPreferencePatch(preference,next))
        .eq('id',userId).select('preferred_theme_mode,preferred_theme_variant').single();
      if(error)throw error;
      setSiteMode(data.preferred_theme_mode);
      setSiteVariant(preferredThemeVariant(data,next));
      // The existing DB trigger updates fluid variants, retaining all palette IDs.
    }catch(error){
      showToast('사이트 테마 변경 실패: '+(error instanceof Error?error.message:(error as {message?:string})?.message??String(error)));
      return;
    }finally{
      writePending.current=false;
      setSiteSaving(false);
    }
    requestThemeRefresh();
  }
  async function chooseMode(next:'inherit'|'work'|'builtin'|'custom'){
    if(busy||writePending.current)return;
    if(next==='inherit'&&isFluid){setOpen(false);return;}
    if(next==='work'){setPickerScope('work');setOpen(true);return;}
    if(next==='custom'){
      setPickerScope('global');
      if(lastCustom?.id&&!lastCustom.theme?.work_id){
        const ok=await save('custom',lastCustom.id,appliedSingle?singlePreference:lastCustom.variant,lastCustom.theme??undefined);
        if(ok){setOpen(false);return;}
      }
      setOpen(true);
      return;
    }
    setOpen(false);
    if(next==='inherit'){
      // Do not reset the visible palette merely because the tab becomes fluid.
      const visibleVariant=appliedThemeIsSingle()?singlePreference:appliedThemeVariant();
      await save(null,session.theme_override==='custom'?session.theme_id??null:null,visibleVariant);
      return;
    }
    await save('builtin',null,appliedSingle?singlePreference:variant);
  }
  return <section className="mt-4 border-t border-surface2 pt-4">
    <h3 className="mb-2 text-sm font-semibold text-white">채팅방 테마</h3>
    <p className="mb-3 text-xs text-slate-500">개별 선택이 가장 우선하며, 모든 기기에 동기화됩니다.</p>
    <p className="mb-3 text-xs text-slate-500">유동적에서는 AI 응답에 따라 테마가 자동으로 변경됩니다. 다른 모드에서는 선택한 테마를 유지합니다.</p>
    <div className="grid grid-cols-4 gap-1 rounded-lg bg-surface p-1">
      {([{value:'inherit',label:'유동적'},{value:'work',label:'작품테마'},{value:'builtin',label:'기본 테마'},{value:'custom',label:'커스텀'}]as const).map(o=>
        <button key={o.value} disabled={busy||saving||siteSaving} aria-pressed={shownMode===o.value}
          onClick={()=>void chooseMode(o.value)}
          className={`rounded-lg px-1 py-2 text-xs ${shownMode===o.value?'bg-brand text-white':'text-slate-400'}`}>{o.label}</button>)}
    </div>
    {mode==='inherit'&&!open&&<>
      <p className="mt-2 break-words rounded-lg bg-surface p-2 text-xs text-slate-200" role="status">현재 적용: {appliedLabel}</p>
      <div className="mt-2 grid grid-cols-2 gap-2" role="group" aria-label="사이트 기본 테마">
        {(['light','dark']as const).map(v=><button key={v} type="button" disabled={busy||saving||siteSaving}
          aria-pressed={shownVariant===v} onClick={()=>void chooseSiteTheme(v)}
          className={`rounded-lg px-3 py-2 text-xs ${shownVariant===v?'bg-brand text-white':'bg-surface2 text-slate-400'}`}>
          {v==='light'?'☀️ 라이트':'🌙 다크'}
        </button>)}
      </div>
      <p className="mt-2 text-xs text-slate-500">{appliedSingle?'현재 화면은 단일 테마입니다. 라이트·다크는 이후 두 버전이 있는 테마에 사용할 사이트 전역 설정이며, 단일 테마의 색상은 바뀌지 않습니다.':'선택 표시는 현재 화면에 적용된 라이트·다크를 따릅니다. 버튼을 누르면 사이트 전역 설정도 함께 변경됩니다.'} 유동적 선택 자체는 현재 화면을 바꾸지 않으며, AI가 테마를 바꾸어도 유동적 모드는 유지됩니다.</p>
      {siteMode==='custom'&&<p className="mt-1 text-xs text-slate-500">전역 커스텀 테마는 유지되며, 라이트·다크 선호값만 함께 저장됩니다.</p>}
    </>}
    {mode==='custom'&&!open&&<div className="mt-2 flex items-center justify-between gap-2 rounded-lg bg-surface p-2">
      <span className="truncate text-xs text-white">{theme?.name??'테마를 다시 선택해 주세요'}</span>
      <button disabled={busy||saving} onClick={()=>{setPickerScope(theme?.work_id?'work':'global');setOpen(true);}} className="text-xs text-brand">변경</button>
    </div>}
    {(mode==='builtin'||mode==='custom'&&theme&&bothVariants(theme))&&!open&&<div className="mt-2 grid grid-cols-2 gap-2">
      {(['light','dark']as const).map(v=>
        <button key={v} disabled={busy||saving} aria-pressed={variant===v} onClick={()=>void save(mode==='custom'?'custom':'builtin',mode==='custom'?session.theme_id??null:null,v)}
          className={`rounded-lg px-3 py-2 text-xs ${variant===v?'bg-brand text-white':'bg-surface2 text-slate-400'}`}>
          {v==='dark'?'🌙 다크':'☀️ 라이트'}
        </button>)}
    </div>}
    {mode==='custom'&&!open&&<p className="mt-2 text-xs text-slate-500">{theme&&!bothVariants(theme)?'단일 테마 · 라이트·다크 설정에 관계없이 같은 색상으로 표시됩니다.':'이 모드에서는 선택한 테마와 라이트·다크를 고정합니다.'}</p>}
    {open&&<div className="mt-3 rounded-lg border border-surface2">
      <ThemeMenu userId={userId} workId={session.work_id} scope={pickerScope} selectedId={session.theme_id}
        onClose={()=>setOpen(false)} onSelect={selected=>{
          const next=appliedSingle?singlePreference:session.theme_variant??siteVariant;
          void save('custom',selected.id,next,selected).then(ok=>{if(ok)setOpen(false);});
        }}/>
    </div>}
  </section>;
}
