import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuthService } from './auth.mjs';
import { createApiServer } from './index.mjs';

const ORIGIN = 'http://127.0.0.1:5173';
const TEST_SCRYPT = { N: 1024, r: 8, p: 1, maxmem: 4 * 1024 * 1024 };

test('generation requires a real session before accepting input', async (t) => {
  const app = await startServer(t);
  const client = new Client(app.base);
  for (const userId of [undefined, 'forged-user']) {
    const result = await client.request('/api/generate', { method: 'POST', body: {}, userId });
    assert.equal(result.status, 401);
    assert.match(result.body.error, /로그인/);
  }
  await client.request('/api/auth/signup', {
    method: 'POST', body: { name: '검증 사용자', email: 'generate@example.test', password: 'strong-password' },
  });
  const signedIn = await client.request('/api/generate', { method: 'POST', body: {} });
  assert.equal(signedIn.status, 400, 'signed-in request reaches input validation without a provider call');
});

test('signup, session, logout, and user-scoped workspaces work over HTTP', async (t) => {
  const app = await startServer(t);
  const first = new Client(app.base);
  const second = new Client(app.base);

  const signup = await first.request('/api/auth/signup', {
    method: 'POST',
    body: { name: '모아 운영자', email: 'owner@example.test', password: 'strong-password' },
  });
  assert.equal(signup.status, 201);
  assert.equal(signup.body.user.email, 'owner@example.test');
  assert.match(first.cookie, /moa_session=/);
  assert.match(signup.headers.get('set-cookie'), /HttpOnly/);
  assert.match(signup.headers.get('set-cookie'), /SameSite=Lax/);
  assert.equal(signup.headers.get('cache-control'), 'no-store');

  const storedSession = app.auth.db.prepare('SELECT token_hash FROM sessions').get();
  assert.match(storedSession.token_hash, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(first.cookie, new RegExp(storedSession.token_hash));

  const session = await first.request('/api/auth/session');
  assert.equal(session.status, 200);
  assert.equal(session.body.user.id, signup.body.user.id);

  const workspace = sampleWorkspace();
  const saved = await first.request('/api/workspace', {
    method: 'PUT',
    userId: signup.body.user.id,
    body: workspace,
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.brand, workspace.brand);
  assert.equal(saved.body.projects[0].photos[0].dataUrl, '/assets/cafe-latte.png');

  await second.request('/api/auth/signup', {
    method: 'POST',
    body: { name: '두 번째 운영자', email: 'second@example.test', password: 'strong-password' },
  });
  const emptyWorkspace = await second.request('/api/workspace');
  assert.equal(emptyWorkspace.status, 200);
  assert.deepEqual(emptyWorkspace.body, { brand: null, projects: [] });

  const loaded = await first.request('/api/workspace');
  assert.equal(loaded.status, 200);
  assert.equal(loaded.body.projects[0].id, 'project-one');

  const staleSave = await first.request('/api/workspace', {
    method: 'PUT',
    userId: 'usr_stale_tab',
    body: workspace,
  });
  assert.equal(staleSave.status, 409);

  const logout = await first.request('/api/auth/logout', { method: 'POST', body: {} });
  assert.equal(logout.status, 200);
  const afterLogout = await first.request('/api/auth/session');
  assert.equal(afterLogout.body.user, null);
});

test('auth rejects unsafe request shapes and rate limits repeated login failures', async (t) => {
  const app = await startServer(t);
  const client = new Client(app.base);

  const noJson = await fetch(`${app.base}/api/auth/signup`, { method: 'POST', headers: { Origin: ORIGIN }, body: '{}' });
  assert.equal(noJson.status, 415);

  const wrongOrigin = await fetch(`${app.base}/api/auth/signup`, {
    method: 'POST',
    headers: { Origin: 'http://example.invalid', 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '차단', email: 'blocked@example.test', password: 'strong-password' }),
  });
  assert.equal(wrongOrigin.status, 403);

  await client.request('/api/auth/signup', {
    method: 'POST',
    body: { name: '레이트 운영자', email: 'rate@example.test', password: 'strong-password' },
  });
  await client.request('/api/auth/logout', { method: 'POST', body: {} });

  let lastStatus = 0;
  for (let index = 0; index < 6; index += 1) {
    const response = await client.request('/api/auth/login', {
      method: 'POST',
      body: { email: 'rate@example.test', password: 'wrong-password' },
    });
    lastStatus = response.status;
  }
  assert.equal(lastStatus, 429);
});

test('workspace brand profiles round-trip, delete, reload, and stay user-scoped', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'moa-auth-brand-profiles-'));
  const dbPath = join(dir, 'test.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  let app = await startServerAtPath(t, dbPath);
  const first = new Client(app.base);
  const second = new Client(app.base);
  const signup = await first.request('/api/auth/signup', {
    method: 'POST',
    body: { name: '브랜드 운영자', email: 'brands@example.test', password: 'strong-password' },
  });
  insertLivePaidOrder(app.auth.db, { userId: signup.body.user.id, plan: 'studio' });
  await second.request('/api/auth/signup', {
    method: 'POST',
    body: { name: '다른 운영자', email: 'other-brands@example.test', password: 'strong-password' },
  });

  const workspace = sampleWorkspace();
  workspace.brandProfiles = [
    brandProfile('brand-cafe', '#254a3b'),
    brandProfile('brand-dessert', '#8a4b2a'),
  ];
  workspace.activeBrandId = 'brand-cafe';
  workspace.projects[0].brandId = 'brand-cafe';

  const saved = await first.request('/api/workspace', {
    method: 'PUT',
    userId: signup.body.user.id,
    body: workspace,
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.brandProfiles, workspace.brandProfiles);
  assert.equal(saved.body.activeBrandId, 'brand-cafe');

  const isolated = await second.request('/api/workspace');
  assert.deepEqual(isolated.body, { brand: null, projects: [] });

  workspace.brandProfiles = [brandProfile('brand-dessert', '#8a4b2a')];
  workspace.activeBrandId = 'brand-dessert';
  const deleted = await first.request('/api/workspace', {
    method: 'PUT',
    userId: signup.body.user.id,
    body: workspace,
  });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.projects[0].brandId, 'brand-cafe');
  assert.deepEqual(deleted.body.brandProfiles, workspace.brandProfiles);

  const emptyProfiles = { ...workspace, brandProfiles: [], activeBrandId: null };
  const emptied = await first.request('/api/workspace', {
    method: 'PUT',
    userId: signup.body.user.id,
    body: emptyProfiles,
  });
  assert.equal(emptied.status, 200);
  assert.deepEqual(emptied.body.brandProfiles, []);
  assert.equal(emptied.body.activeBrandId, null);

  app = await restartServerAtPath(t, app, dbPath);
  first.base = app.base;
  const reloaded = await first.request('/api/workspace');
  assert.equal(reloaded.status, 200);
  assert.deepEqual(reloaded.body.brandProfiles, []);
  assert.equal(reloaded.body.activeBrandId, null);
  assert.equal(reloaded.body.projects[0].brandId, 'brand-cafe');
});

