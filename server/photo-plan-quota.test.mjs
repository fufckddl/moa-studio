import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeQuota, reserveQuota, readQuota, finishQuota, quotaPolicy, DAILY_GLOBAL_LIMIT } from '../cloudflare/photo-edit/quota.mjs';
import { readVerifiedEntitlement } from '../cloudflare/photo-edit/entitlement.mjs';
function store(legacy = false) {
  const db = new DatabaseSync(':memory:');
  const sql = { exec(query, ...args) { const s = db.prepare(query); return s.columns().length ? s.all(...args) : (s.run(...args), []); } };
  if (legacy) { sql.exec("CREATE TABLE requests (request_id TEXT PRIMARY KEY,user_id TEXT,day TEXT,status TEXT DEFAULT 'reserved')"); sql.exec("INSERT INTO requests VALUES ('old','user','2026-09-06','succeeded')"); }
  initializeQuota(sql); return sql;
}
const now = new Date('2026-09-06T12:00:00Z');
const paid = plan => ({plan,periodStart:'2026-08-20T00:00:00Z',periodEnd:'2026-09-20T00:00:00Z'});
const unlimitedUser = '238bb685-ee6d-4655-a70a-8dc6fe402e09';

test('existing free requests survive additive quota migration',()=>{
  const sql=store(true); initializeQuota(sql);
  assert.equal(readQuota(sql,'user',null,now).used,1);
  assert.equal(readQuota(sql,'user',paid('studio'),now).used,1);
});
test('paid plans enforce monthly 30/50 limits across days; upgrade counts existing usage',()=>{
  const sql=store();
  for(let n=0;n<30;n++) assert.equal(reserveQuota(sql,'studio-user',crypto.randomUUID(),now,paid('studio')).status,200);
  const later=new Date('2026-09-07T12:00:00Z');
  assert.equal(reserveQuota(sql,'studio-user',crypto.randomUUID(),later,paid('studio')).status,429);
  assert.equal(readQuota(sql,'studio-user',paid('plus'),later).remaining,20);
  for(let n=0;n<20;n++) { const date=new Date(n<40?'2026-09-07T12:00:00Z':'2026-09-08T12:00:00Z'); assert.equal(reserveQuota(sql,'studio-user',crypto.randomUUID(),date,paid('plus')).status,200); }
  assert.equal(reserveQuota(sql,'studio-user',crypto.randomUUID(),new Date('2026-09-09T12:00:00Z'),paid('plus')).status,429);
  const renewed={plan:'plus',periodStart:'2026-09-20T00:00:00Z',periodEnd:'2026-10-20T00:00:00Z'};
  assert.equal(readQuota(sql,'studio-user',renewed,new Date('2026-09-20T00:00:00Z')).remaining,50);
});
test('provider failure refunds paid quota and membership dates must be current and monthly',()=>{
  const sql=store(),id=crypto.randomUUID();
  reserveQuota(sql,'u',id,now,paid('studio')); finishQuota(sql,id,false);
  const usage=readQuota(sql,'u',paid('studio'),now);
  assert.equal(usage.remaining,30); assert.equal(usage.globalRemaining,49);
  assert.throws(()=>quotaPolicy({...paid('plus'),periodEnd:'2026-09-01T00:00:00Z'},now));
  assert.throws(()=>quotaPolicy({...paid('plus'),periodEnd:'2027-09-20T00:00:00Z'},now));
  assert.equal(DAILY_GLOBAL_LIMIT, 50);
});
test('paid membership is refreshed with payment provider and cancelled entitlement falls to free',async()=>{
  const calls=[];let reads=0;
  const fetcher=async(url,opts)=>{ calls.push({url,opts}); if(url.endsWith('/membership')) return Response.json({membership:null}); return Response.json(++reads===1?[{plan:'plus',period_start:paid('plus').periodStart,period_end:paid('plus').periodEnd}]:[]); };
  const result=await readVerifiedEntitlement({SUPABASE_URL:'https://db',SUPABASE_PUBLISHABLE_KEY:'public'},'Bearer valid','user',fetcher);
  assert.equal(result.plan,'free'); assert.equal(calls.length,3);
  assert.equal(JSON.parse(calls[0].opts.body).p_user_id,'user');
  assert.equal(calls[1].opts.headers.authorization,'Bearer valid');
});
test('failed or malformed plan lookup fails closed instead of accepting a claimed plan',async()=>{
  await assert.rejects(()=>readVerifiedEntitlement({SUPABASE_URL:'https://db'},'Bearer valid','user',async()=>new Response('fail',{status:503})));
  await assert.rejects(()=>readVerifiedEntitlement({SUPABASE_URL:'https://db'},'Bearer valid','user',async()=>Response.json({plan:'plus'})));
});

