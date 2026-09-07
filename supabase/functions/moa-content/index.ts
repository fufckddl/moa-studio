import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";
import {
  assertContentPackShape,
  buildProviderInput,
  type ContentPack,
  contentPackJsonSchema,
  type GenerateRequest,
  makeTemplatePack,
  MoaInputError,
  parseGeneratePayload,
} from "../../../shared/moa_ai.ts";

const MAX_BODY_BYTES = 12 * 1024 * 1024;
const LOCAL_ORIGINS = new Set([
  "http://127.0.0.1:5173",
  "http://localhost:5173",
  "http://127.0.0.1:4173",
  "http://localhost:4173",
]);
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEFAULT_OPENAI_MODEL = "gpt-5.6-luna";
const OPENAI_TIMEOUT_MS = 25_000;
const PLAN_LIMITS = { free: 0, light: 10, studio: 30, plus: 100 } as const;
const BRAND_LIMITS = { free: 1, light: 3, studio: 3, plus: 3 } as const;

type Plan = keyof typeof PLAN_LIMITS;
type User = { id: string; email?: string };
type Entitlement = {
  plan: Plan;
  aiLimit: number;
  aiUsed: number;
  aiRemaining: number;
  brandLimit: 1 | 3;
  periodStart: string | null;
  periodEnd: string | null;
  configured: boolean;
};
type ProviderConfig = { configured: true; provider: "openai"; mode: "live" } | {
  configured: false;
  provider: "openai";
  mode: "template";
};
type ProviderStatus = ProviderConfig & {
  imageEditingConfigured: false;
  imageEditingReason: "image_editing_provider_unavailable";
};
type PhotoEditMessage = {
  role: "user" | "assistant";
  content: string;
};
type PhotoEditRequest = {
  photo: {
    id: string;
    name: string;
    dataUrl: string;
  };
  prompt: string;
  messages: PhotoEditMessage[];
  requestId: string;
};
type Reservation = {
  request_id: string;
  status: "reserved" | "succeeded" | "failed";
  response: ContentPack | null;
  plan: Plan;
  period_start: string;
  period_end: string;
};
type EntitlementRow = {
  plan?: unknown;
  period_start?: unknown;
  period_end?: unknown;
};
type OpenAIResponsesPayload = {
  output_text?: unknown;
  output?: unknown;
};

Deno.serve(handleRequest);

export async function handleRequest(request: Request): Promise<Response> {
  try {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }
    const path = normalizePath(new URL(request.url).pathname);

    if (request.method === "GET" && path === "/status") {
      return json(request, 200, readProviderStatus());
    }

    if (request.method === "GET" && path === "/entitlements") {
      const user = await requireUser(request);
      return json(request, 200, await getEntitlements(user.id));
    }

    if (request.method === "POST" && path === "/generate") {
      const user = await requireUser(request);
      const payload = parseGeneratePayload(await readJsonBody(request));
      const providerConfig = readProviderConfig();
      if (!providerConfig.configured) {
        return json(request, 200, makeTemplatePack(payload));
      }

      const reservation = await reserveUsage(user.id, payload.requestId);
      if (reservation.status === "succeeded" && reservation.response) {
        return json(request, 200, reservation.response);
      }
      if (reservation.status === "reserved" && reservation.response) {
        return json(request, 200, reservation.response);
      }

      try {
        const pack = await generateWithConfiguredProvider(
          payload,
          providerConfig,
        );
        await markUsageSucceeded(user.id, payload.requestId, pack);
        return json(request, 200, pack);
      } catch (error) {
        await markUsageFailed(user.id, payload.requestId);
        throw error;
      }
    }

    if (request.method === "POST" && path === "/edit") {
      await requireUser(request);
      parsePhotoEditPayload(await readJsonBody(request));
      return json(request, 503, {
        error: "사진 편집 공급자가 아직 연결되지 않았습니다.",
        configured: false,
        reason: "image_editing_provider_unavailable",
      });
    }

    return json(request, 404, { error: "요청한 경로를 찾을 수 없습니다." });
  } catch (error) {
    const status = error instanceof HttpError
      ? error.status
      : error instanceof MoaInputError
      ? error.statusCode
      : 500;
    const message = status === 500
      ? "서버 오류가 발생했습니다."
      : error instanceof Error
      ? error.message
      : "요청을 처리하지 못했습니다.";
    return json(request, status, { error: message });
  }
}

