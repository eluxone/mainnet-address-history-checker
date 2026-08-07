import { chromium, request as apiRequest } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const LOCAL_BASE = process.env.LOCAL_BASE || 'http://127.0.0.1:4173';
const PROD_BASE = process.env.PROD_BASE || 'https://portofele.vercel.app';
const QA_USERNAME = process.env.QA_USERNAME || '';
const QA_PASSWORD = process.env.QA_PASSWORD || '';
const ARTIFACT_DIR = path.resolve('qa/browser-artifacts');
const REPORT_PATH = path.resolve('qa/full-browser-qa-report.json');
const SUMMARY_PATH = path.resolve('qa/full-browser-qa-summary.md');

const profiles = [
  { name: 'desktop', viewport: { width: 1440, height: 1000 }, isMobile: false },
  { name: 'mobile', viewport: { width: 390, height: 844 }, isMobile: true }
];

const pages = [
  { slug: 'dashboard', path: '/dashboard.html' },
  { slug: 'evm-auditor', path: '/index.html' },
  { slug: 'btc-discovery', path: '/btc-discovery.html' },
  { slug: 'address-workspace', path: '/address-workspace.html' },
  { slug: 'jobs', path: '/jobs.html' },
  { slug: 'notifications', path: '/notifications.html' },
  { slug: 'approvals', path: '/approvals.html' },
  { slug: 'exports', path: '/exports.html' },
  { slug: 'btc-research', path: '/btc-research.html' },
  { slug: 'seed-recovery', path: '/recovery-assistant.html' },
  { slug: 'advanced-recovery', path: '/advanced-recovery.html' },
  { slug: 'admin', path: '/admin.html' },
  { slug: 'login', path: '/login.html' }
];

const protectedRoutes = [
  '/', '/evm', '/btc', '/address-workspace.html', '/jobs.html', '/notifications.html',
  '/approvals.html', '/exports.html', '/btc-research.html', '/recover',
  '/advanced-recovery', '/admin.html'
];

const report = {
  startedAt: new Date().toISOString(),
  productionBase: PROD_BASE,
  localBase: LOCAL_BASE,
  authenticatedProductionConfigured: Boolean(QA_USERNAME && QA_PASSWORD),
  tests: []
};

function errorText(error) {
  return String(error?.stack || error?.message || error).slice(0, 5000);
}

async function record(name, scope, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    report.tests.push({ name, scope, status: 'passed', durationMs: Date.now() - started, detail: detail || null });
    console.log(`PASS ${scope} :: ${name}`);
  } catch (error) {
    report.tests.push({ name, scope, status: 'failed', durationMs: Date.now() - started, error: errorText(error) });
    console.error(`FAIL ${scope} :: ${name}\n${errorText(error)}`);
  }
}

function skip(name, scope, reason) {
  report.tests.push({ name, scope, status: 'skipped', durationMs: 0, reason });
  console.log(`SKIP ${scope} :: ${name} — ${reason}`);
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function qaUser() {
  return { id: 'qa-user', username: 'qa-admin', displayName: 'QA Admin', display_name: 'QA Admin', role: 'admin', active: true };
}

function createMockState() {
  return {
    users: [{ id: 'qa-user', username: 'qa-admin', display_name: 'QA Admin', role: 'admin', active: true, created_at: new Date().toISOString(), last_login_at: new Date().toISOString() }],
    notifications: [{ id: 1, kind: 'success', title: 'QA notification', message: 'Browser test fixture', created_at: new Date().toISOString(), read_at: null }],
    jobs: [
      { id: 'btc-job', kind: 'btc', chain: 'BTC', name: 'BTC QA job', status: 'running', checked_count: 25, total: 100, candidate_count: 100, matches: 2, matched_count: 2, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), last_heartbeat_at: new Date().toISOString(), owner: qaUser() },
      { id: 'evm-job', kind: 'evm', chain: 'EVM', name: 'EVM QA job', status: 'complete', checked_count: 20, total: 20, candidate_count: 20, matches: 1, matched_count: 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), last_heartbeat_at: new Date().toISOString(), owner: qaUser() }
    ]
  };
}

