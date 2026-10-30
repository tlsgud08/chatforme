import { supabase } from "../supabase";

type Stage = "dice" | "knowledge" | "verify";
export interface ModelOptions {
  apiKey: string;
  sessionId: string;
  model: string;
  signal: AbortSignal;
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
  stage: Stage,
) {
  const usage = (data.usage ?? {}) as Record<string, unknown>;
  const number = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
  const { error } = await supabase.rpc("record_simulation_call", {
    target_session: o.sessionId,
    call_id: crypto.randomUUID(),
    stage_name: stage,
    model_name: o.model,
    in_tokens: number(usage.prompt_tokens ?? usage.input_tokens),
    out_tokens: number(usage.completion_tokens ?? usage.output_tokens),
    call_cost: number(usage.cost),
  });
  if (error) throw new Error("보조 모델 비용 기록 실패: " + error.message);
}
export async function structured<T>(
  o: ModelOptions,
  stage: Stage,
  instructions: string,
  state: unknown,
  schema: object,
  maxTokens = 1600,
): Promise<T> {
  const data = await responseJSON(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      model: o.model,
      session_id: `${o.sessionId.slice(0, 36)}:sim:${stage}`,
      stream: false,
      max_tokens: maxTokens,
      temperature: 0,
      reasoning: { enabled: false },
      provider: { require_parameters: true },
      usage: { include: true },
      response_format: {
        type: "json_schema",
        json_schema: { name: `simulation_${stage}`, strict: true, schema },
      },
      messages: [
        { role: "system", content: instructions },
        { role: "user", content: JSON.stringify(state) },
      ],
    },
    o,
  );
  await account(data, o, stage);
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
export async function verify(
  o: ModelOptions,
  policy: string,
  candidates: unknown[],
): Promise<boolean[]> {
  const accepted: boolean[] = [];
  // Keep each Jev request under the default text-size limit, including questions.
  for (let start = 0; start < candidates.length;) {
    let end = start,
      size = 0;
    while (end < candidates.length && end - start < 8) {
      const n = new TextEncoder().encode(
        JSON.stringify(candidates[end]),
      ).length;
      if (size + n > 18000 && end > start) break;
      size += n;
      end++;
    }
    const batch = candidates.slice(start, end);
    const questions = Object.fromEntries(
      batch.map((_, i) => [
        `k${i}`,
        {
          type: "noul",
          instructions: `candidate ${i}의 출처가 해당 인물의 이 정확한 정보 획득을 입증하는가? state.policy 규칙을 적용한다.`,
          criteria: {
            true: "본문에 직접 경험·목격, 또는 실제로 아는 발화자로부터 청취한 명시적 근거가 있다.",
            false:
              "근거 부족·추측·소문·독백·모르는 발화자의 비밀 누출·청취 불명·일부 사실만 입증되는 경우.",
          },
        },
      ]),
    );
    const body = {
      model: o.model,
      state: { policy, candidates: batch },
      questions,
    };
    if (new TextEncoder().encode(JSON.stringify(body)).length > 31000)
      throw new Error(
        "정보 검증 입력이 너무 깁니다. 근거를 더 짧게 정리해 주세요.",
      );
    const data = await responseJSON(
      "https://openrouter.ai/api/alpha/decisions",
      body,
      o,
    );
    await account(data, o, "verify");
    for (let i = 0; i < batch.length; i++) {
      const p = data.answers?.[`k${i}`]?.noul;
      if (typeof p !== "number" || p < 0 || p > 1)
        throw new Error("정보 검증 모델의 결정 형식이 올바르지 않습니다.");
      accepted.push(p >= 0.9);
    }
    start = end;
  }
  return accepted;
}
