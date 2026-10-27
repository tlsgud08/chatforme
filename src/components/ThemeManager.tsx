import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/lib/supabase';
import { invalidateInFlight, shareInFlight } from '@/lib/inFlight';
import { activeThemeWorkIds, type WorkThemeScope } from '@/lib/workCombination';
import { automaticThemeAvailable, dayNightDisplayVariant, dayNightModeEnabled } from '@/lib/themeDirectives';
import { applyCustomTheme, applyTheme, bothVariants, loadTheme, paletteFor, preferredThemeVariant, resolveThemeSelection, type SavedTheme, type ThemeVariant } from '@/lib/theme';

type Preference = { prefer_work_theme: boolean; preferred_theme_mode: 'dark' | 'light' | 'custom' | null; preferred_theme_id: string | null; preferred_theme_variant: ThemeVariant | null };
type WorkDefault = { default_theme_id: string | null; default_theme_variant: ThemeVariant | null };
type SessionTheme = WorkThemeScope & { theme_override: 'builtin' | 'custom' | null; theme_id: string | null; theme_variant: ThemeVariant | null; theme_day_night_enabled?:boolean; theme_period?:'day'|'night'|null };

/** Single owner of document-level theme application. Refetches on route changes,
 * explicit preference updates and browser focus (cross-device sync). */
export default function ThemeManager() {
  const { user } = useAuth();
  const location = useLocation();
  useEffect(() => {
    let current = true;
    let generation = 0;
    async function refresh() {
      const run = ++generation;
      if (!user) {
        const base=loadTheme()==='dark'?'dark':'light';
        applyTheme(base); return;
      }
      const { data: profile, error: profileError } = await shareInFlight(`theme:profile:${user.id}`, () => supabase.from('profiles')
        .select('prefer_work_theme,preferred_theme_mode,preferred_theme_id,preferred_theme_variant')
        .eq('id', user.id).maybeSingle());
      if (!current || generation!==run || profileError) return;
      const pref = profile as Preference | null;
      const legacyMode = loadTheme()==='dark'?'dark':'light';
      const preferredVariant=preferredThemeVariant(pref,legacyMode);
      let session: SessionTheme | null = null;
      let workDefault: WorkDefault | null = null;
      const chatMatch = /^\/(?:chat|multichat)\/([0-9a-f-]+)$/i.exec(location.pathname);
      if (chatMatch) {
        const { data, error: sessionError } = await shareInFlight(`theme:session:${user.id}:${chatMatch[1]}`, () => supabase.from('sessions').select('work_id,theme_override,theme_id,theme_variant,theme_day_night_enabled,theme_period,work_combination_enabled,combined_work_ids').eq('id',chatMatch[1]).maybeSingle());
        if (!current || run!==generation || sessionError) return;
        session = data as SessionTheme | null;
        if (!session?.theme_override && !session?.theme_id && !session?.theme_variant && session?.work_id && pref?.prefer_work_theme !== false) {
          const { data: work, error: workError } = await shareInFlight(`theme:work:${user.id}:${session.work_id}`, () => supabase.from('works').select('default_theme_id,default_theme_variant').eq('id',session!.work_id).maybeSingle());
          if (!current || run!==generation || workError) return;
          workDefault = work as WorkDefault | null;
        }
      }
      let {themeId,variant} = resolveThemeSelection(pref,workDefault,session,legacyMode);
      const readPalette=(id:string)=>shareInFlight(`theme:palette:${user.id}:${id}`, () => supabase.from('themes').select('*').eq('id',id).maybeSingle());
      if (themeId) {
        let { data: theme, error: themeError } = await readPalette(themeId);
        if (!current || run!==generation || themeError) return;
        let unavailable=!theme&&!!session?.theme_id;
        // Own private palettes remain readable after work access is revoked.
        // Check the linked work as well as the theme's RLS before rendering it.
        if(theme?.work_id&&session&&theme.work_id!==session.work_id){
          const inScope=activeThemeWorkIds(session).includes(theme.work_id);
          const linked=inScope?await shareInFlight(`theme:access:${user.id}:${theme.work_id}`,()=>supabase.from('works').select('id').eq('id',theme!.work_id).maybeSingle()):null;
          if(!current||run!==generation||linked?.error)return;
          unavailable=!inScope||!linked?.data;
        }
        if(unavailable&&session){
          if(pref?.prefer_work_theme!==false){
            const main=await shareInFlight(`theme:work:${user.id}:${session.work_id}`,()=>supabase.from('works').select('default_theme_id,default_theme_variant').eq('id',session!.work_id).maybeSingle());
            if(!current||run!==generation||main.error)return;
            workDefault=main.data as WorkDefault|null;
          }
          ({themeId,variant}=resolveThemeSelection(pref,workDefault,null,legacyMode));
          if(themeId){
            ({data:theme,error:themeError}=await readPalette(themeId));
            if(!current||run!==generation||themeError)return;
          }else theme=null;
          session={...session,theme_override:null,theme_id:themeId,theme_variant:variant,theme_period:null};
        }
        // Time-only scenes must not remain visible in fluid mode after the
        // feature is disabled. Fall back to the account's exact custom palette.
        if(theme&&session&&session.theme_override==null&&!automaticThemeAvailable(theme as SavedTheme,dayNightModeEnabled(session,preferredVariant))){
          ({themeId,variant}=resolveThemeSelection(pref,null,null,legacyMode));
          if(themeId){
            ({data:theme,error:themeError}=await readPalette(themeId));
            if(!current||run!==generation||themeError)return;
          }else theme=null;
        }
        const selected=theme ? paletteFor(theme as SavedTheme,dayNightDisplayVariant(theme as SavedTheme,session,preferredVariant,variant)):null;
        if (selected) { applyCustomTheme(selected.palette,selected.variant,bothVariants(theme as SavedTheme)?'dual':'single',(theme as SavedTheme).name,preferredVariant); return; }
      }
      applyTheme(variant,preferredVariant);
    }
    // A failed read must preserve the applied theme until a later refresh.
    const refreshSafely = () => { void refresh().catch(() => {}); };
    let scheduled: ReturnType<typeof setTimeout> | undefined;
    // Browser resume commonly emits pageshow, focus and visibility together.
    const trigger=()=>{ clearTimeout(scheduled); scheduled=setTimeout(refreshSafely,50); };
    // A settings write requires a fresh read, even if an earlier read is pending.
    const changed=()=>{ clearTimeout(scheduled); invalidateInFlight('theme:'); refreshSafely(); };
    const visibility=()=>{if(document.visibilityState==='visible')trigger();};
    refreshSafely();
    window.addEventListener('inuchat:theme-changed',changed);
    window.addEventListener('focus',trigger);
    window.addEventListener('pageshow',trigger);
    document.addEventListener('visibilitychange',visibility);
    return ()=>{clearTimeout(scheduled);current=false;generation++;window.removeEventListener('inuchat:theme-changed',changed);window.removeEventListener('focus',trigger);window.removeEventListener('pageshow',trigger);document.removeEventListener('visibilitychange',visibility);};
  },[user?.id,location.pathname]);
  return null;
}