async function requireUser(request: Request): Promise<User> {
  const authorization = request.headers.get("Authorization") ?? "";
  const token = authorization.replace(/^Bearer\s+/i, "").trim();
  if (!token) throw httpError(401, "로그인이 필요합니다.");
  const { data, error } = await userClient(authorization).auth.getUser(token);
  if (error || !data.user) throw httpError(401, "로그인이 필요합니다.");
  return { id: data.user.id, email: data.user.email ?? undefined };
}

async function getEntitlements(userId: string): Promise<Entitlement> {
  const configured = readProviderConfig().configured;
  const active = await getActivePlan(userId);
  if (!active) {
    return {
      plan: "free",
      aiLimit: PLAN_LIMITS.free,
      aiUsed: 0,
      aiRemaining: 0,
      brandLimit: BRAND_LIMITS.free,
      periodStart: null,
      periodEnd: null,
      configured,
    };
  }

  const { count, error } = await admin()
    .from("moa_ai_requests")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .in("status", ["reserved", "succeeded"])
    .eq("period_start", active.periodStart)
    .eq("period_end", active.periodEnd);
  if (error) throw httpError(500, "AI 사용량을 확인하지 못했습니다.");

  const aiLimit = PLAN_LIMITS[active.plan];
  const aiUsed = count ?? 0;
  return {
    plan: active.plan,
    aiLimit,
    aiUsed,
    aiRemaining: Math.max(0, aiLimit - aiUsed),
    brandLimit: BRAND_LIMITS[active.plan],
    periodStart: active.periodStart,
    periodEnd: active.periodEnd,
    configured,
  };
}

async function getActivePlan(
  userId: string,
): Promise<
  { plan: Exclude<Plan, "free">; periodStart: string; periodEnd: string } | null
> {
  const { data, error } = await admin().rpc("current_moa_ai_entitlement", {
    p_user_id: userId,
  }).maybeSingle();
  if (error) throw httpError(500, "멤버십 정보를 확인하지 못했습니다.");
  const row = data as EntitlementRow | null;
  if (
    !row ||
    (row.plan !== "light" && row.plan !== "studio" && row.plan !== "plus")
  ) {
    return null;
  }
  if (
    typeof row.period_start !== "string" || typeof row.period_end !== "string"
  ) {
    throw httpError(500, "멤버십 기간 정보가 올바르지 않습니다.");
  }
  return {
    plan: row.plan,
    periodStart: new Date(row.period_start).toISOString(),
    periodEnd: new Date(row.period_end).toISOString(),
  };
}

async function reserveUsage(
  userId: string,
  requestId: string,
): Promise<Reservation> {
  const { data, error } = await admin().rpc("reserve_moa_ai_request", {
    p_user_id: userId,
    p_request_id: requestId,
  });
  if (error) throw rpcError(error.message);
  return data as Reservation;
}

async function markUsageSucceeded(
  userId: string,
  requestId: string,
  pack: ContentPack,
) {
  const { error } = await admin().rpc("succeed_moa_ai_request", {
    p_user_id: userId,
    p_request_id: requestId,
    p_response: pack,
  });
  if (error) throw httpError(500, "AI 사용량 확정에 실패했습니다.");
}

async function markUsageFailed(userId: string, requestId: string) {
  await admin().rpc("fail_moa_ai_request", {
    p_user_id: userId,
    p_request_id: requestId,
  });
}

async function generateWithConfiguredProvider(
  payload: GenerateRequest,
  config: { provider: "openai"; mode: "live" },
): Promise<ContentPack> {
  if (config.provider !== "openai" || config.mode !== "live") {
    throw httpError(503, "AI 생성 공급자가 아직 연결되지 않았습니다.");
  }
  const response = await callOpenAIResponses(payload);
  const text = extractOpenAIOutputText(response);
  const pack = parseOpenAIContentPack(text);
  assertContentPackShape(pack);
  assertSchedulePolicy(pack, payload.brief.includeSchedule);
  return pack;
}

function readProviderConfig(): ProviderConfig {
  const provider = (Deno.env.get("MOA_AI_PROVIDER") ?? "").trim().toLowerCase();
  const key = (Deno.env.get("OPENAI_API_KEY") ?? "").trim();
  if (provider === "openai" && key) {
    return { configured: true, provider: "openai", mode: "live" };
  }
  return { configured: false, provider: "openai", mode: "template" };
}

function readProviderStatus(): ProviderStatus {
  return {
    ...readProviderConfig(),
    imageEditingConfigured: false,
    imageEditingReason: "image_editing_provider_unavailable",
  };
}

