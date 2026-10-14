import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Execute pure TS helpers without adding a test runner or browser dependencies.
const source = readFileSync(new URL('../src/lib/theme.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const theme = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
const { DEFAULT_DARK, DEFAULT_LIGHT, validPalette, paletteFor, bothVariants, resolveThemeSelection } = theme;

const darkOnly = { dark_colors: DEFAULT_DARK, light_colors: null };
const lightOnly = { dark_colors: null, light_colors: DEFAULT_LIGHT };
const both = { dark_colors: DEFAULT_DARK, light_colors: DEFAULT_LIGHT };
assert.equal(validPalette(DEFAULT_DARK), true);
assert.equal(validPalette({ ...DEFAULT_DARK, main: '#xyzxyz' }), false);
assert.equal(validPalette({ accent: '#333333' }), false);
assert.deepEqual(paletteFor(darkOnly, 'light'), { palette: DEFAULT_DARK, variant: 'dark' });
assert.deepEqual(paletteFor(lightOnly, 'dark'), { palette: DEFAULT_LIGHT, variant: 'light' });
assert.equal(paletteFor({ dark_colors: null, light_colors: null }, 'dark'), null);
assert.equal(bothVariants(both), true);
assert.equal(bothVariants(darkOnly), false);

const user = {
  prefer_work_theme: true,
  preferred_theme_mode: 'custom',
  preferred_theme_id: 'user-palette',
  preferred_theme_variant: 'light',
};
const work = { default_theme_id: 'work-palette', default_theme_variant: 'dark' };
assert.deepEqual(resolveThemeSelection(user, work, null, 'dark'), {themeId:'work-palette',variant:'dark'});
assert.deepEqual(resolveThemeSelection(user, work,
  {theme_override:'custom',theme_id:'chat-palette',theme_variant:'light'}, 'dark'),
  {themeId:'chat-palette',variant:'light'});
assert.deepEqual(resolveThemeSelection(user, work,
  {theme_override:'builtin',theme_id:null,theme_variant:'dark'}, 'light'),
  {themeId:null,variant:'dark'});
assert.deepEqual(resolveThemeSelection({...user, prefer_work_theme:false}, work, null, 'dark'),
  {themeId:'user-palette',variant:'light'});
assert.deepEqual(resolveThemeSelection({...user, preferred_theme_mode:'dark'}, work, null, 'light'),
  {themeId:'work-palette',variant:'dark'});
assert.deepEqual(resolveThemeSelection({preferred_theme_mode:'dark',prefer_work_theme:false},work,null,'light'),
  {themeId:null,variant:'dark'});
assert.deepEqual(resolveThemeSelection(null,null,null,'light'), {themeId:null,variant:'light'});

const properties = new Map();
const storage = new Map();
const events = [];
const style = {
  removeProperty: name => properties.delete(name),
  setProperty: (name, value) => properties.set(name, value),
  getPropertyValue: name => properties.get(name) ?? '',
  colorScheme: '',
};
globalThis.document = { documentElement: { dataset:{}, style } };
globalThis.window = {
  localStorage: {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
  },
  dispatchEvent: event => events.push(event.type),
};
globalThis.Event = class Event { constructor(type){ this.type = type; } };

theme.applyTheme('dark');
assert.equal(theme.loadTheme(), 'dark');
assert.equal(document.documentElement.dataset.theme, 'dark');
theme.applyCustomTheme(DEFAULT_LIGHT, 'light');
assert.equal(document.documentElement.dataset.theme, 'custom');
assert.equal(document.documentElement.dataset.themeVariant, 'light');
assert.equal(style.colorScheme, 'light');
assert.equal(properties.get('--color-brand'), '99 102 241');
assert.equal(properties.get('--page-text'), DEFAULT_LIGHT.mainText);
theme.applyTheme('light');
assert.equal(theme.loadTheme(), 'light');
assert.equal(document.documentElement.dataset.themeVariant, undefined);
assert.equal(properties.has('--color-brand'), false);
assert.equal(properties.has('--page-bg'), false);
theme.requestThemeRefresh();
assert.deepEqual(events, ['inuchat:theme-changed']);

console.log('Theme palettes, inheritance priority, and runtime reset: OK');

assert.equal(validPalette({...DEFAULT_LIGHT,secondaryText:'#aa33ee',softenSecondaryText:false}),true);
assert.equal(validPalette({...DEFAULT_LIGHT,secondaryText:'pink'}),false);
assert.equal(validPalette({...DEFAULT_LIGHT,secondaryText:null}),false);
assert.equal(validPalette({...DEFAULT_LIGHT,softenSecondaryText:'false'}),false);
assert.equal(theme.secondaryTextStyles(DEFAULT_LIGHT).chatOpacity,.65);
assert.equal(theme.secondaryTextStyles(DEFAULT_LIGHT).chatColor,'inherit');
assert.equal(theme.secondaryTextStyles(DEFAULT_LIGHT).soft,`color-mix(in srgb, ${DEFAULT_LIGHT.mainText} 65%, ${DEFAULT_LIGHT.main})`);
assert.equal(theme.secondaryTextStyles(DEFAULT_LIGHT).muted,`color-mix(in srgb, ${DEFAULT_LIGHT.mainText} 65%, ${DEFAULT_LIGHT.main})`);
const secondaryPalette={...DEFAULT_DARK,secondaryText:'#aa33ee',softenSecondaryText:false};
theme.applyCustomTheme(secondaryPalette,'dark');
assert.equal(properties.get('--secondary-text'),'#aa33ee');
assert.equal(properties.get('--secondary-text-soft'),'#aa33ee');
assert.equal(properties.get('--secondary-text-muted'),'#aa33ee');
assert.equal(properties.get('--chat-secondary-color'),'#aa33ee');
assert.equal(properties.get('--chat-secondary-opacity'),'1');
theme.applyCustomTheme({...secondaryPalette,softenSecondaryText:true},'dark');
assert.equal(properties.get('--chat-secondary-opacity'),'0.65');
theme.applyCustomTheme(DEFAULT_DARK,'dark');
assert.equal(properties.get('--chat-secondary-color'),'inherit');
theme.applyTheme('light');
for(const key of ['--secondary-text','--secondary-text-soft','--secondary-text-muted','--chat-secondary-color','--chat-secondary-opacity','--secondary-extra-opacity'])assert.equal(properties.has(key),false);
console.log('Secondary text: optional validation, legacy appearance, default 65% chat opacity, OFF color and built-in reset OK');

for(const opacity of [0,1,35,65,100]){
  assert.equal(validPalette({...DEFAULT_DARK,secondaryTextOpacity:opacity}),true);
  const styles=theme.secondaryTextStyles({...DEFAULT_DARK,secondaryTextOpacity:opacity});
  assert.equal(styles.chatOpacity,opacity/100);
  assert.ok(styles.muted.includes(` ${opacity}%`));
  assert.equal(theme.secondaryTextStyles({...DEFAULT_DARK,secondaryTextOpacity:opacity,softenSecondaryText:false}).chatOpacity,1);
}
for(const opacity of [-1,101,3.5,'65',null,NaN])assert.equal(validPalette({...DEFAULT_DARK,secondaryTextOpacity:opacity}),false);
console.log('Secondary opacity: 0-100 adjustment, default 65%, invalid values and OFF override OK');
