export interface SimulationSettings {
  dice?: boolean;
  knowledge?: boolean;
  knowledgeFromTurn?: number;
  rerollDice?: boolean;
}
export interface DiceRules {
  die: number;
  successMin: number;
  criticalMin: number;
  statStep: number;
  skills: string[];
  actors: Record<string, Record<string, number>>;
}
export interface WorkSimulation {
  dicePrompt: string;
  knowledgePrompt: string;
  rules: DiceRules;
}
export interface SimulationPrompts {
  dice: string;
  knowledge: string;
  analystModel: string;
  verifierModel: string;
}
export interface Actor {
  name: string;
  aliases: string[];
  pc: boolean;
}
export interface Fact {
  id: string;
  kind: "pc" | "event" | "npc";
  text: string;
  secret: boolean;
  subjects: string[];
}
export interface Knowledge {
  fact: string;
  actor: string;
  status: "knows" | "suspects" | "believes" | "unknown";
  reason: string;
  quote: string;
  source: string;
}
export interface KnowledgeState {
  actors: Actor[];
  facts: Fact[];
  knowledge: Knowledge[];
  scene: string[];
}
export interface KnowledgePatch extends KnowledgeState {}
export interface SimulationEntry {
  id: string;
  content: string;
  user_text: string;
  turn_index: number;
  content_version: number;
  source_hash: string;
  patch: KnowledgePatch | null;
}
export interface Action {
  action: string;
  actor: string;
  target: string;
  skill: string;
  modifier: number;
}
export interface Roll extends Action {
  die: number;
  successMin: number;
  criticalMin: number;
  value: number;
  outcome: string;
}
export interface SimulationContext {
  entries: SimulationEntry[];
  settings: SimulationSettings;
  cost: number;
  inputTokens: number;
  outputTokens: number;
}
export const DEFAULT_RULES: DiceRules = {
  die: 6,
  successMin: 5,
  criticalMin: 6,
  statStep: 3,
  skills: ["신체", "지능", "반사", "의지"],
  actors: {},
};
export const DEFAULT_WORK: WorkSimulation = {
  dicePrompt: "",
  knowledgePrompt: "",
  rules: DEFAULT_RULES,
};
export const DEFAULT_PROMPTS: SimulationPrompts = {
  dice: "결과가 불확실하고 실패에 의미가 있는 PC의 시도만 판정한다. 평범한 대화·일상·확정된 사건에는 굴리지 않는다. 입력에 없는 행동이나 결과를 발명하지 않는다. 신체·지능 등 작품 능력과 대상, 장비·부상·거리·기습을 고려하여 상황 보정 -2~2를 제안한다. 능력치 차이는 사이트가 별도로 계산하므로 상황 보정에 중복 반영하지 않는다. 물리적으로 불가능한 시도는 굴림으로 성공시키지 않는다. 복수 행동은 인과 순서대로 나열한다. 확정 판정 결과를 서술에서 준수하되 선행 행동 실패로 불가능해진 후속 판정은 적용하지 않는다.",
  knowledge:
    "확정된 본문과 설정에 실제 근거가 있는 원자적 사실만 기록한다. PC의 배경·신분·비밀·목적, 일상 및 중대 사건, NPC의 공개 신분과 실제 정체를 분리한다. 사건 발생과 행위자의 정체를 따로 기록한다. 인물은 INFO에 등장했거나 실제로 조우한 경우와 PC만 등록한다. 사망·적대화·퇴장해도 등록 인물을 제거하지 않는다. 직접 경험·목격 또는 실제 청취·전달 근거가 있어야 knows로 제안한다. 같은 장소·조직·INFO 등장만으로 O를 만들지 않는다. 독백·작가 설명은 전달이 아니다. 추측·소문·오해는 suspects/believes로 구분한다. O를 채우려고 사유·목격·전달 장면을 발명하지 않는다. 대사 전달은 발화자의 기존 지식과 수신자의 청취 가능성을 확인한다. 모르는 인물의 근거 없는 비밀 발설을 정상 정보 획득으로 굳히지 않는다. PC의 미제공 과거는 자동 창작하지 않는다. 서술은 PC가 관찰·인지할 수 있는 범위, NPC 대사는 해당 인물이 아는 범위를 따른다. 장면 안의 실제 폭로·목격 이후에는 새로 알게 된 정보를 사용할 수 있다.",
  analystModel: "qwen/qwen3.5-flash-02-23",
  verifierModel: "typesafe/jev-1.14",
};
export const simulationEnabled = (value?: SimulationSettings | null) =>
  value?.dice === true || value?.knowledge === true;