async function callOpenAIResponses(
  payload: GenerateRequest,
): Promise<OpenAIResponsesPayload> {
  const providerInput = buildProviderInput(payload);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);
  try {
    const response = await fetch(OPENAI_RESPONSES_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${requiredEnv("OPENAI_API_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: readOpenAIModel(),
        input: [{
          role: "user",
          content: [
            {
              type: "input_text",
              text: [
                providerInput.system.join("\n"),
                "Create exactly three card objects.",
                payload.brief.includeSchedule
                  ? "Create exactly three schedule items. Use YYYY-MM-DD dates when scheduleStartDate is present."
                  : "Return schedule as an empty array because scheduling was not requested.",
                JSON.stringify({
                  brand: providerInput.brand,
                  brief: providerInput.brief,
                  images: providerInput.images.map((image) => ({
                    id: image.id,
                    name: image.name,
                  })),
                }),
              ].join("\n"),
            },
            ...providerInput.images.map((image) => ({
              type: "input_image",
              image_url: image.dataUrl,
              detail: "auto",
            })),
          ],
        }],
        text: {
          format: {
            type: "json_schema",
            name: "moa_content_pack",
            strict: true,
            schema: contentPackJsonSchema,
          },
        },
      }),
    });
    if (!response.ok) {
      throw httpError(502, "OpenAI 생성 요청이 실패했습니다.");
    }
    return await response.json() as OpenAIResponsesPayload;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw httpError(504, "OpenAI 생성 응답 시간이 초과되었습니다.");
    }
    if (error instanceof HttpError || error instanceof MoaInputError) {
      throw error;
    }
    throw httpError(502, "OpenAI 생성 응답을 처리하지 못했습니다.");
  } finally {
    clearTimeout(timeout);
  }
}

function readOpenAIModel() {
  return (Deno.env.get("MOA_AI_MODEL") ?? "").trim() || DEFAULT_OPENAI_MODEL;
}

function extractOpenAIOutputText(payload: OpenAIResponsesPayload) {
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text;
  }
  const chunks: string[] = [];
  if (Array.isArray(payload.output)) {
    for (const item of payload.output) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const content = (item as Record<string, unknown>).content;
      if (!Array.isArray(content)) continue;
      for (const entry of content) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          continue;
        }
        const text = (entry as Record<string, unknown>).text;
        if (typeof text === "string") chunks.push(text);
      }
    }
  }
  if (!chunks.length) throw httpError(502, "OpenAI 응답에 콘텐츠가 없습니다.");
  return chunks.join("\n");
}

function parseOpenAIContentPack(text: string): ContentPack {
  try {
    return JSON.parse(text) as ContentPack;
  } catch {
    throw httpError(502, "OpenAI가 올바른 JSON 콘텐츠를 반환하지 않았습니다.");
  }
}

function assertSchedulePolicy(pack: ContentPack, includeSchedule: boolean) {
  const expected = includeSchedule ? 3 : 0;
  if (pack.schedule.length !== expected) {
    throw httpError(
      502,
      includeSchedule
        ? "AI 일정은 정확히 3개여야 합니다."
        : "AI 일정은 요청하지 않았을 때 비어 있어야 합니다.",
    );
  }
}

function parsePhotoEditPayload(payload: unknown): PhotoEditRequest {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw httpError(400, "요청 데이터가 올바르지 않습니다.");
  }
  const value = payload as Record<string, unknown>;
  const requestId = optionalText(value.requestId, 80).toLowerCase();
  if (!UUID_RE.test(requestId)) {
    throw httpError(400, "requestId는 UUID여야 합니다.");
  }

  const photo = value.photo;
  if (!photo || typeof photo !== "object" || Array.isArray(photo)) {
    throw httpError(400, "편집할 사진을 선택해 주세요.");
  }
  const parsedPhoto = parsePhotoEditImage(photo as Record<string, unknown>);
  const prompt = requiredText(value.prompt, "편집 요청", 2000);
  const messages = parsePhotoEditMessages(value.messages);

  return { photo: parsedPhoto, prompt, messages, requestId };
}

function parsePhotoEditImage(photo: Record<string, unknown>) {
  const dataUrl = typeof photo.dataUrl === "string" ? photo.dataUrl.trim() : "";
  if (!DATA_URL_RE.test(dataUrl)) {
    throw httpError(
      400,
      "사진은 PNG, JPG, WEBP data URL만 사용할 수 있습니다.",
    );
  }
  if (byteLength(dataUrl) > 8 * 1024 * 1024) {
    throw httpError(413, "사진 data URL은 8MB 이하여야 합니다.");
  }
  return {
    id: optionalText(photo.id, 80) || "photo",
    name: optionalText(photo.name, 160) || "photo",
    dataUrl,
  };
}