function jsonFixture(url, request, state) {
  const p = url.pathname;
  const method = request.method();
  let body = {};
  try { body = request.postDataJSON() || {}; } catch {}

  if (p === '/api/me') return { user: qaUser() };
  if (p === '/api/activity') return { ok: true };
  if (p === '/api/dashboard') return {
    user: qaUser(),
    summary: { activeJobs: 1, completedJobs: 1, matches: 3, savedSearches: 1, watchlist: 1, researchNotes: 1, unreadNotifications: state.notifications.filter(n => !n.read_at).length },
    jobs: state.jobs.map(j => ({ ...j, type: j.kind })),
    activity: [{ created_at: new Date().toISOString(), username_snapshot: 'qa-admin', action: 'page_view', tool: 'qa' }]
  };
  if (p === '/api/admin-users') {
    if (method === 'GET') return { users: state.users, activity: [] };
    if (body.action === 'create') {
      const user = { id: `u-${state.users.length + 1}`, username: body.username || 'test-user', display_name: body.displayName || 'Test User', role: body.role || 'user', active: true, created_at: new Date().toISOString(), last_login_at: null };
      state.users.push(user);
      return { user, password: 'QA-Temporary-Password-2026!' };
    }
    if (body.action === 'reset_password') return { password: 'QA-Reset-Password-2026!' };
    return { ok: true };
  }
  if (p === '/api/jobs') return { jobs: state.jobs };
  if (p === '/api/btc-background-jobs' || p === '/api/evm-background-jobs') {
    if (method === 'POST') {
      const job = state.jobs.find(j => j.id === body.id);
      if (job && body.action) job.status = body.action === 'cancel' ? 'cancelled' : body.action === 'pause' ? 'paused' : body.action === 'resume' ? 'running' : job.status;
    }
    if (method === 'DELETE') state.jobs = state.jobs.filter(j => j.id !== url.searchParams.get('id'));
    return { ok: true, jobs: state.jobs };
  }
  if (p === '/api/notifications') {
    if (method === 'POST' && body.action === 'read') {
      const row = state.notifications.find(n => String(n.id) === String(body.id));
      if (row) row.read_at = new Date().toISOString();
    }
    if (method === 'POST' && body.action === 'read_all') state.notifications.forEach(n => { n.read_at = new Date().toISOString(); });
    if (method === 'POST' && body.action === 'delete') state.notifications = state.notifications.filter(n => String(n.id) !== String(body.id));
    return { notifications: state.notifications, unread: state.notifications.filter(n => !n.read_at).length };
  }
  if (p === '/api/export-center') {
    if (!url.searchParams.has('type')) return {
      role: 'admin',
      catalog: {
        btcJobs: [{ id: 'btc-job', name: 'BTC QA job', status: 'complete', matched_count: 2 }],
        evmJobs: [{ id: 'evm-job', name: 'EVM QA job', status: 'complete', matched_count: 1 }],
        savedSearches: [{ id: 'saved-1', name: 'QA search', status: 'saved' }]
      }
    };
    return { exportedAt: new Date().toISOString(), type: url.searchParams.get('type'), label: 'qa-export', data: [{ address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', note: 'QA fixture' }] };
  }
  if (p === '/api/btc-inspect') return {
    balanceSats: 5000000000, fundedSats: 5000000000, spentSats: 0, txCount: 1,
    addressType: 'p2pkh', lastActivity: '2009-01-12T03:30:25.000Z', utxoCount: 1,
    oldestUtxoDays: 6000, timeline: [{ txid: '4a5e1e4baab89f3a32518a88', timestamp: '2009-01-12T03:30:25.000Z', blockHeight: 0, feeSats: 0 }]
  };
  if (p === '/api/check-address') return {
    activity: { found: true, label: 'Activity found' },
    summary: { activeNetworkCount: 1, networksChecked: 3, contractNetworkCount: 0, historyReturned: 1 },
    networkResults: [{ label: 'Ethereum Mainnet', activityFound: true, balanceNative: '1.0', outgoingTransactionCount: '1', hasContractCode: false, evidence: ['QA fixture'] }],
    history: { returned: 1 }
  };
  if (p === '/api/evm-approvals') return {
    lookbackBlocks: body.lookbackBlocks || 500000,
    summary: { events: 1, active: 1, revoked: 0, unknown: 0, veryLargeAllowances: 0, operatorApprovals: 0 },
    events: [{ networkLabel: 'Ethereum Mainnet', label: 'ERC-20 allowance', kind: 'erc20', contract: '0x0000000000000000000000000000000000000001', spender: '0x0000000000000000000000000000000000000002', state: 'active', currentValue: '1000', risk: 'limited', transactionHash: '0xabc', explorer: 'https://example.invalid/tx/0xabc' }]
  };
  if (p === '/api/btc-saved-searches') return { searches: [] };
  if (p === '/api/btc-watchlist') return { watchlist: [], events: [] };
  if (p === '/api/btc-analytics') return { metrics: {}, charts: {} };
  if (p === '/api/btc-index') return { items: [] };
  if (p === '/api/btc-research') return { address: body.address || url.searchParams.get('address') || '', index: null, occurrences: [], notes: null, watchlist: null, watchlistEvents: [], savedSearchAppearances: [] };
  if (p === '/api/btc-preview') return { allowed: true, candidateCacheHit: true, candidateCount: 100, estimatedBytes: '0', maxBytes: '25000000000', percentOfLimit: 0, bigQueryRequired: false, note: 'QA fixture' };
  if (p.includes('/api/btc-discovery')) return { results: [], candidateCount: 100, checkedCount: 50, nextOffset: 50, hasMore: false, providerErrors: 0, addressCacheHits: 50, bigQueryBytesProcessed: 0 };
  if (p === '/api/login') return method === 'GET' ? { ok: true, configured: true, source: 'qa', environment: 'local', build: 'qa' } : { ok: true, build: 'qa' };
  return { ok: true };
}

async function installMocks(page) {
  const state = createMockState();
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const payload = jsonFixture(url, request, state);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
  });
  return state;
}

async function collectRuntimeProblems(page, action) {
  const problems = [];
  const onPageError = error => problems.push(`pageerror: ${errorText(error)}`);
  const onConsole = message => { if (message.type() === 'error') problems.push(`console: ${message.text()}`); };
  const onResponse = response => {
    const url = response.url();
    if (response.status() >= 400 && !url.includes('/favicon.ico')) problems.push(`http ${response.status()}: ${url}`);
  };
  page.on('pageerror', onPageError);
  page.on('console', onConsole);
  page.on('response', onResponse);
  try { await action(); } finally {
    page.off('pageerror', onPageError);
    page.off('console', onConsole);
    page.off('response', onResponse);
  }
  return problems;
}

async function assertCommonLayout(page, profile, slug) {
  await page.waitForTimeout(600);
  const bodyVisible = await page.locator('body').isVisible();
  expect(bodyVisible, `${slug}: body is not visible`);
  const h1 = page.locator('h1').first();
  expect(await h1.isVisible(), `${slug}: no visible H1`);
  expect((await h1.textContent() || '').trim().length > 2, `${slug}: empty H1`);

  const brokenImages = await page.evaluate(() => [...document.images].filter(img => img.complete && img.naturalWidth === 0).map(img => img.getAttribute('src')));
  expect(brokenImages.length === 0, `${slug}: broken images: ${brokenImages.join(', ')}`);

  const duplicateIds = await page.evaluate(() => {
    const counts = {};
    for (const el of document.querySelectorAll('[id]')) counts[el.id] = (counts[el.id] || 0) + 1;
    return Object.entries(counts).filter(([, n]) => n > 1);
  });
  expect(duplicateIds.length === 0, `${slug}: duplicate IDs: ${JSON.stringify(duplicateIds)}`);

  const overflow = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
  expect(overflow.scrollWidth <= overflow.clientWidth + 4, `${slug}: horizontal page overflow ${overflow.scrollWidth} > ${overflow.clientWidth}`);

  const offscreenControls = await page.evaluate(() => [...document.querySelectorAll('input,select,textarea,button,a')]
    .filter(el => {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      if (el.closest('.crypto-mobile-drawer:not(.open), .crypto-tools-menu:not(.open)')) return false;
      const scrollBox = el.closest('.table-wrap');
      if (scrollBox && scrollBox.scrollWidth > scrollBox.clientWidth + 2) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && (r.left < -3 || r.right > innerWidth + 3);
    }).slice(0, 10).map(el => ({ tag: el.tagName, id: el.id, text: (el.textContent || '').trim().slice(0, 50), rect: el.getBoundingClientRect().toJSON() })));
  expect(offscreenControls.length === 0, `${slug}: controls outside viewport: ${JSON.stringify(offscreenControls)}`);

  const pageCount = await page.evaluate(() => Array.isArray(window.__SITE_PAGES__) ? window.__SITE_PAGES__.length : 0);
  const menuCount = await page.locator('.crypto-menu-item').count();
  expect(pageCount > 0, `${slug}: site page map did not load`);
  expect(menuCount === pageCount, `${slug}: All Tools count ${menuCount} does not match page map ${pageCount}`);

  if (profile.isMobile) {
    const toggle = page.locator('.crypto-mobile-toggle');
    expect(await toggle.isVisible(), `${slug}: mobile hamburger is not visible`);
    await toggle.click();
    expect(await page.locator('.crypto-mobile-drawer.open').isVisible(), `${slug}: mobile drawer did not open`);
    expect(await page.locator('.crypto-mobile-link').count() === pageCount, `${slug}: mobile drawer does not contain every page`);
    const sheet = await page.locator('.crypto-mobile-sheet').boundingBox();
    expect(sheet && sheet.x >= -1 && sheet.x + sheet.width <= profile.viewport.width + 1, `${slug}: mobile drawer is outside viewport`);
    await page.keyboard.press('Escape');
  } else {
    expect(await page.locator('.crypto-desktop-links').isVisible(), `${slug}: desktop navigation is not visible`);
    const tools = page.locator('.crypto-tools-button');
    expect(await tools.isVisible(), `${slug}: All Tools button is not visible`);
    await tools.click();
    expect(await page.locator('.crypto-tools-menu.open').isVisible(), `${slug}: All Tools menu did not open`);
    await page.keyboard.press('Escape');
  }
}

async function runLocalSmoke(browser) {
  for (const profile of profiles) {
    for (const item of pages) {
      await record(`${item.slug} renders without browser errors`, `local-${profile.name}`, async () => {
        const context = await browser.newContext({ viewport: profile.viewport, acceptDownloads: true, reducedMotion: 'reduce' });
        await context.addInitScript(() => sessionStorage.setItem('crypto-intro-seen', '1'));
        const page = await context.newPage();
        await installMocks(page);
        const problems = await collectRuntimeProblems(page, async () => {
          const response = await page.goto(`${LOCAL_BASE}${item.path}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
          expect(response?.status() === 200, `${item.slug}: local HTTP ${response?.status()}`);
          await assertCommonLayout(page, profile, item.slug);
          await page.screenshot({ path: path.join(ARTIFACT_DIR, `local-${profile.name}-${item.slug}.png`), fullPage: true });
        });
        await context.close();
        expect(problems.length === 0, `${item.slug}: runtime problems: ${problems.join(' | ')}`);
        return { screenshot: `local-${profile.name}-${item.slug}.png` };
      });
    }
  }
}

async function runLocalInteractions(browser) {
  await record('advanced recovery self-tests and exact known-address recovery', 'local-interaction', async () => {
    const context = await browser.newContext({ viewport: profiles[0].viewport });
    await context.addInitScript(() => sessionStorage.setItem('crypto-intro-seen', '1'));
    const page = await context.newPage();
    await installMocks(page);
    await page.goto(`${LOCAL_BASE}/advanced-recovery.html`, { waitUntil: 'domcontentloaded' });
    await page.click('#ar-tests');
    await page.waitForFunction(() => document.querySelector('#ar-message')?.textContent?.includes('PASS'), null, { timeout: 20000 });
    await page.selectOption('#ar-chain', 'btc84');
    await page.selectOption('#ar-word-count', '12');
    await page.selectOption('#ar-mode', 'missing-one');
    const words = page.locator('#ar-word-grid input');
    expect(await words.count() === 12, 'Advanced recovery did not build 12 word inputs');
    for (let i = 0; i < 11; i++) await words.nth(i).fill('abandon');
    await words.nth(11).fill('');
    await page.fill('#ar-target', 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
    await page.fill('#ar-account-count', '1');
    await page.fill('#ar-index-count', '1');
    await page.check('#ar-ownership');
    await page.click('#ar-start');
    await page.waitForSelector('#ar-result-panel:not([hidden])', { timeout: 30000 });
    expect((await page.locator('#ar-result-meta').textContent() || '').includes("m/84'/0'/0'/0/0"), 'Advanced recovery returned the wrong path');
    await page.click('#ar-reveal');
    expect((await page.inputValue('#ar-result')).endsWith('about'), 'Advanced recovery did not recover the known test phrase');
    await page.click('#ar-clear');
    expect(await words.nth(0).inputValue() === '', 'Advanced recovery did not clear sensitive words');
    expect(await page.locator('#ar-result-panel').isHidden(), 'Advanced recovery result was not erased');
    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'interaction-advanced-recovery.png'), fullPage: true });
    await context.close();
  });

  await record('guided seed recovery exact ETH match and sensitive-data clearing', 'local-interaction', async () => {
    const context = await browser.newContext({ viewport: profiles[0].viewport });
    await context.addInitScript(() => sessionStorage.setItem('crypto-intro-seen', '1'));
    const page = await context.newPage();
    await installMocks(page);
    await page.goto(`${LOCAL_BASE}/recovery-assistant.html`, { waitUntil: 'domcontentloaded' });
    await page.selectOption('#recovery-mode', 'missing-one');
    const words = page.locator('#word-grid input');
    expect(await words.count() === 12, 'Seed recovery did not build 12 word inputs');
    for (let i = 0; i < 11; i++) await words.nth(i).fill('abandon');
    await page.fill('#known-recovery-address', '0x9858EfFD232B4033E47d90003D41EC34EcaEda94');
    await page.fill('#account-count', '1');
    await page.check('#recovery-ownership');
    await page.click('#start-seed-recovery');
    await page.waitForSelector('#seed-result-panel:not([hidden])', { timeout: 30000 });
    expect((await page.locator('#matched-path').textContent() || '').includes("m/44'/60'/0'/0/0"), 'Seed recovery returned the wrong ETH path');
    await page.click('#clear-seed-recovery');
    expect(await words.nth(0).inputValue() === '', 'Seed recovery did not clear sensitive words');
    expect(await page.locator('#seed-result-panel').isHidden(), 'Seed recovery result was not erased');
    await context.close();
  });

  await record('cross-chain workspace loads BTC and EVM fixtures', 'local-interaction', async () => {
    const context = await browser.newContext({ viewport: profiles[0].viewport });
    await context.addInitScript(() => sessionStorage.setItem('crypto-intro-seen', '1'));
    const page = await context.newPage();
    await installMocks(page);
    await page.goto(`${LOCAL_BASE}/address-workspace.html`, { waitUntil: 'domcontentloaded' });
    await page.fill('#aw-address', '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa');
    await page.click('#aw-form button[type="submit"]');
    await page.waitForSelector('#aw-results:not([hidden])');
    expect((await page.locator('#aw-network').textContent() || '').includes('Bitcoin'), 'BTC detection failed');
    await page.click('#aw-clear');
    await page.fill('#aw-address', '0x9858EfFD232B4033E47d90003D41EC34EcaEda94');
    await page.click('#aw-form button[type="submit"]');
    await page.waitForSelector('#aw-results:not([hidden])');
    expect((await page.locator('#aw-network').textContent() || '').includes('EVM'), 'EVM detection failed');
    await context.close();
  });

  await record('admin can create a user and receive a generated password', 'local-interaction', async () => {
    const context = await browser.newContext({ viewport: profiles[0].viewport });
    await context.addInitScript(() => sessionStorage.setItem('crypto-intro-seen', '1'));
    const page = await context.newPage();
    await installMocks(page);
    await page.goto(`${LOCAL_BASE}/admin.html`, { waitUntil: 'domcontentloaded' });
    await page.fill('#au-username', 'qa-researcher');
    await page.fill('#au-name', 'QA Researcher');
    await page.click('#au-create');
    await page.waitForSelector('#au-password:not([hidden])');
    expect((await page.inputValue('#au-password-value')).includes('QA-Temporary'), 'Admin password generation UI failed');
    await context.close();
  });

  await record('notification actions update unread state', 'local-interaction', async () => {
    const context = await browser.newContext({ viewport: profiles[0].viewport });
    await context.addInitScript(() => sessionStorage.setItem('crypto-intro-seen', '1'));
    const page = await context.newPage();
    await installMocks(page);
    await page.goto(`${LOCAL_BASE}/notifications.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-read="1"]');
    await page.click('[data-read="1"]');
    await page.waitForFunction(() => document.querySelector('#notif-status')?.textContent?.startsWith('0 unread'));
    await context.close();
  });

  await record('job manager pause action persists in client view', 'local-interaction', async () => {
    const context = await browser.newContext({ viewport: profiles[0].viewport });
    await context.addInitScript(() => sessionStorage.setItem('crypto-intro-seen', '1'));
    const page = await context.newPage();
    await installMocks(page);
    await page.goto(`${LOCAL_BASE}/jobs.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('button[data-act="pause"][data-id="btc-job"]');
    await page.click('button[data-act="pause"][data-id="btc-job"]');
    await page.waitForFunction(() => [...document.querySelectorAll('#jobs-body tr')].some(tr => tr.textContent?.includes('BTC QA job') && tr.textContent?.includes('paused')));
    await context.close();
  });

  await record('export center produces a JSON download', 'local-interaction', async () => {
    const context = await browser.newContext({ viewport: profiles[0].viewport, acceptDownloads: true });
    await context.addInitScript(() => sessionStorage.setItem('crypto-intro-seen', '1'));
    const page = await context.newPage();
    await installMocks(page);
    await page.goto(`${LOCAL_BASE}/exports.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#ex-status')?.textContent?.includes('ready'));
    const downloadPromise = page.waitForEvent('download');
    await page.click('#ex-json');
    const download = await downloadPromise;
    expect(download.suggestedFilename().endsWith('.json'), 'Export filename was not JSON');
    const savePath = path.join(ARTIFACT_DIR, download.suggestedFilename());
    await download.saveAs(savePath);
    const content = await fs.readFile(savePath, 'utf8');
    expect(content.includes('QA fixture'), 'Exported JSON did not contain expected data');
    await context.close();
  });

  await record('approval research renders a current-state result', 'local-interaction', async () => {
    const context = await browser.newContext({ viewport: profiles[0].viewport });
    await context.addInitScript(() => sessionStorage.setItem('crypto-intro-seen', '1'));
    const page = await context.newPage();
    await installMocks(page);
    await page.goto(`${LOCAL_BASE}/approvals.html`, { waitUntil: 'domcontentloaded' });
    await page.fill('#ap-address', '0x9858EfFD232B4033E47d90003D41EC34EcaEda94');
    await page.click('#ap-form button[type="submit"]');
    await page.waitForSelector('#ap-results:not([hidden])');
    expect((await page.locator('#ap-body').textContent() || '').includes('ERC-20 allowance'), 'Approval result did not render');
    await context.close();
  });
}

async function runProductionPublic(browser) {
  await record('production login endpoint reports configured service', 'production-public', async () => {
    const apiContext = await apiRequest.newContext({ baseURL: PROD_BASE, ignoreHTTPSErrors: false });
    const response = await apiContext.get('/api/login?status=1');
    expect(response.status() === 200, `Login status endpoint returned ${response.status()}`);
    const data = await response.json();
    expect(data.configured === true, 'Production login service reports no configured authentication');
    await apiContext.dispose();
  });

  await record('production security headers and logo asset are valid', 'production-public', async () => {
    const apiContext = await apiRequest.newContext({ baseURL: PROD_BASE });
    const login = await apiContext.get('/login.html');
    expect(login.status() === 200, `Production login returned ${login.status()}`);
    const headers = login.headers();
    expect((headers['content-security-policy'] || '').includes("default-src 'self'"), 'Missing Content-Security-Policy');
    expect((headers['x-frame-options'] || '').toUpperCase() === 'DENY', 'Missing X-Frame-Options DENY');
    expect((headers['referrer-policy'] || '') === 'no-referrer', 'Missing no-referrer policy');
    const logo = await apiContext.get('/anonymous-logo.svg');
    expect(logo.status() === 200, `Logo returned ${logo.status()}`);
    const logoText = await logo.text();
    expect(logoText.includes('<svg') && !logoText.includes('<image'), 'Logo is not a native browser-safe SVG');
    await apiContext.dispose();
  });

  for (const route of protectedRoutes) {
    await record(`${route} redirects unauthenticated visitors to login`, 'production-public', async () => {
      const context = await browser.newContext({ viewport: profiles[0].viewport });
      await context.addInitScript(() => sessionStorage.setItem('crypto-intro-seen', '1'));
      const page = await context.newPage();
      const problems = await collectRuntimeProblems(page, async () => {
        await page.goto(`${PROD_BASE}${route}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
        expect(new URL(page.url()).pathname === '/login.html', `${route}: final path was ${page.url()}`);
        const next = new URL(page.url()).searchParams.get('next');
        expect(Boolean(next), `${route}: login redirect did not preserve next destination`);
      });
      await context.close();
      expect(problems.length === 0, `${route}: production browser problems: ${problems.join(' | ')}`);
    });
  }

  for (const profile of profiles) {
    await record(`production login and intro render on ${profile.name}`, 'production-public', async () => {
      const context = await browser.newContext({ viewport: profile.viewport, reducedMotion: 'reduce' });
      const page = await context.newPage();
      const problems = await collectRuntimeProblems(page, async () => {
        await page.goto(`${PROD_BASE}/login.html`, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForSelector('.crypto-intro', { timeout: 5000 });
        const introLogo = page.locator('.crypto-intro-logo');
        expect(await introLogo.isVisible(), 'Intro logo is not visible');
        const naturalWidth = await introLogo.evaluate(img => img.naturalWidth);
        expect(naturalWidth > 0, 'Intro logo is broken');
        await page.click('.crypto-enter');
        await page.waitForSelector('.crypto-intro', { state: 'detached', timeout: 3000 });
        await assertCommonLayout(page, profile, 'production-login');
        const navLogoWidth = await page.locator('.crypto-brand-logo').evaluate(img => img.naturalWidth);
        expect(navLogoWidth > 0, 'Navbar logo is broken');
        await page.screenshot({ path: path.join(ARTIFACT_DIR, `production-login-${profile.name}.png`), fullPage: true });
      });
      await context.close();
      expect(problems.length === 0, `Production ${profile.name} login problems: ${problems.join(' | ')}`);
    });
  }
}

async function loginProduction(page) {
  await page.goto(`${PROD_BASE}/login.html`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  if (await page.locator('.crypto-intro').isVisible().catch(() => false)) await page.click('.crypto-enter');
  await page.fill('#username', QA_USERNAME).catch(async () => page.fill('#site-username', QA_USERNAME));
  await page.fill('#password', QA_PASSWORD).catch(async () => page.fill('#site-password', QA_PASSWORD));
  await Promise.all([
    page.waitForURL(url => new URL(url).pathname !== '/login.html', { timeout: 30000 }),
    page.click('#login-button')
  ]);
}

async function runProductionAuthenticated(browser) {
  if (!QA_USERNAME || !QA_PASSWORD) {
    skip('authenticated production desktop and mobile route pass', 'production-authenticated', 'QA_USERNAME and QA_PASSWORD repository secrets are not configured');
    return;
  }
  for (const profile of profiles) {
    await record(`authenticated production pages render on ${profile.name}`, 'production-authenticated', async () => {
      const context = await browser.newContext({ viewport: profile.viewport, reducedMotion: 'reduce' });
      await context.addInitScript(() => sessionStorage.setItem('crypto-intro-seen', '1'));
      const page = await context.newPage();
      await loginProduction(page);
      const failures = [];
      for (const item of pages.filter(p => p.slug !== 'login')) {
        const target = item.slug === 'dashboard' ? '/' : item.slug === 'evm-auditor' ? '/evm' : item.slug === 'btc-discovery' ? '/btc' : item.slug === 'seed-recovery' ? '/recover' : item.slug === 'advanced-recovery' ? '/advanced-recovery' : item.path;
        const problems = await collectRuntimeProblems(page, async () => {
          await page.goto(`${PROD_BASE}${target}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
          if (new URL(page.url()).pathname === '/login.html') throw new Error(`${target} unexpectedly returned to login`);
          await assertCommonLayout(page, profile, item.slug);
        });
        if (problems.length) failures.push(`${item.slug}: ${problems.join(' | ')}`);
      }
      await context.close();
      expect(failures.length === 0, failures.join('\n'));
    });
  }
}

async function writeReport() {
  report.finishedAt = new Date().toISOString();
  report.summary = {
    passed: report.tests.filter(t => t.status === 'passed').length,
    failed: report.tests.filter(t => t.status === 'failed').length,
    skipped: report.tests.filter(t => t.status === 'skipped').length,
    total: report.tests.length
  };
  await fs.mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await fs.writeFile(REPORT_PATH, JSON.stringify(report, null, 2));
  const failures = report.tests.filter(t => t.status === 'failed');
  const skips = report.tests.filter(t => t.status === 'skipped');
  const markdown = [
    '# CHAIN//LAB full browser QA',
    '',
    `- Finished: ${report.finishedAt}`,
    `- Passed: ${report.summary.passed}`,
    `- Failed: ${report.summary.failed}`,
    `- Skipped: ${report.summary.skipped}`,
    `- Production authenticated credentials configured: ${report.authenticatedProductionConfigured ? 'yes' : 'no'}`,
    '',
    '## Failures',
    failures.length ? failures.map(x => `- **${x.scope} / ${x.name}:** ${String(x.error).split('\n')[0]}`).join('\n') : '- None',
    '',
    '## Skipped',
    skips.length ? skips.map(x => `- **${x.scope} / ${x.name}:** ${x.reason}`).join('\n') : '- None',
    ''
  ].join('\n');
  await fs.writeFile(SUMMARY_PATH, markdown);
}

await fs.mkdir(ARTIFACT_DIR, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  await runLocalSmoke(browser);
  await runLocalInteractions(browser);
  await runProductionPublic(browser);
  await runProductionAuthenticated(browser);
} finally {
  await browser.close();
  await writeReport();
}

if (report.summary.failed > 0) process.exitCode = 1;
