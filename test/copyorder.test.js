'use strict';
// Through the real server: the copies of a film are played closest to TMDB's running time first (their providers'
// film info says how long each file runs), a title none of whose copies runs as long says its details may be wrong,
// and what a player saw a copy run is kept.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net'), http = require('http');
const { spawn } = require('child_process');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const n = s.address().port; s.close(() => ok(n)); }); });
const hms = (s) => [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((n) => String(n).padStart(2, '0')).join(':');

/** A provider: its films, each with how long its file runs (seconds). */
function panel(films) {
  const asked = [];
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (u.pathname !== '/player_api.php') { res.writeHead(404); return res.end(); }
    const a = u.searchParams.get('action') || '';
    if (!a) return send({ user_info: { auth: 1, status: 'Active', exp_date: '0', max_connections: '2' }, server_info: { timezone: 'UTC' } });
    if (a === 'get_vod_categories') return send([{ category_id: '1', category_name: 'Films' }]);
    if (a === 'get_vod_streams') return send(films.map((f) => ({ stream_id: f.id, name: f.name, category_id: '1', container_extension: 'mp4' })));
    if (a === 'get_vod_info') {
      const f = films.find((x) => String(x.id) === u.searchParams.get('vod_id'));
      asked.push(f && f.id);
      return send(f ? { info: { name: f.name, duration: hms(f.len), duration_secs: String(f.len) }, movie_data: { stream_id: f.id, container_extension: 'mp4' } } : {});
    }
    if (/^get_(live|series)/.test(a)) return send([]);
    send([]);
  });
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${srv.address().port}`, asked, close: () => { srv.close(); srv.closeAllConnections(); } })));
}

function fakeTmdb() {
  const FILMS = { 77: { title: 'Zero', release_date: '2026-03-01', runtime: 135 }, 88: { title: 'Lone', release_date: '2025-05-01', runtime: 110 }, 99: { title: 'Zero', release_date: '2025-09-01', runtime: 86 } };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (o, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    const p = u.pathname, q = u.searchParams.get('query') || '';
    if (p === '/configuration') return send({ images: {} });
    if (p === '/search/movie') return send({ results: /zero/i.test(q) ? [{ id: 77, title: 'Zero', release_date: '2026-03-01', popularity: 5 }, { id: 99, title: 'Zero', release_date: '2025-09-01', popularity: 1 }] : /lone/i.test(q) ? [{ id: 88, title: 'Lone', release_date: '2025-05-01', popularity: 5 }] : [] });
    const m = /^\/movie\/(\d+)$/.exec(p);
    if (m && FILMS[m[1]]) return send({ id: +m[1], ...FILMS[m[1]], genres: [], credits: { cast: [], crew: [] }, release_dates: { results: [] } });
    if (p === '/search/tv') return send({ results: [] });
    send({}, 404);
  });
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok({ base: `http://127.0.0.1:${srv.address().port}`, close: () => { srv.close(); srv.closeAllConnections(); } })));
}