test('workspace brand profiles reject invalid counts, duplicate ids, and missing active profile', async (t) => {
  const app = await startServer(t);
  const client = new Client(app.base);
  const signup = await client.request('/api/auth/signup', {
    method: 'POST',
    body: { name: '검증 운영자', email: 'brand-validation@example.test', password: 'strong-password' },
  });
  const workspace = sampleWorkspace();
  const save = (body) => client.request('/api/workspace', { method: 'PUT', userId: signup.body.user.id, body });

  assert.equal(
    (await save({
      ...workspace,
      brandProfiles: [
        brandProfile('brand-1', '#111111'),
        brandProfile('brand-2', '#222222'),
        brandProfile('brand-3', '#333333'),
        brandProfile('brand-4', '#444444'),
      ],
      activeBrandId: 'brand-1',
    })).status,
    400,
  );
  assert.equal(
    (await save({
      ...workspace,
      brandProfiles: [brandProfile('brand-1', '#111111'), brandProfile('brand-1', '#222222')],
      activeBrandId: 'brand-1',
    })).status,
    400,
  );
  assert.equal(
    (await save({
      ...workspace,
      brandProfiles: [brandProfile('brand-1', '#111111')],
      activeBrandId: 'missing-brand',
    })).status,
    400,
  );
});

