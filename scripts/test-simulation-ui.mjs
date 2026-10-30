import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { renderToStaticMarkup } from "react-dom/server";
const uri = (s) =>
  "data:text/javascript;base64," + Buffer.from(s).toString("base64");
const hooks = uri(
  `export const useEffect=()=>{};export const useMemo=f=>f();export function useState(v){const h=globalThis.__simUI,i=h.index++;if(!(i in h.values))h.values[i]=typeof v==='function'?v():v;return[h.values[i],next=>h.values[i]=typeof next==='function'?next(h.values[i]):next]};export function useRef(v){const h=globalThis.__simUI,i=h.index++;return h.values[i]??=({current:v})}`,
);
const calls = [];
globalThis.__simDb = {
  rpc: async (name, args) => {
    calls.push({ name, args });
    return { data: args.desired ?? true, error: null };
  },
};
const imports = {
  react: hooks,
  "@/lib/supabase": uri("export const supabase=globalThis.__simDb;"),
  "@/lib/simulation/runtime": uri(
    "export const loadSimulationPrompts=async()=>({});export const readSimulationContext=async()=>({});export const replayContext=()=>({state:null,pending:[]});",
  ),
  "@/lib/simulation/types": uri(
    'export const DEFAULT_PROMPTS={dice:"DEFAULT DICE",knowledge:"DEFAULT KNOWLEDGE",analystModel:"analyst",verifierModel:"jev"};',
  ),
  "./Toggle": uri(
    "import {createElement} from " +
      JSON.stringify(import.meta.resolve("react")) +
      ';export default props=>createElement("button",{...props,role:"switch",onClick:()=>props.onChange(!props.checked)},props["aria-label"]);',
  ),
};
async function component(path) {
  const source = ts.transpileModule(
    readFileSync(new URL("../src/components/" + path, import.meta.url), "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
      },
    },
  ).outputText;
  return (
    await import(
      uri(
        source.replace(
          /from\s+(['"])([^'"]+)\1/g,
          (_, q, p) =>
            "from " + JSON.stringify(imports[p] ?? import.meta.resolve(p)),
        ),
      )
    )
  ).default;
}
const nodes = (n, p, out = []) => {
  if (!n || typeof n !== "object") return out;
  if (p(n)) out.push(n);
  for (const c of [n.props?.children].flat(Infinity)) nodes(c, p, out);
  return out;
};
const tick = () => new Promise((r) => setTimeout(r, 0));
const Session = await component("SessionSimulationSettings.tsx");
let patch;
let props = {
  session: { id: "room", simulation_settings: {} },
  busy: false,
  turn: 12,
  onUpdate: (p) => (patch = p),
};
globalThis.__simUI = { index: 0, values: [] };
const render = () => {
  globalThis.__simUI.index = 0;
  return Session(props);
};
let tree = render();
assert(renderToStaticMarkup(tree).includes("주사위 판정"));
assert(renderToStaticMarkup(tree).includes("정보 접근 관리"));
const toggle = (t, label) =>
  nodes(t, (n) => n.props?.["aria-label"] === label)[0];
toggle(tree, "주사위 판정").props.onChange(true);
await tick();
assert.deepEqual(patch.simulation_settings, { dice: true, knowledge: false });
props = {
  ...props,
  session: { id: "room", simulation_settings: patch.simulation_settings },
};
tree = render();
toggle(tree, "정보 접근 관리").props.onChange(true);
await tick();
assert.deepEqual(patch.simulation_settings, {
  dice: true,
  knowledge: true,
  knowledgeFromTurn: 12,
});
props = { ...props, busy: true };
tree = render();
assert(toggle(tree, "주사위 판정").props.disabled);
assert(toggle(tree, "정보 접근 관리").props.disabled);
const Admin = await component("SimulationPromptSettings.tsx");
const value = {
  dice: "EDITABLE DICE",
  knowledge: "EDITABLE KNOWLEDGE",
  analystModel: "analyst",
  verifierModel: "jev",
};
globalThis.__simUI = {
  index: 0,
  values: [value, true, false, "", 0, { current: {} }, { current: false }],
};
let admin = Admin();
const editors = nodes(admin, (n) => n.type === "textarea");
assert.equal(editors.length, 2);
editors[0].props.onChange({ target: { value: "NEW DICE" } });
globalThis.__simUI.index = 0;
admin = Admin();
nodes(
  admin,
  (n) => n.type === "button" && n.props.children === "전역 판정·정보 규칙 저장",
)[0].props.onClick();
await tick();
assert.equal(calls.at(-1).name, "save_simulation_prompts");
assert.equal(calls.at(-1).args.desired.dice, "NEW DICE");
assert.equal(calls.at(-1).args.desired.knowledge, "EDITABLE KNOWLEDGE");
console.log(
  "Simulation JSX: independent toggles, initial recording point, busy state and two separate administrator prompt editors/save boundaries passed.",
);
delete globalThis.__simUI;
delete globalThis.__simDb;
