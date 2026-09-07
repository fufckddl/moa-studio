import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";

const LOCAL_ORIGINS = new Set([
  "http://127.0.0.1:5173",
  "http://localhost:5173",
  "http://127.0.0.1:4173",
  "http://localhost:4173",
]);
const BUCKETS = ["moa-photos", "moa-people"] as const;
const ERASE_CONFIRMATION = "작업물 삭제";
const DELETE_CONFIRMATION = "계정 삭제";

type User = { id: string; email?: string };
type AccountAction = "erase-data" | "delete-account";
type StorageItem = { id?: string | null; name?: string; metadata?: unknown };

Deno.serve(handleRequest);

export async function handleRequest(request: Request): Promise<Response> {
  try {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }
    const path = normalizePath(new URL(request.url).pathname);
    if (request.method !== "POST") {
      return json(request, 405, { error: "허용되지 않는 요청입니다." });
    }
    if (path !== "/erase" && path !== "/delete") {
      return json(request, 404, { error: "요청한 경로를 찾을 수 없습니다." });
    }

    const user = await requireUser(request);
    const payload = await readJsonBody(request);
    const password = requiredText(payload.password, "비밀번호", 128);
    const confirmation = requiredText(payload.confirmation, "확인 문구", 30);
    const action: AccountAction = path === "/erase" ? "erase-data" : "delete-account";
    const expected = action === "erase-data" ? ERASE_CONFIRMATION : DELETE_CONFIRMATION;
    if (confirmation !== expected) {
      throw httpError(400, `확인 문구로 "${expected}"를 입력해 주세요.`);
    }

    const captchaToken = typeof payload.captchaToken === "string" ? payload.captchaToken : undefined;
    await reauthenticate(user, password, captchaToken);
    await runAccountLifecycle(user, action);
    return json(request, 200, { ok: true });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message = status === 500
      ? "계정 요청을 처리하지 못했습니다."
      : error instanceof Error
      ? error.message
      : "계정 요청을 처리하지 못했습니다.";
    return json(request, status, { error: message });
  }
}

async function runAccountLifecycle(user: User, action: AccountAction): Promise<void> {
  await createLifecycleLock(user.id, action);
  try {
    if (action === "delete-account") await archivePaymentOrders(user.id);
    await deleteStorageObjects(user.id);
    await eraseUserRows(user.id);
    if (action === "delete-account") {
      const { error } = await admin().auth.admin.deleteUser(user.id, false);
      if (error) throw httpError(500, "계정을 삭제하지 못했습니다.");
    }
  } catch (error) {
    if (action === "erase-data") await releaseLifecycleLock(user.id);
    throw error;
  }
  if (action === "erase-data") await releaseLifecycleLock(user.id);
}

async function requireUser(request: Request): Promise<User> {
  const authorization = request.headers.get("Authorization") ?? "";
  const token = authorization.replace(/^Bearer\s+/i, "").trim();
  if (!token) throw httpError(401, "로그인이 필요합니다.");
  const { data, error } = await userClient(authorization).auth.getUser(token);
  if (error || !data.user) throw httpError(401, "로그인이 필요합니다.");
  return { id: data.user.id, email: data.user.email ?? undefined };
}

async function reauthenticate(user: User, password: string, captchaToken?: string): Promise<void> {
  if (!user.email) throw httpError(400, "비밀번호 계정만 이 화면에서 삭제할 수 있습니다.");
  const auth = publicAuth();
  const { data, error } = await auth.auth.signInWithPassword({
    email: user.email,
    password,
    options: { captchaToken },
  });
  if (error || data.user?.id !== user.id) {
    throw httpError(401, "비밀번호를 다시 확인해 주세요.");
  }
  await auth.auth.signOut({ scope: "local" }).catch(() => undefined);
}

async function createLifecycleLock(userId: string, action: AccountAction): Promise<void> {
  const { error } = await admin()
    .from("account_lifecycle_locks")
    .insert({ user_id: userId, action });
  if (!error) return;
  if (isDuplicateError(error)) {
    throw httpError(409, "이미 계정 삭제 요청이 처리 중입니다.");
  }
  throw httpError(500, "계정 삭제 준비를 시작하지 못했습니다.");
}

