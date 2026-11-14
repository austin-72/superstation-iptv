'use strict';
// How the stream relay handles films and episodes, as the admin sets it (Admin → Stream relay → Films and episodes):
// sent by the server (signed), kept on the relay's disk, and followed — just passing films on, fetching only so far
// ahead, a speed limit, finishing a download nobody's watching, films kept across a restart, clearing the disk.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { relayUrl, relayCfg, relayWire, pushRelaySettings, clearRelay, testRelay, makeRelay } = require('../lib/streamrelay');

const SECRET = 'test-secret-0123456789abcdef';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });

async function startRelay(env) {
  const port = await freePort();
  const p = spawn(process.execPath, [path.join(__dirname, '..', 'relay', 'relay.js')], { env: { ...process.env, RELAY_SECRET: SECRET, PORT: String(port), RELAY_ALLOW_PRIVATE: '1', RELAY_TICK_MS: '100', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { out += d; });
  for (let i = 0; i < 60 && !/Stream relay/.test(out); i++) await wait(50);
  assert.match(out, /Stream relay/, out);
  return { p, base: `http://127.0.0.1:${port}`, out: () => out, stop: () => new Promise((ok) => { p.once('exit', ok); p.kill(); }) };
}
/** A provider of films (with ranges), `rate` bytes a second (0: as fast as it can). */
async function provider(size, rate) {
  const BIG = crypto.randomBytes(size);
  const asked = [];
  let open = 0;
  const srv = http.createServer((req, res) => {
    asked.push(req.url + ' ' + (req.headers.range || ''));
    open++; res.on('close', () => open--);
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    const a = m ? +m[1] : 0, b = m && m[2] ? +m[2] : size - 1;
    res.writeHead(m ? 206 : 200, { 'Content-Type': 'video/mp4', 'Content-Length': b - a + 1, ...(m ? { 'Content-Range': `bytes ${a}-${b}/${size}` } : {}) });
    let p = a;
    const step = () => { if (res.destroyed) return; if (p > b) return res.end(); const n = Math.min(64 * 1024, b - p + 1); res.write(BIG.subarray(p, p + n)); p += n; if (rate) setTimeout(step, (n / rate) * 1000); else setImmediate(step); };
    step();
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  return { BIG, asked, srv, base: `http://127.0.0.1:${srv.address().port}`, open: () => open };
}
const signed = (base, what, extra = '') => { const t = String(Math.floor(Date.now() / 1000)); return `${base}/${what.split(':')[0]}?${extra}t=${t}&s=${crypto.createHmac('sha256', SECRET).update(what + ':' + t).digest('base64url').slice(0, 32)}`; };
const downloads = async (base) => (await fetch(signed(base, 'downloads:', ''))).json();
const setRelay = (base, cfg) => pushRelaySettings(base, SECRET, relayWire({ cfg }), fetch);

test('the server’s side: the admin’s choices made safe, the relay’s units, and which titles go on its disk', () => {
  assert.deepStrictEqual(relayCfg({}), { mode: 'disk', films: true, episodes: true, ahead: 0, back: 10, keepH: 6, idle: 2, cacheGB: 0, freeGB: 5, speed: 0 }, 'as it has always worked');
  const c = relayCfg({ cfg: { mode: 'pass', ahead: -5, back: -1, keepH: 99999, idle: 0, speed: 'x', cacheGB: 40 } });
  assert.strictEqual(c.mode, 'pass');
  assert.strictEqual(c.ahead, 0);
  assert.strictEqual(c.back, -1);
  assert.strictEqual(c.keepH, 2160, 'at most 90 days');
  assert.strictEqual(c.idle, 0.5, 'at least 30 seconds');
  assert.strictEqual(c.speed, 0);
  const w = relayWire({ cfg: { ahead: 10, back: -1, keepH: 24, idle: -1, speed: 40 } });
  assert.deepStrictEqual(w.cfg, { mode: 'disk', ahead: 600, back: -1, keep: 86400000, idle: -1, cacheGB: 0, freeGB: 5, speed: 40 });
  assert.match(w.tag, /^[0-9a-f]{16}$/);
  assert.notStrictEqual(w.tag, relayWire({}).tag);
  let S = { relay: { url: 'http://r', secret: 's', all: true, cfg: { films: true, episodes: false } } };
  const r = makeRelay({ getSettings: () => S, listOf: () => ({}) });
  assert.strictEqual(r.diskFor('movie'), true);
  assert.strictEqual(r.diskFor('episode'), false, 'episodes just passed on');
  assert.strictEqual(r.diskFor('live'), false);
  S = { relay: { ...S.relay, cfg: { mode: 'pass' } } };
  assert.strictEqual(r.diskFor('movie'), false);
});

test('settings reach the relay only signed, are kept on its disk, and survive a restart', { timeout: 30000 }, async () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-set-'));
  let r = await startRelay({ RELAY_CACHE_DIR: cache });
  try {
    // Unsigned, or signed with another secret: refused.
    assert.strictEqual((await fetch(`${r.base}/settings?c=e30&t=1&s=x`)).status, 403);
    assert.strictEqual((await pushRelaySettings(r.base, 'another-secret-0123456789', relayWire({}), fetch)).ok, false);
    const res = await setRelay(r.base, { mode: 'disk', ahead: 20, keepH: 72, cacheGB: 30 });
    assert.strictEqual(res.ok, true, JSON.stringify(res));
    assert.strictEqual(res.disk.limit, 30e9);
    const saved = JSON.parse(fs.readFileSync(path.join(cache, 'relay-settings.json'), 'utf8'));
    assert.strictEqual(saved.cfg.ahead, 1200);
    assert.strictEqual(saved.cfg.keep, 72 * 3600e3);
    const want = relayWire({ cfg: { mode: 'disk', ahead: 20, keepH: 72, cacheGB: 30 } }).tag;
    assert.strictEqual((await testRelay(r.base, SECRET, fetch)).cfg, want, 'the check says which settings it has');
    await r.stop();
    r = await startRelay({ RELAY_CACHE_DIR: cache });
    const t = await testRelay(r.base, SECRET, fetch);
    assert.strictEqual(t.cfg, want, 'still the same after a restart');
    assert.strictEqual(t.disk.limit, 30e9);
    assert.strictEqual(String(t.version), '8');
  } finally { await r.stop(); fs.rmSync(cache, { recursive: true, force: true }); }
});

test('just passing films on: nothing on the relay’s disk, every request goes to the provider', { timeout: 30000 }, async () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-pass-'));
  const pv = await provider(3 * 1024 * 1024, 0);
  const r = await startRelay({ RELAY_CACHE_DIR: cache });
  try {
    assert.strictEqual((await setRelay(r.base, { mode: 'pass' })).ok, true);
    const u = relayUrl(r.base, SECRET, pv.base + '/film.mp4', {}, 600, { w: 1, i: 'f1' });
    const a = await fetch(u, { headers: { Range: 'bytes=100-199' } });
    assert.strictEqual(a.status, 206);
    assert.ok(Buffer.from(await a.arrayBuffer()).equals(pv.BIG.subarray(100, 200)));
    const b = await fetch(u, { headers: { Range: 'bytes=1000-1099' } });
    assert.ok(Buffer.from(await b.arrayBuffer()).equals(pv.BIG.subarray(1000, 1100)));
    assert.deepStrictEqual(pv.asked.map((x) => x.split(' ')[1]), ['bytes=100-199', 'bytes=1000-1099'], 'each asked of the provider as it came');
    assert.deepStrictEqual((await downloads(r.base)).films, [], 'no film on the disk');
    assert.deepStrictEqual(fs.readdirSync(cache).filter((f) => /\.bin$/.test(f)), []);
  } finally { await r.stop(); pv.srv.close(); fs.rmSync(cache, { recursive: true, force: true }); }
});

test('fetching only so far ahead, and a speed limit per film', { timeout: 60000 }, async () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-ahead-'));
  const SIZE = 24 * 1024 * 1024;
  const pv = await provider(SIZE, 0);
  const r = await startRelay({ RELAY_CACHE_DIR: cache });
  try {
    // A 24 MB film of 240 s: 100 KB a second, so 1 minute ahead is about 6 MB.
    assert.strictEqual((await setRelay(r.base, { ahead: 1 })).ok, true);
    const u = relayUrl(r.base, SECRET, pv.base + '/a.mp4', {}, 600, { w: 1, i: 'a1', d: 240 });
    // A viewer who reads the start and then holds on (a paused player).
    const held = await new Promise((ok) => { const rq = http.get(u, (res) => { res.once('data', () => { res.pause(); ok({ rq, res }); }); }); });
    await wait(2500);
    let d = await downloads(r.base);
    const f = d.films.find((x) => x.ids.includes('a1'));
    assert.ok(f, JSON.stringify(d));
    assert.ok(f.here < 12 * 1024 * 1024, `fetched only about a minute ahead, not all of it (${(f.here / 1048576).toFixed(1)} MB here)`);
    assert.strictEqual(f.downloading, false, 'and stopped there');
    held.rq.destroy();
    // A speed limit: 16 Mbit/s is 2 MB a second, so 6 MB takes about 3 s (as fast as it can: well under a second).
    assert.strictEqual((await setRelay(r.base, { speed: 16 })).ok, true);
    const u2 = relayUrl(r.base, SECRET, pv.base + '/b.mp4', {}, 600, { w: 1, i: 'b1', d: 60 });
    const t0 = Date.now();
    const x = await fetch(u2, { headers: { Range: `bytes=0-${6 * 1024 * 1024 - 1}` } });
    const buf = Buffer.from(await x.arrayBuffer());
    assert.ok(buf.equals(pv.BIG.subarray(0, 6 * 1024 * 1024)));
    const took = Date.now() - t0;
    assert.ok(took > 2200, `slowed to the limit (${took} ms)`);
  } finally { await r.stop(); pv.srv.close(); fs.rmSync(cache, { recursive: true, force: true }); }
});

test('finishing a film nobody’s watching; whole films kept after a restart; clearing the disk', { timeout: 60000 }, async () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-keep-'));
  const SIZE = 6 * 1024 * 1024 + 777;
  const pv = await provider(SIZE, 4 * 1024 * 1024);
  let r = await startRelay({ RELAY_CACHE_DIR: cache });
  try {
    assert.strictEqual((await setRelay(r.base, { idle: -1, keepH: 24 })).ok, true);
    const u = relayUrl(r.base, SECRET, pv.base + '/c.mp4', {}, 600, { w: 1, i: 'c1', d: 60 });
    // Only the first bit is watched, then the viewer leaves: it's finished anyway (and the server saying it isn't
    // playing any more doesn't stop it).
    const x = await fetch(u, { headers: { Range: 'bytes=0-9999' } });
    await x.arrayBuffer();
    await fetch(signed(r.base, 'downloads:', 'playing=&'));
    let f;
    for (let i = 0; i < 60; i++) { f = (await downloads(r.base)).films.find((y) => y.ids.includes('c1')); if (f && f.done) break; await wait(150); }
    assert.ok(f && f.done, 'finished with nobody watching: ' + JSON.stringify(f));
    assert.ok(fs.existsSync(path.join(cache, fs.readdirSync(cache).find((n) => /^[0-9a-f]{32}\.json$/.test(n)) || 'none')), 'noted as whole');
    // A restart: still there, and played without asking the provider.
    await r.stop();
    r = await startRelay({ RELAY_CACHE_DIR: cache });
    assert.match(r.out(), /1 film kept from before the restart/);
    const n = pv.asked.length;
    const u2 = relayUrl(r.base, SECRET, pv.base + '/c.mp4', {}, 600, { w: 1, i: 'c1', d: 60 }); // (the relay's new port)
    const y = await fetch(u2, { headers: { Range: 'bytes=3000000-3099999' } });
    assert.ok(Buffer.from(await y.arrayBuffer()).equals(pv.BIG.subarray(3000000, 3100000)));
    assert.strictEqual(pv.asked.length, n, 'from the relay’s disk');
    assert.strictEqual((await testRelay(r.base, SECRET, fetch)).disk.whole, 1);
    // Clearing the disk: it goes (and leftovers with it).
    assert.strictEqual((await fetch(`${r.base}/clear?t=1&s=x`)).status, 403);
    const c = await clearRelay(r.base, SECRET, fetch);
    assert.strictEqual(c.ok, true);
    assert.strictEqual(c.removed, 1);
    assert.ok(c.bytes >= SIZE - 1024 * 1024);
    assert.strictEqual(c.disk.films, 0);
    assert.deepStrictEqual(fs.readdirSync(cache).filter((n2) => /^[0-9a-f]{32}/.test(n2)), []);
  } catch (e) { e.message += '\n' + r.out().slice(-1500); throw e; } finally { await r.stop(); pv.srv.close(); fs.rmSync(cache, { recursive: true, force: true }); }
});
