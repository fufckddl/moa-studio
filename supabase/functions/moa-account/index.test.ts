import { equal, ok } from "node:assert";

let handle: (request: Request) => Promise<Response>;
const serve = Deno.serve;
Deno.serve = ((handler: typeof handle) => {
  handle = handler;
  return {};
}) as typeof Deno.serve;
await import("./index.ts");
Deno.serve = serve;


Deno.test("preflight allows supabase-js function invoke headers", async () => {
  await withEnvironment(async () => {
    const response = await handle(new Request("https://functions.example.test/moa-account/delete", {
      method: "OPTIONS",
      headers: {
        Origin: "https://moa.example.com",
        "Access-Control-Request-Headers": "authorization,apikey,content-type,x-client-info",
      },
    }));
    equal(response.status, 204);
    equal(response.headers.get("access-control-allow-origin"), "https://moa.example.com");
    equal(response.headers.get("access-control-allow-headers"), "authorization, apikey, content-type, x-client-info");
  });
});

Deno.test("delete account reauthenticates, deletes storage before auth user deletion, and archives payments", async () => {
  const calls: string[] = [];
  await withEnvironment(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      calls.push(`${request.method} ${url.pathname}`);

      if (url.pathname === "/auth/v1/user") {
        equal(request.headers.get("authorization"), "Bearer session-token");
        return json({ user: { id: "7d8e8e69-d6b8-4dde-9bae-163ef7501529", aud: "authenticated", email: "owner@example.test" } });
      }
      if (url.pathname === "/auth/v1/token") {
        return json({
          access_token: "fresh-token",
          refresh_token: "fresh-refresh-token",
          token_type: "bearer",
          expires_in: 3600,
          user: { id: "7d8e8e69-d6b8-4dde-9bae-163ef7501529", email: "owner@example.test" },
        });
      }
      if (url.pathname === "/rest/v1/account_lifecycle_locks") return json([{ user_id: "7d8e8e69-d6b8-4dde-9bae-163ef7501529" }], 201);
      if (url.pathname === "/rest/v1/payment_orders") return json([{ id: "moa_1234567890abcdef1234567890abcdef", user_id: "7d8e8e69-d6b8-4dde-9bae-163ef7501529", status: "PAID" }]);
      if (url.pathname === "/rest/v1/account_payment_archive") return json([], 201);
      if (url.pathname.includes("/storage/v1/object/list/moa-photos")) {
        return json(url.searchParams.get("prefix") === "7d8e8e69-d6b8-4dde-9bae-163ef7501529"
          ? [{ name: "project-one", id: null, metadata: null }]
          : [{ name: "photo.jpg", id: "photo-object", metadata: { size: 128 } }]);
      }
      if (url.pathname.includes("/storage/v1/object/list/moa-people")) {
        return json([{ name: "person.jpg", id: "person-object", metadata: { size: 128 } }]);
      }
      if (url.pathname === "/storage/v1/object/moa-photos" || url.pathname === "/storage/v1/object/moa-people") return json([]);
      if (["/rest/v1/moa_ai_requests", "/rest/v1/photo_chat_history", "/rest/v1/generated_people", "/rest/v1/workspaces"].includes(url.pathname)) return json([]);
      if (url.pathname === "/auth/v1/admin/users/7d8e8e69-d6b8-4dde-9bae-163ef7501529") return json({});
      throw new Error(`Unexpected request: ${request.method} ${url.pathname}`);
    }) as typeof fetch;

    try {
      const response = await call("/delete", { password: "strong-password", confirmation: "계정 삭제", captchaToken: "captcha-delete" });
      equal(response.status, 200);
      const photoDelete = calls.indexOf("DELETE /storage/v1/object/moa-photos");
      const peopleDelete = calls.indexOf("DELETE /storage/v1/object/moa-people");
      const authDelete = calls.indexOf("DELETE /auth/v1/admin/users/7d8e8e69-d6b8-4dde-9bae-163ef7501529");
      ok(photoDelete >= 0);
      ok(peopleDelete >= 0);
      ok(authDelete > photoDelete);
      ok(authDelete > peopleDelete);
      ok(calls.indexOf("POST /rest/v1/account_payment_archive") < authDelete);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

Deno.test("erase data rejects foreign or wrong-password reauthentication and does not delete auth user", async () => {
  const calls: string[] = [];
  await withEnvironment(async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      calls.push(`${request.method} ${url.pathname}`);
      if (url.pathname === "/auth/v1/user") return json({ user: { id: "7d8e8e69-d6b8-4dde-9bae-163ef7501529", aud: "authenticated", email: "owner@example.test" } });
      if (url.pathname === "/auth/v1/token") return json({ error: "Invalid login credentials" }, 400);
      throw new Error(`Unexpected request: ${request.method} ${url.pathname}`);
    }) as typeof fetch;

    try {
      const response = await call("/erase", { password: "wrong-password", confirmation: "작업물 삭제" });
      equal(response.status, 401);
      equal(calls.includes("DELETE /auth/v1/admin/users/7d8e8e69-d6b8-4dde-9bae-163ef7501529"), false);
      equal(calls.includes("DELETE /storage/v1/object/moa-photos"), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

function call(path: string, body: unknown) {
  return handle(new Request(`https://functions.example.test/moa-account${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer session-token",
      Origin: "https://moa.example.com",
    },
    body: JSON.stringify(body),
  }));
}

async function withEnvironment(run: () => Promise<void>) {
  const env = {
    SUPABASE_URL: "https://moa-test.supabase.co",
    SUPABASE_ANON_KEY: "anon-key",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    PUBLIC_APP_URL: "https://moa.example.com",
  };
  const original = new Map(Object.keys(env).map((key) => [key, Deno.env.get(key)]));
  for (const [key, value] of Object.entries(env)) Deno.env.set(key, value);
  try {
    await run();
  } finally {
    for (const [key, value] of original) {
      value === undefined ? Deno.env.delete(key) : Deno.env.set(key, value);
    }
  }
}

function json(value: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  }));
}