async function releaseLifecycleLock(userId: string): Promise<void> {
  await admin().from("account_lifecycle_locks").delete().eq("user_id", userId);
}

async function archivePaymentOrders(userId: string): Promise<void> {
  const { data, error } = await admin()
    .from("payment_orders")
    .select("*")
    .eq("user_id", userId);
  if (error) throw httpError(500, "결제 기록을 확인하지 못했습니다.");
  if (!data || data.length === 0) return;

  const rows = data.map((order) => ({
    source_user_id: userId,
    payment_order_id: String((order as Record<string, unknown>).id),
    order_snapshot: order,
  }));
  const { error: archiveError } = await admin()
    .from("account_payment_archive")
    .upsert(rows, { onConflict: "payment_order_id" });
  if (archiveError) throw httpError(500, "결제 기록을 보관하지 못했습니다.");
}

async function deleteStorageObjects(userId: string): Promise<void> {
  for (const bucket of BUCKETS) {
    const paths = await listBucketPaths(bucket, userId);
    for (let index = 0; index < paths.length; index += 100) {
      const chunk = paths.slice(index, index + 100);
      if (chunk.length === 0) continue;
      const { error } = await admin().storage.from(bucket).remove(chunk);
      if (error) throw httpError(500, "계정 사진 파일을 삭제하지 못했습니다.");
    }
  }
}

async function listBucketPaths(bucket: typeof BUCKETS[number], prefix: string): Promise<string[]> {
  const paths: string[] = [];
  await collectBucketPaths(bucket, prefix, paths);
  return paths;
}

async function collectBucketPaths(bucket: typeof BUCKETS[number], prefix: string, paths: string[]): Promise<void> {
  let offset = 0;
  while (true) {
    const { data, error } = await admin().storage.from(bucket).list(prefix, {
      limit: 1000,
      offset,
      sortBy: { column: "name", order: "asc" },
    });
    if (error) throw httpError(500, "계정 사진 목록을 확인하지 못했습니다.");
    const items = (data ?? []) as StorageItem[];
    for (const item of items) {
      if (!item.name) continue;
      const path = `${prefix}/${item.name}`;
      if (item.id || item.metadata) {
        paths.push(path);
      } else {
        await collectBucketPaths(bucket, path, paths);
      }
    }
    if (items.length < 1000) break;
    offset += items.length;
  }
}

async function eraseUserRows(userId: string): Promise<void> {
  const tables = ["moa_ai_requests", "photo_chat_history", "generated_people", "workspaces"];
  for (const table of tables) {
    const { error } = await admin().from(table).delete().eq("user_id", userId);
    if (error) throw httpError(500, "계정 데이터를 삭제하지 못했습니다.");
  }
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw httpError(415, "Content-Type은 application/json이어야 합니다.");
  }
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > 4096) {
    throw httpError(413, "요청 본문은 4KB 이하여야 합니다.");
  }
  try {
    const payload = JSON.parse(body || "{}") as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("invalid payload");
    }
    return payload as Record<string, unknown>;
  } catch {
    throw httpError(400, "JSON 형식이 올바르지 않습니다.");
  }
}

function requiredText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw httpError(400, `${label}을 입력해 주세요.`);
  }
  return value;
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

function publicAuth() {
  return createClient(requiredEnv("SUPABASE_URL"), publishableKey(), {
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

function isDuplicateError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as Record<string, unknown>;
  return value.code === "23505" ||
    (typeof value.message === "string" && /duplicate|already exists/i.test(value.message));
}

function normalizePath(pathname: string) {
  const marker = "/moa-account";
  const index = pathname.indexOf(marker);
  const path = index >= 0 ? pathname.slice(index + marker.length) : pathname;
  return path || "/";
}

function corsHeaders(request: Request) {
  const origin = request.headers.get("Origin") ?? "*";
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
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