function parsePhotoEditMessages(value: unknown): PhotoEditMessage[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw httpError(400, "대화 기록이 올바르지 않습니다.");
  }
  if (value.length > 20) {
    throw httpError(400, "대화 기록은 최대 20개까지 사용할 수 있습니다.");
  }

  return value.map((message) => {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      throw httpError(400, "대화 메시지가 올바르지 않습니다.");
    }
    const entry = message as Record<string, unknown>;
    const role = entry.role;
    if (role !== "user" && role !== "assistant") {
      throw httpError(400, "대화 메시지 역할이 올바르지 않습니다.");
    }
    return {
      role,
      content: requiredText(entry.content, "대화 메시지", 2000),
    };
  });
}

async function readJsonBody(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw httpError(415, "Content-Type은 application/json이어야 합니다.");
  }
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {
    throw httpError(413, "요청 본문은 12MB 이하여야 합니다.");
  }
  try {
    return JSON.parse(body || "{}") as unknown;
  } catch {
    throw httpError(400, "JSON 형식이 올바르지 않습니다.");
  }
}

function rpcError(message: string) {
  if (message.includes("moa_ai_no_entitlement")) {
    return httpError(402, "유료 플랜에서 사용할 수 있는 AI 생성 기능입니다.");
  }
  if (message.includes("moa_ai_quota_exceeded")) {
    return httpError(429, "이번 달 AI 생성 한도를 모두 사용했습니다.");
  }
  if (message.includes("moa_ai_rate_limited")) {
    return httpError(429, "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.");
  }
  if (message.includes("moa_ai_request_in_progress")) {
    return httpError(409, "같은 requestId 요청이 처리 중입니다.");
  }
  return httpError(500, "AI 사용량 예약에 실패했습니다.");
}

function normalizePath(pathname: string) {
  const marker = "/moa-content";
  const index = pathname.indexOf(marker);
  const path = index >= 0 ? pathname.slice(index + marker.length) : pathname;
  return path || "/";
}

function admin() {
  return createClient(requiredEnv("SUPABASE_URL"), secretKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function userClient(authorization: string) {
  return createClient(requiredEnv("SUPABASE_URL"), publishableKey(), {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function publishableKey() {
  const modern = readJsonKey("SUPABASE_PUBLISHABLE_KEYS");
  return modern || requiredEnv("SUPABASE_ANON_KEY");
}

function secretKey() {
  const modern = readJsonKey("SUPABASE_SECRET_KEYS");
  return modern || requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
}

function readJsonKey(name: string) {
  const value = Deno.env.get(name);
  if (!value) return "";
  try {
    const parsed = JSON.parse(value) as Record<string, string>;
    return parsed.default ?? Object.values(parsed)[0] ?? "";
  } catch {
    return "";
  }
}

function requiredEnv(name: string) {
  const value = Deno.env.get(name);
  if (!value) throw httpError(500, `${name} 환경변수가 필요합니다.`);
  return value;
}

function corsHeaders(request: Request) {
  const origin = request.headers.get("Origin") ?? "*";
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type",
    "Cache-Control": "no-store",
    Vary: "Origin",
  };
  if (origin === "*") {
    headers["Access-Control-Allow-Origin"] = "*";
  } else if (allowedCorsOrigins().has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function allowedCorsOrigins() {
  const origins = new Set<string>();
  const appUrl = normalizeUrl(Deno.env.get("PUBLIC_APP_URL"));
  if (appUrl) origins.add(new URL(appUrl).origin);
  for (const origin of LOCAL_ORIGINS) origins.add(origin);
  return origins;
}

function normalizeUrl(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    return new URL(value.trim()).toString();
  } catch {
    return "";
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATA_URL_RE = /^data:image\/(png|jpe?g|webp);base64,/i;

function requiredText(value: unknown, label: string, maxLength: number) {
  const text = optionalText(value, maxLength);
  if (!text) throw httpError(400, `${label}을 입력해 주세요.`);
  return text;
}

function optionalText(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function byteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

function json(request: Request, status: number, payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders(request),
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function httpError(status: number, message: string) {
  return new HttpError(status, message);
}

class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}