test('free workspace saves block creating a second brand profile', async (t) => {
  const app = await startServer(t);
  const client = new Client(app.base);
  const signup = await client.request('/api/auth/signup', {
    method: 'POST',
    body: { name: '무료 운영자', email: 'free-brand-limit@example.test', password: 'strong-password' },
  });
  const workspace = sampleWorkspace();
  const oneBrand = {
    ...workspace,
    brandProfiles: [brandProfile('brand-free', '#254a3b')],
    activeBrandId: 'brand-free',
  };
  const saved = await client.request('/api/workspace', { method: 'PUT', userId: signup.body.user.id, body: oneBrand });
  assert.equal(saved.status, 200);

  const entitlements = await client.request('/api/entitlements');
  assert.equal(entitlements.status, 200);
  assert.equal(entitlements.body.plan, 'free');
  assert.equal(entitlements.body.brandLimit, 1);

  const secondBlocked = await client.request('/api/workspace', {
    method: 'PUT',
    userId: signup.body.user.id,
    body: {
      ...workspace,
      brandProfiles: [brandProfile('brand-free', '#254a3b'), brandProfile('brand-second', '#8a4b2a')],
      activeBrandId: 'brand-free',
    },
  });
  assert.equal(secondBlocked.status, 400);
  assert.match(secondBlocked.body.error, /최대 1개/);

  const loaded = await client.request('/api/workspace');
  assert.deepEqual(loaded.body.brandProfiles, oneBrand.brandProfiles);
});

test('active live paid plans allow three brand profiles in the local auth API', async (t) => {
  for (const plan of ['light', 'studio', 'plus']) {
    await t.test(plan, async (t) => {
      const app = await startServer(t);
      const client = new Client(app.base);
      const signup = await client.request('/api/auth/signup', {
        method: 'POST',
        body: { name: `${plan} 운영자`, email: `${plan}-brand-limit@example.test`, password: 'strong-password' },
      });
      insertLivePaidOrder(app.auth.db, { userId: signup.body.user.id, plan });

      const entitlements = await client.request('/api/entitlements');
      assert.equal(entitlements.status, 200);
      assert.equal(entitlements.body.plan, plan);
      assert.equal(entitlements.body.brandLimit, 3);
      assert.ok(entitlements.body.periodStart);
      assert.ok(entitlements.body.periodEnd);

      const workspace = sampleWorkspace();
      const paidWorkspace = {
        ...workspace,
        brandProfiles: [
          brandProfile(`${plan}-brand-1`, '#254a3b'),
          brandProfile(`${plan}-brand-2`, '#8a4b2a'),
          brandProfile(`${plan}-brand-3`, '#354b64'),
        ],
        activeBrandId: `${plan}-brand-1`,
      };
      const saved = await client.request('/api/workspace', { method: 'PUT', userId: signup.body.user.id, body: paidWorkspace });
      assert.equal(saved.status, 200);
      assert.equal(saved.body.brandProfiles.length, 3);
    });
  }
});

