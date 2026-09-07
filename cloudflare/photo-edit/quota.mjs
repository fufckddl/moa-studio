export const FREE_TRIAL_LIMIT = 3;
export const PLAN_CHAT_LIMITS = { free: 3, light: 10, studio: 30, plus: 50 };
// Shared request cap for paid OpenAI image edits, including uncertain failures.
// This is a request count limit, not a fixed dollar budget or provider free allowance.
// Reassess expected input/output costs before raising this cap.
export const DAILY_GLOBAL_LIMIT = 50;

export function initializeQuota(sql) {
  sql.exec(`CREATE TABLE IF NOT EXISTS requests (
    request_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, day TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'reserved', created_at TEXT
  )`);
  // Existing free quota reservations survive this additive migration.
  if (![...sql.exec('PRAGMA table_info(requests)')].some(column => column.name === 'created_at')) {
    sql.exec('ALTER TABLE requests ADD COLUMN created_at TEXT');
  }
  sql.exec("UPDATE requests SET created_at = day || 'T00:00:00.000Z' WHERE created_at IS NULL");
  sql.exec('CREATE INDEX IF NOT EXISTS requests_day_user ON requests(day, user_id)');
  sql.exec('CREATE INDEX IF NOT EXISTS requests_user_created ON requests(user_id, created_at)');
}

export function quotaPolicy(entitlement, now = new Date()) {
  const time = now.getTime();
  const day = now.toISOString().slice(0, 10);
  if (entitlement?.unlimited === true) return {
    plan: entitlement.plan || 'free', unlimited: true, limit: null, period: 'day',
    periodStart: `${day}T00:00:00.000Z`, periodEnd: new Date(Date.parse(`${day}T00:00:00.000Z`) + 86400000).toISOString(),
  };
  if (!entitlement || entitlement.plan === 'free') return {
    plan: 'free', limit: PLAN_CHAT_LIMITS.free, period: 'lifetime',
    periodStart: '1970-01-01T00:00:00.000Z', periodEnd: '9999-12-31T00:00:00.000Z',
  };
  const start = Date.parse(entitlement.periodStart), end = Date.parse(entitlement.periodEnd);
  if (!['light', 'studio', 'plus'].includes(entitlement.plan) || !Number.isFinite(start) || !Number.isFinite(end) || start > time || end <= time || end - start > 32 * 86400000) {
    throw new Error('Invalid verified membership period');
  }
  return { plan: entitlement.plan, limit: PLAN_CHAT_LIMITS[entitlement.plan], period: 'month', periodStart: new Date(start).toISOString(), periodEnd: new Date(end).toISOString() };
}

export function readQuota(sql, userId, entitlement, now = new Date()) {
  const policy = quotaPolicy(entitlement, now);
  const [{ used }] = [...sql.exec("SELECT COUNT(*) AS used FROM requests WHERE user_id = ? AND created_at >= ? AND created_at < ? AND status != 'failed'", userId, policy.periodStart, policy.periodEnd)];
  const [{ total }] = [...sql.exec('SELECT COUNT(*) AS total FROM requests WHERE day = ?', now.toISOString().slice(0, 10))];
  return { configured: true, ...policy, used, remaining: policy.unlimited ? null : Math.max(0, policy.limit - used), globalRemaining: Math.max(0, DAILY_GLOBAL_LIMIT - total) };
}

// One Durable Object, synchronous checks + insert, no await: concurrent calls cannot overspend.
export function reserveQuota(sql, userId, requestId, now = new Date(), entitlement = null) {
  const day = now.toISOString().slice(0, 10);
  // Retain usage history so the one-time free trial cannot renew after cleanup.
  if ([...sql.exec('SELECT request_id FROM requests WHERE request_id = ?', requestId)].length) {
    return { status: 409, error: '이미 처리한 요청이에요. 결과를 확인한 뒤 새 요청을 보내 주세요.' };
  }
  const usage = readQuota(sql, userId, entitlement, now);
  if (!usage.globalRemaining) return { status: 429, usage, error: '오늘의 서비스 AI 제공량을 모두 사용했어요. 한국 시간 오전 9시 이후 다시 이용해 주세요.' };
  if (!usage.unlimited && !usage.remaining) {
    const message = usage.plan === 'free' ? '무료 체험 3회를 모두 사용했어요. 계속 수정하려면 유료 플랜을 선택해 주세요.' : `이번 이용 기간의 AI 사진 채팅 ${usage.limit}회를 모두 사용했어요. ${new Date(usage.periodEnd).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' })}에 한도가 갱신됩니다.`;
    return { status: 429, usage, error: message };
  }
  sql.exec('INSERT INTO requests (request_id, user_id, day, created_at) VALUES (?, ?, ?, ?)', requestId, userId, day, now.toISOString());
  return { status: 200, usage: { ...usage, used: usage.used + 1, remaining: usage.unlimited ? null : usage.remaining - 1, globalRemaining: usage.globalRemaining - 1 } };
}

export function finishQuota(sql, requestId, succeeded) {
  // Provider failures refund user quota, but still consume the global budget.
  sql.exec("UPDATE requests SET status = ? WHERE request_id = ? AND status = 'reserved'", succeeded ? 'succeeded' : 'failed', requestId);
}
