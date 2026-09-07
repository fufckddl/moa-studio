import { createClient, type SupabaseClient } from '@supabase/supabase-js';

declare global {
  interface ImportMeta {
    readonly env: Record<string, string | undefined>;
  }
}

const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};

export const supabaseUrl = env.VITE_SUPABASE_URL?.trim() ?? '';
export const supabasePublishableKey = env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim() ?? '';
export const isCloudConfigured = Boolean(supabaseUrl && supabasePublishableKey);

let client: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
  if (!isCloudConfigured) {
    throw new Error('Supabase 연결 정보가 아직 설정되지 않았어요.');
  }

  client ??= createClient(supabaseUrl, supabasePublishableKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });

  return client;
}

export async function getAccessToken(): Promise<string | null> {
  if (!isCloudConfigured) return null;
  const { data, error } = await getSupabaseClient().auth.getSession();
  if (error) throw new Error(error.message);
  return data.session?.access_token ?? null;
}