test('downgraded users can preserve, edit, and delete existing over-limit brand profiles', async (t) => {
  const app = await startServer(t);
  const client = new Client(app.base);
  const signup = await client.request('/api/auth/signup', {
    method: 'POST',
    body: { name: '다운그레이드 운영자', email: 'downgrade-brand-limit@example.test', password: 'strong-password' },
  });
  const orderId = insertLivePaidOrder(app.auth.db, { userId: signup.body.user.id, plan: 'plus' });
  const workspace = sampleWorkspace();
  const paidWorkspace = {
    ...workspace,
    brandProfiles: [
      brandProfile('brand-one', '#254a3b'),
      brandProfile('brand-two', '#8a4b2a'),
      brandProfile('brand-three', '#354b64'),
    ],
    activeBrandId: 'brand-one',
  };
  assert.equal((await client.request('/api/workspace', { method: 'PUT', userId: signup.body.user.id, body: paidWorkspace })).status, 200);

  app.auth.db.prepare("UPDATE payment_orders SET period_end = ?, updated_at = ? WHERE id = ?").run(Date.now() - 1000, Date.now(), orderId);
  const downgraded = await client.request('/api/entitlements');
  assert.equal(downgraded.body.plan, 'free');
  assert.equal(downgraded.body.brandLimit, 1);

  const edited = {
    ...paidWorkspace,
    brandProfiles: [
      { ...paidWorkspace.brandProfiles[0], tagline: '수정된 소개' },
      paidWorkspace.brandProfiles[1],
      paidWorkspace.brandProfiles[2],
    ],
  };
  const editSave = await client.request('/api/workspace', { method: 'PUT', userId: signup.body.user.id, body: edited });
  assert.equal(editSave.status, 200);
  assert.equal(editSave.body.brandProfiles[0].tagline, '수정된 소개');

  const deleted = {
    ...edited,
    brandProfiles: edited.brandProfiles.slice(0, 2),
    activeBrandId: 'brand-one',
  };
  const deleteSave = await client.request('/api/workspace', { method: 'PUT', userId: signup.body.user.id, body: deleted });
  assert.equal(deleteSave.status, 200);
  assert.equal(deleteSave.body.brandProfiles.length, 2);
});

