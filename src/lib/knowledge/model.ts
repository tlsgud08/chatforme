import { openRouterReasoningPayload } from "../llm/reasoningPayloads";
import { supabase } from "../supabase";


export interface ModelOptions {
  apiKey: string;
  sessionId: string;
  model: string;
  signal: AbortSignal;
  reasoning?: import("../llm/types").ReasoningSelection;
}
async function responseJSON(url: string, body: unknown, o: ModelOptions) {
  o.signal.throwIfAborted();
  const timeout = AbortSignal.timeout(90_000);
  const signal = AbortSignal.any([o.signal, timeout]);
  const res = await fetch(url, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${o.apiKey}`,
      "HTTP-Referer": window.location.origin,
      "X-Title": "Inuchat",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`보조 모델 요청 실패 (${res.status})`);
  return res.json();
}
async function account(
  data: Record<string, unknown>,
  o: ModelOptions,
) {
  const usage = (data.usage ?? {}) as Record<string, unknown>;
  const number = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
  const { error } = await supabase.rpc("record_knowledge_call", {
    target_session: o.sessionId,
    call_id: crypto.randomUUID(),
    model_name: o.model,
    in_tokens: number(usage.prompt_tokens ?? usage.input_tokens),
    out_tokens: number(usage.completion_tokens ?? usage.output_tokens),
    call_cost: number(usage.cost),
  });
  if (error) throw new Error("보조 모델 비용 기록 실패: " + error.message);
}
export async function structured<T>(
  o: ModelOptions,
  instructions: string,
  state: unknown,
  schema: object,
  maxTokens = 1600,
): Promise<T> {
  const data = await responseJSON(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      model: o.model,
      session_id: `${o.sessionId.slice(0, 36)}:knowledge`,
      stream: false,
      max_tokens: maxTokens,
      temperature: 0,
      ...openRouterReasoningPayload(o.model, o.reasoning ?? { effort: "off" }),
      provider: { require_parameters: true },
      usage: { include: true },
      response_format: {
        type: "json_schema",
        json_schema: { name: "knowledge_changes", strict: true, schema },
      },
      messages: [
        { role: "system", content: instructions },
        { role: "user", content: JSON.stringify(state) },
      ],
    },
    o,
  );
  await account(data, o);
  if (data.choices?.[0]?.finish_reason === "length")
    throw new Error(
      "보조 모델의 기록이 출력 한도를 초과했습니다. 기록을 나눠 다시 처리해 주세요.",
    );
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string")
    throw new Error("보조 모델이 구조화 기록을 반환하지 않았습니다.");
  try {
    return JSON.parse(content) as T;
  } catch {
    throw new Error("보조 모델의 JSON 기록을 해석하지 못했습니다.");
  }
}
