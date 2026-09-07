// Client plan claims are never used. Supabase evaluates live paid orders with user RLS.
function unlimitedUserIds(env) {
  return new Set(String(env.PHOTO_EDIT_UNLIMITED_USER_IDS || '')
    .split(',')
    .map(id => id.trim().toLowerCase())
    .filter(Boolean));
}

export async function readVerifiedEntitlement(env, authorization, userId, fetcher = fetch) {
  if (unlimitedUserIds(env).has(String(userId || '').toLowerCase())) return { plan: 'free', unlimited: true };
  const headers = { authorization, apikey: env.SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' };
  async function current() {
    const response = await fetcher(`${env.SUPABASE_URL}/rest/v1/rpc/current_moa_ai_entitlement`, {
      method: 'POST', headers, body: JSON.stringify({ p_user_id: userId }), signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error('Membership lookup failed');
    const rows = await response.json();
    if (!Array.isArray(rows) || rows.length > 1) throw new Error('Invalid membership response');
    if (!rows.length) return { plan: 'free' };
    const row = rows[0];
    if (!['light', 'studio', 'plus'].includes(row?.plan) || typeof row.period_start !== 'string' || typeof row.period_end !== 'string') throw new Error('Invalid membership response');
    return { plan: row.plan, periodStart: row.period_start, periodEnd: row.period_end };
  }
  const entitlement = await current();
  if (entitlement.plan === 'free') return entitlement;
  // Existing payment endpoint refreshes cancellations and verifies the provider before granting paid usage.
  const membership = await fetcher(`${env.SUPABASE_URL}/functions/v1/moa-payments/membership`, { headers, signal: AbortSignal.timeout(20000) });
  if (!membership.ok) throw new Error('Paid membership verification failed');
  return current();
}
