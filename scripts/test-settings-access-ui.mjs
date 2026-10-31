import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createElement } from 'react';
const read = file => readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const compile = code => ts.transpileModule(code.replace(/^import .*$/gm, '').replace(/\bexport /g, ''), { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React, jsxFactory: 'jsx',
} }).outputText;
const tick = () => new Promise(resolve => setImmediate(resolve));
function hooks() {
  const values = [], refs = [], effects = []; let index = 0, refIndex = 0;
  return { values, effects, reset() { index = 0;refIndex = 0;effects.length = 0; },
    useState(initial) { const i=index++;if(!(i in values))values[i]=typeof initial==='function'?initial():initial;return [values[i],next=>{values[i]=typeof next==='function'?next(values[i]):next;}]; },
    useRef(initial) { return refs[refIndex++]??={current:initial}; }, useEffect(fn) { effects.push(fn); },
  };
}
function nodes(node) { return !node||typeof node!=='object'?[]:[node,...[node.props?.children].flat(Infinity).flatMap(nodes)]; }
const button = (tree,text) => nodes(tree).find(node=>node.type==='button'&&node.props.children===text);
const h=hooks(), grants=[], writes=[];
const people=[{id:'b',display_name:'동일 닉네임'},{id:'c',display_name:'동일 닉네임'}];
let auth={user:{id:'owner'},isAdmin:true};
const Panel=vm.runInNewContext(compile(read('src/components/SettingsAccessManager.tsx'))+'\nSettingsAccessManager',{
  ...h,jsx:createElement,AbortController,useAuth:()=>auth,
  supabase:{from:table=>({select(){return this;},order(){return this;},limit(){return this;},abortSignal(){return this;},ilike(){return this;},in(_key,ids){this.ids=ids;return this;},eq(_key,id){this.id=id;return this;},
    insert(value){this.add=value;return this;},delete(){this.remove=true;return this;},then(resolve,reject){
      if(this.add){writes.push(this.add);grants.push({...this.add,created_at:'now'});}
      if(this.remove){writes.push({remove:this.id});grants.splice(grants.findIndex(row=>row.user_id===this.id),1);}
      const data=table==='settings_admins'?[...grants]:people.filter(person=>!this.ids||this.ids.includes(person.id));
      return Promise.resolve({data,error:null}).then(resolve,reject);
    },
  })},
});
const render=()=>{h.reset();return Panel();};
let tree=render();h.effects[0]();await tick();tree=render();
nodes(tree).find(node=>node.type==='input').props.onChange({target:{value:'동일'}});tree=render();
nodes(tree).find(node=>node.type==='form').props.onSubmit({preventDefault(){}});await tick();tree=render();
assert.ok(nodes(tree).some(node=>node.props?.children==='b'));assert.ok(nodes(tree).some(node=>node.props?.children==='c'),'duplicate names retain visible unique IDs');
button(tree,'권한 부여').props.onClick();button(tree,'권한 부여').props.onClick();await tick();tree=render();
assert.equal(writes.length,1);assert.equal(writes[0].user_id,'b');assert.equal(writes[0].granted_by,'owner');
assert.ok(button(tree,'권한 있음'));button(tree,'권한 회수').props.onClick();await tick();tree=render();assert.deepEqual(writes.at(-1),{remove:'b'});
auth={user:{id:'b'},isAdmin:false};assert.equal(render(),null,'delegated users cannot open the permission manager');

const p=hooks(), listeners=new Map();let allowed=true, fail=false;
p.values[0]={user:{id:'b',email:'member@test'}};p.values[1]=false;p.values[2]={userId:'owner',allowed:true};
const Provider=vm.runInNewContext(compile(read('src/hooks/useAuth.tsx'))+'\nAuthProvider',{
  ...p,jsx:createElement,AbortController,ADMIN_EMAIL:'owner@test',createContext:()=>({Provider:'provider'}),useContext(){},useQueryClient:()=>({}),
  window:{addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name)},
  supabase:{rpc(){if(fail)throw Error('denied');return{abortSignal:async()=>({data:allowed,error:null})};}},
});
function renderAuth(){p.reset();return Provider({children:null}).props.value;}
assert.equal(renderAuth().canManageSettings,false,'previous account access never crosses accounts');
const stop=p.effects.at(-1)();await tick();assert.equal(renderAuth().canManageSettings,true);assert.equal(renderAuth().isAdmin,false);
allowed=false;await listeners.get('focus')();assert.equal(renderAuth().canManageSettings,false,'focus refresh observes revocation');
allowed=true;await listeners.get('focus')();assert.equal(renderAuth().canManageSettings,true);
fail=true;await listeners.get('focus')();assert.equal(renderAuth().canManageSettings,false,'failed checks fail closed');
p.values[0]={user:{id:'c',email:'other@test'}};assert.equal(renderAuth().canManageSettings,false);
p.values[0]=null;assert.equal(renderAuth().canManageSettings,false);
p.values[0]={user:{id:'owner',email:'owner@test'}};assert.equal(renderAuth().canManageSettings,true);assert.equal(renderAuth().isAdmin,true);
stop();assert.equal(listeners.size,0);
console.log('Settings access JSX/auth: duplicate-name IDs, grant/revoke and double-click lock, founder-only management, delegate-only settings capability, account isolation, revocation and failed checks passed.');