test('server allowlist grants unlimited personal quota only to verified user id',async()=>{
  const env={SUPABASE_URL:'https://db',SUPABASE_PUBLISHABLE_KEY:'public',PHOTO_EDIT_UNLIMITED_USER_IDS:` other, ${unlimitedUser.toUpperCase()} `};
  const fetcher=async()=>{ throw new Error('allowlisted user should not need membership lookup'); };
  const entitlement=await readVerifiedEntitlement(env,'Bearer valid',unlimitedUser,fetcher);
  assert.deepEqual(entitlement,{plan:'free',unlimited:true});

  const calls=[];
  const ordinary=await readVerifiedEntitlement(env,'Bearer valid','00000000-0000-4000-8000-000000000001',async(url,opts)=>{
    calls.push({url,opts});
    return Response.json([]);
  });
  assert.deepEqual(ordinary,{plan:'free'});
  assert.equal(calls.length,1);
  assert.equal(JSON.parse(calls[0].opts.body).p_user_id,'00000000-0000-4000-8000-000000000001');
});

test('client metadata or same-name claims cannot grant unlimited quota',async()=>{
  const env={
    SUPABASE_URL:'https://db',
    SUPABASE_PUBLISHABLE_KEY:'public',
    PHOTO_EDIT_UNLIMITED_USER_IDS:unlimitedUser,
    displayName:'이창렬',
    userId:unlimitedUser,
  };
  const result=await readVerifiedEntitlement(env,'Bearer valid','00000000-0000-4000-8000-000000000001',async()=>Response.json([]));
  assert.equal(result.plan,'free');
  assert.equal(result.unlimited,undefined);
});

test('unlimited user bypasses personal free limit while still consuming global quota',()=>{
  const sql=store();
  const entitlement={plan:'free',unlimited:true};
  for(let n=0;n<4;n++) {
    const result=reserveQuota(sql,unlimitedUser,crypto.randomUUID(),now,entitlement);
    assert.equal(result.status,200);
    assert.equal(result.usage.limit,null);
    assert.equal(result.usage.remaining,null);
    assert.equal(result.usage.unlimited,true);
    assert.equal(result.usage.used,n+1);
    assert.equal(result.usage.globalRemaining,DAILY_GLOBAL_LIMIT-n-1);
  }
  const usage=readQuota(sql,unlimitedUser,entitlement,now);
  assert.equal(usage.used,4);
  assert.equal(usage.remaining,null);
  assert.equal(usage.globalRemaining,DAILY_GLOBAL_LIMIT-4);
});

test('unlimited user remains blocked by shared global cap and failures keep global usage',()=>{
  const sql=store();
  const entitlement={plan:'free',unlimited:true};
  const failed=crypto.randomUUID();
  assert.equal(reserveQuota(sql,unlimitedUser,failed,now,entitlement).status,200);
  finishQuota(sql,failed,false);
  const afterFailure=readQuota(sql,unlimitedUser,entitlement,now);
  assert.equal(afterFailure.used,0);
  assert.equal(afterFailure.globalRemaining,DAILY_GLOBAL_LIMIT-1);
  for(let n=1;n<DAILY_GLOBAL_LIMIT;n++) assert.equal(reserveQuota(sql,unlimitedUser,crypto.randomUUID(),now,entitlement).status,200);
  const blocked=reserveQuota(sql,unlimitedUser,crypto.randomUUID(),now,entitlement);
  assert.equal(blocked.status,429);
  assert.equal(blocked.usage.unlimited,true);
  assert.equal(blocked.usage.limit,null);
  assert.equal(blocked.usage.remaining,null);
  assert.equal(blocked.usage.globalRemaining,0);
});

test('Durable Object exposes read-only usage and atomically consumes the verified policy',async()=>{
  const { PhotoQuota } = await import('../cloudflare/photo-edit/index.mjs');
  const sql=store(); const quota=new PhotoQuota({storage:{sql}});
  const entitlement={plan:'studio',periodStart:new Date(Date.now()-86400000).toISOString(),periodEnd:new Date(Date.now()+29*86400000).toISOString()};
  const post=path=>new Request(`https://quota/${path}`,{method:'POST',body:JSON.stringify({userId:'user',requestId:crypto.randomUUID(),entitlement})});
  const first=await (await quota.fetch(post('usage'))).json();
  assert.equal(first.limit,30); assert.equal(first.used,0);
  const reserved=await (await quota.fetch(post('reserve'))).json();
  assert.equal(reserved.usage.remaining,29);
  const next=await (await quota.fetch(post('usage'))).json();
  assert.equal(next.used,1);
});


test('light plan allows ten monthly requests and then requires renewal', () => {
  const sql = store();
  for (let n=0;n<10;n++) assert.equal(reserveQuota(sql,'light-user',crypto.randomUUID(),now,paid('light')).status,200);
  assert.equal(reserveQuota(sql,'light-user',crypto.randomUUID(),now,paid('light')).status,429);
  assert.equal(readQuota(sql,'light-user',paid('studio'),now).remaining,20);
});

test('one-time trial cannot reset across days or the former cleanup window', () => {
  const sql = store();
  for (let n=0;n<3;n++) {
    const id=crypto.randomUUID();
    assert.equal(reserveQuota(sql,'trial-user',id,now).status,200);
    finishQuota(sql,id,true);
  }
  for (const date of ['2026-09-07T12:00:00Z','2027-01-01T12:00:00Z']) {
    const result=reserveQuota(sql,'trial-user',crypto.randomUUID(),new Date(date));
    assert.equal(result.status,429);
    assert.equal(result.usage.period,'lifetime');
    assert.equal(result.usage.used,3);
    assert.match(result.error,/무료 체험 3회/);
  }
});