test('copies closest to TMDB’s length first; a title nothing fits says so', { timeout: 120000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copyorder-'));
  // "Zero" (2026) runs 135 minutes on TMDB: provider A's copy runs 86 (another film), provider B's 135.
  // "Lone" (2025) runs 110: its only copy runs 62.
  const A = await panel([{ id: 501, name: 'Zero (2026)', len: 86 * 60 }, { id: 502, name: 'Lone (2025)', len: 62 * 60 }]);
  const B = await panel([{ id: 9001, name: 'Zero (2026)', len: 135 * 60 + 20 }]);
  const t = await fakeTmdb();
  const port = await freePort();
  const app = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: path.join(dir, 'data'), NO_RESPAWN: '1', SITE_PASSWORD: 'pw-test', TMDB_BASE: t.base, TMDB_IMG_BASE: 'http://img.test/' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', cookie = '';
  app.stdout.on('data', (d) => { out += d; });
  app.stderr.on('data', (d) => { out += d; });
  const api = async (method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'X-App': '1', 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const txt = await r.text(); let j = null; try { j = JSON.parse(txt); } catch {}
    return { status: r.status, body: j };
  };
  try {
    for (let i = 0; i < 300 && !/Ready/.test(out); i++) await wait(100);
    assert.match(out, /Ready/, out.slice(-500));
    await api('POST', '/api/login', { password: 'pw-test' });
    await api('POST', '/api/profiles', { name: 'Alex', pin: '4821' });
    for (const [name, p] of [['A', A], ['B', B]]) assert.strictEqual((await api('POST', '/api/admin/lists', { type: 'xtream', name, server: p.url, username: 'u', password: 'p' })).status, 200);
    let zero, lone;
    for (let i = 0; i < 150 && !(zero && zero.a && zero.a.length && lone); i++) {
      const cat = (await api('GET', '/api/catalog')).body;
      zero = cat && cat.items && cat.items.find((x) => x.t === 'movie' && /Zero/.test(x.n));
      lone = cat && cat.items && cat.items.find((x) => x.t === 'movie' && /Lone/.test(x.n));
      if (!(zero && zero.a && zero.a.length && lone)) await wait(200);
    }
    assert.ok(zero && zero.a && zero.a.length === 1, 'one title, two copies: ' + JSON.stringify(zero));
    assert.strictEqual((await api('PUT', '/api/admin/settings', { tmdbKey: 'testkey' })).status, 200);

    // Its page: matched, and the copies looked up (each provider once).
    let fit;
    for (let i = 0; i < 60; i++) {
      await api('GET', `/api/item/${encodeURIComponent(zero.k)}`);
      fit = (await api('GET', `/api/title/${encodeURIComponent(zero.k)}/fit`)).body;
      if (fit && fit.tmdb && fit.copies.every((c) => c.len)) break;
      await wait(250);
    }
    assert.ok(fit && fit.tmdb, JSON.stringify(fit) + out.slice(-800));
    assert.deepStrictEqual([fit.tmdb.title, fit.tmdb.d, fit.level, fit.tol], ['Zero', 8100, 'ok', 2]);
    const byLen = Object.fromEntries(fit.copies.map((c) => [c.len, c.cls]));
    assert.deepStrictEqual(byLen, { 5160: 'off', 8120: 'match' });
    assert.deepStrictEqual([A.asked.includes(501), B.asked.includes(9001)], [true, true]);

    // Playing it: provider B's copy (the backup in list order) goes first.
    const src = (await api('POST', '/api/play/sources', { k: zero.k, origin: `http://127.0.0.1:${port}` })).body;
    assert.strictEqual(src.sources[0].fit.cls, 'match', JSON.stringify(src.sources));
    assert.strictEqual(src.sources[1].fit.cls, 'off');
    assert.ok(src.sources[1].fit.s >= 3.5);

    // "Lone": its only copy runs 62 minutes, TMDB's 110 — the page says its details may be wrong.
    let lf;
    for (let i = 0; i < 60; i++) {
      await api('GET', `/api/item/${encodeURIComponent(lone.k)}`);
      lf = (await api('GET', `/api/title/${encodeURIComponent(lone.k)}/fit`)).body;
      if (lf && lf.tmdb && lf.level) break;
      await wait(250);
    }
    assert.strictEqual(lf.level, 'warn', JSON.stringify(lf));
    assert.match(lf.reasons[0], /TMDB’s “Lone” \(2025\) runs 1 h 50 min, but the copy here runs 1 h 2 min/);
    // A player saw it run 110 minutes after all (the provider's info was wrong): that counts for more.
    assert.strictEqual((await api('POST', '/api/play/length', { k: lone.k, alt: -1, d: 110 * 60 + 5 })).body.ok, true);
    lf = (await api('GET', `/api/title/${encodeURIComponent(lone.k)}/fit`)).body;
    assert.deepStrictEqual([lf.level, lf.copies[0].real, lf.copies[0].cls], ['ok', true, 'match']);

    // The TMDB checks: provider A's 86-minute copy of "Zero" is the other "Zero" (2025, 86 min) — a title of its own.
    assert.strictEqual((await api('POST', '/api/admin/tmdb/fixes', {})).status, 200);
    let zs = [];
    for (let i = 0; i < 80; i++) {
      const cat = (await api('GET', '/api/catalog')).body;
      zs = ((cat && cat.items) || []).filter((x) => x.t === 'movie' && /Zero/.test(x.n));
      if (zs.length === 2) break;
      await wait(250);
    }
    assert.strictEqual(zs.length, 2, 'two titles now: ' + JSON.stringify(zs) + out.slice(-600));
    assert.deepStrictEqual(zs.map((x) => x.y).sort(), [2025, 2026]);
    assert.ok(zs.every((x) => !(x.a && x.a.length)), 'a copy each');
    const fx = (await api('GET', '/api/admin/tmdb/fixes')).body.list.find((f) => f.why === 'copy');
    assert.deepStrictEqual([fx.to.id, fx.to.y, fx.from.id], [99, 2025, 77]);
    // Undo: back together.
    assert.strictEqual((await api('POST', `/api/admin/tmdb/fixes/${fx.id}/undo`, {})).status, 200);
    for (let i = 0; i < 80; i++) {
      const cat = (await api('GET', '/api/catalog')).body;
      zs = ((cat && cat.items) || []).filter((x) => x.t === 'movie' && /Zero/.test(x.n));
      if (zs.length === 1) break;
      await wait(250);
    }
    assert.strictEqual(zs.length, 1);

    // The admin's tolerance: half the copies' minutes off is still "off"; ten minutes makes 62-vs-110 no closer.
    assert.strictEqual((await api('PUT', '/api/admin/settings', { lengthTolerance: 99 })).status, 200);
    assert.strictEqual((await api('GET', '/api/admin/tmdb/fixes')).body.tol, 10, 'kept between 1 and 10 minutes');
  } finally {
    app.kill(); A.close(); B.close(); t.close();
    await wait(300);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