async function startServer(t) {
  const dir = mkdtempSync(join(tmpdir(), 'moa-auth-'));
  const app = await startServerAtPath(t, join(dir, 'test.sqlite'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return app;
}

async function startServerAtPath(t, dbPath) {
  const auth = createAuthService({ dbPath, allowedOrigin: ORIGIN, scryptParams: TEST_SCRYPT });
  const server = createApiServer({ authService: auth });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const app = { auth, server, base: `http://127.0.0.1:${server.address().port}`, closed: false };
  t.after(() => closeApp(app));
  return app;
}

async function restartServerAtPath(t, app, dbPath) {
  await closeApp(app);
  return startServerAtPath(t, dbPath);
}

async function closeApp(app) {
  if (app.closed) return;
  app.closed = true;
  await new Promise((resolve) => app.server?.close(resolve));
  app.auth.close();
}

class Client {
  constructor(base) {
    this.base = base;
    this.cookie = '';
  }

  async request(path, options = {}) {
    const headers = { Origin: ORIGIN, ...(options.headers ?? {}) };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.userId) headers['X-Moa-User'] = options.userId;
    if (this.cookie) headers.Cookie = this.cookie;
    const response = await fetch(`${this.base}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0];
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
  }
}

function sampleWorkspace() {
  const brand = {
    name: '카페 모아',
    tagline: '동네의 작은 쉼',
    location: '연남동',
    instagram: '@cafe_moa',
    color: '#254a3b',
  };
  return {
    brand,
    projects: [
      {
        id: 'project-one',
        name: '시그니처 크림 라떼',
        updatedAt: '2026-09-06T00:00:00.000Z',
        brand,
        brief: {
          productName: '시그니처 크림 라떼',
          description: '부드러운 크림과 에스프레소의 조화',
          price: '6,500원',
          tone: 'warm',
          goal: 'daily',
        },
        photos: [{ id: 'sample-latte', name: 'sample', dataUrl: '/assets/cafe-latte.png' }],
        pack: {
          source: 'template',
          cards: [
            {
              id: 'card-1',
              title: '오늘의 라테',
              subtitle: '6,500원',
              eyebrow: '오늘의 추천',
              body: '부드러운 크림',
              imageId: 'sample-latte',
              layout: 'editorial',
            },
          ],
          caption: '카페 모아의 라테',
          hashtags: ['#카페모아'],
          schedule: [{ day: '월', title: '첫 소개', format: '카드뉴스', description: '대표 사진으로 소개합니다.' }],
        },
      },
    ],
  };
}

function brandProfile(id, color) {
  return {
    id,
    name: id === 'brand-cafe' ? '카페 모아' : '모아 디저트',
    tagline: '매일 다른 기분',
    location: '연남동',
    instagram: '@moa',
    color,
  };
}

function insertLivePaidOrder(db, { userId, plan }) {
  const now = Date.now();
  const orderId = `moa_test_${plan}_${now}_${Math.random().toString(36).slice(2)}`;
  db.prepare(
    `INSERT INTO payment_orders (
      id, user_id, plan, interval, mode, order_name, amount, currency, status,
      toss_payment_key, toss_status, receipt_url, paid_at, period_start, period_end,
      created_at, updated_at, expires_at
    ) VALUES (?, ?, ?, 'month', 'live', ?, 1000, 'KRW', 'PAID', ?, 'DONE', NULL, ?, ?, ?, ?, ?, ?)`,
  ).run(
    orderId,
    userId,
    plan,
    `Test ${plan}`,
    `pay_${plan}_${now}`,
    now,
    now,
    now + 30 * 24 * 60 * 60 * 1000,
    now,
    now,
    now + 30 * 60 * 1000,
  );
  return orderId;
}

test('workspace round-trip retains expanded card edits and rejects overflow instead of silently truncating', async (t) => {
  const app = await startServer(t);
  const client = new Client(app.base);
  const signup = await client.request('/api/auth/signup', { method: 'POST', body: { name: '편집 검증', email: 'editing@example.test', password: 'strong-password' } });
  const workspace = sampleWorkspace();
  const project = workspace.projects[0];
  project.brandId = 'brand-cafe';
  project.brief.includeSchedule = true;
  project.brief.scheduleStartDate = '2026-09-07';
  const layouts = ['editorial', 'minimal', 'bold', 'split', 'poster', 'menu'];
  project.pack.cards = Array.from({ length: 10 }, (_, index) => ({ ...project.pack.cards[0], id: `edited-${index}`, layout: layouts[index % 6], style: { textColor: '#123456', backgroundColor: '#fedcba', fontScale: 1.2, align: 'center' } }));
  project.pack.caption = '직접 작성한 게시글'.repeat(300);
  project.pack.hashtags = Array.from({ length: 30 }, (_, index) => `#태그${index}`);
  project.pack.schedule = Array.from({ length: 12 }, (_, index) => ({ ...project.pack.schedule[0], date: `2026-09-${String(index + 7).padStart(2, '0')}` }));
  project.photoChats = {
    'edited-0': [
      { role: 'user', content: '컵은 그대로 두고 배경을 밝게 바꿔 줘' },
      { role: 'assistant', content: '배경을 밝게 정리한 변경안을 만들었어요.' },
    ],
    'edited-9': Array.from({ length: 200 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `저장된 대화 ${index}` })),
  };
  const save = () => client.request('/api/workspace', { method: 'PUT', userId: signup.body.user.id, body: workspace });
  assert.equal((await save()).status, 200);
  assert.deepEqual((await client.request('/api/workspace')).body.projects[0], project);
  project.photoChats['edited-0'][0].references = [];
  assert.equal((await save()).status, 400);
  delete project.photoChats['edited-0'][0].references;
  project.photoChats['edited-0'][1].content = '응'.repeat(4001);
  assert.equal((await save()).status, 400);
  project.photoChats['edited-0'][1].content = '배경을 밝게 정리한 변경안을 만들었어요.';
  project.photoChats['missing-card'] = [{ role: 'user', content: '없는 카드에 저장된 대화' }];
  assert.equal((await save()).status, 400);
  delete project.photoChats['missing-card'];
  project.pack.cards.push({ ...project.pack.cards[0], id: 'overflow' });
  assert.equal((await save()).status, 400);
  assert.equal((await client.request('/api/workspace')).body.projects[0].pack.cards.length, 10);
  project.pack.cards.pop();
  project.pack.cards[0].style.textColor = 'url(https://example.test)';
  assert.equal((await save()).status, 400);
});
