'use strict';
// TMDB matches put right in the background (lib/tmdbfix.js): against a pretend TMDB.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { TmdbFixes, run, evidence } = require('../lib/tmdbfix');
const { sameTitle } = require('../lib/titles');
const { ownYear, yearConflict } = require('../lib/tmdb');

/** A pretend TMDB: answers by path; every request counted. */
function fakeTmdb(answers, map = {}, meta = {}) {
  const asked = [];
  return {
    asked,
    map: { data: { m: map }, save() {} },
    meta: { data: { m: meta }, save() {} },
    async get(p, params) {
      asked.push(p + (params && (params.year || params.first_air_date_year) ? '?y' : ''));
      const a = answers[p];
      return typeof a === 'function' ? a(params) : a || { results: [] };
    },
  };
}
const show = (id, name, year, cast) => ({ id, name, first_air_date: `${year}-01-01`, credits: { cast: cast.map((n) => ({ name: n })) } });
const film = (id, title, year, runtime, cast = []) => ({ id, title, release_date: `${year}-05-01`, runtime, credits: { cast: cast.map((n) => ({ name: n })) } });

function withFixes(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmdbfix-'));
  const fixes = new TmdbFixes(dir);
  return Promise.resolve(fn(fixes)).finally(() => { fixes.store.flush(true); fs.rmSync(dir, { recursive: true, force: true }); });
}
const deps = (tmdb, fixes, extra = {}) => ({ tmdb, fixes, same: sameTitle, ownYear, conflict: (it, y) => yearConflict(it, y), ...extra });

const RU = ['Ivan Stebunov', 'Sergey Kristovsky', 'Mikhail Bespalov', 'Olga Lomonosova'];
const US = ['David Denman', 'Nelson Franklin', 'Kris Marshall', 'Liza Lapira'];

test('a series matched to a namesake with another cast moves to the one whose cast is the provider’s', () => withFixes(async (fixes) => {
  const it = { k: 'S1', t: 'show', n: 'Traffic Light', y: 2011, cast: RU.join(', ') };
  const tmdb = fakeTmdb({
    '/search/tv': { results: [{ id: 100, name: 'Traffic Light' }, { id: 200, name: 'Traffic Light' }, { id: 300, name: 'Traffic Lights of Love' }] },
    '/tv/200': show(200, 'Traffic Light', 2011, RU),
  }, { S1: { id: 100, type: 'tv' } }, { S1: { tmdb: 100, title: 'Traffic Light', y: 2011, cast: US.join(', ') } });
  const r = await run([it], deps(tmdb, fixes));
  assert.strictEqual(r.fixed, 1);
  assert.deepStrictEqual(tmdb.map.data.m.S1, { id: 200, type: 'tv', vf: 'cast', rc: 1 });
  assert.strictEqual(tmdb.meta.data.m.S1, undefined, 'the wrong details go');
  assert.ok(!tmdb.asked.includes('/tv/300'), 'another name isn’t a candidate');
  const f = fixes.list[0];
  assert.strictEqual(f.why, 'cast');
  assert.deepStrictEqual([f.from.id, f.to.id, f.to.y], [100, 200, 2011]);
  // Corrected once: not checked again (nor ping-ponged back).
  tmdb.meta.data.m.S1 = { tmdb: 200, title: 'Traffic Light', y: 2011, cast: RU.join(', ') };
  tmdb.asked.length = 0;
  assert.strictEqual((await run([it], deps(tmdb, fixes))).asked, 0);
}));

test('nothing that fits: the match stays, and TMDB isn’t asked again until the evidence changes', () => withFixes(async (fixes) => {
  const it = { k: 'S2', t: 'show', n: 'Transformers: Armada', y: 2002, cast: 'Kirby Morrow, Brian Drummond, Garry Chalk, David Kaye' };
  const tmdb = fakeTmdb({ '/search/tv': { results: [{ id: 1, name: 'Transformers: Armada' }] } }, { S2: { id: 1, type: 'tv' } }, { S2: { tmdb: 1, title: 'Transformers: Armada', y: 2002, cast: 'Kenji Nojima, Mayumi Iizuka, Daisuke Gori, Kenichi Ogata' } });
  const r = await run([it], deps(tmdb, fixes));
  assert.deepStrictEqual([r.asked, r.fixed], [1, 0]);
  assert.deepStrictEqual(tmdb.map.data.m.S2, { id: 1, type: 'tv' });
  tmdb.asked.length = 0;
  assert.strictEqual((await run([it], deps(tmdb, fixes))).asked, 0);
  assert.strictEqual(tmdb.asked.length, 0);
  it.cast += ', Someone New';
  assert.strictEqual((await run([it], deps(tmdb, fixes))).asked, 1, 'new evidence: asked again');
}));

test('a match picked by hand, one with no evidence of the provider’s own, and one that agrees are left alone', () => withFixes(async (fixes) => {
  const items = [
    { k: 'A', t: 'show', n: 'Traffic Light', y: 2011, cast: RU.join(', ') },
    { k: 'B', t: 'show', n: 'Traffic Light', y: 2011, cast: US.join(', ') }, // (TMDB's own cast, put on by applyMeta)
    { k: 'C', t: 'show', n: 'Traffic Light', y: 2011, cast: US.slice(0, 3).join(', ') + ', Someone' },
  ];
  const m = { tmdb: 100, title: 'Traffic Light', y: 2011, cast: US.join(', ') };
  const tmdb = fakeTmdb({}, { A: { id: 100, type: 'tv', manual: 1 }, B: { id: 100, type: 'tv' }, C: { id: 100, type: 'tv' } }, { A: m, B: m, C: m });
  const r = await run(items, deps(tmdb, fixes));
  assert.deepStrictEqual([r.checked, r.asked, r.fixed], [3, 0, 0]);
  assert.strictEqual(tmdb.asked.length, 0);
}));

test('the provider’s own TMDB number, given after the name was looked up: taken when it’s this title', () => withFixes(async (fixes) => {
  const items = [
    { k: 'M1', t: 'movie', n: 'Work It', y: 2020, tmdb: '612706' },
    { k: 'M2', t: 'movie', n: 'Fall', y: 2022, tmdb: '1000' }, // (the number of another film)
  ];
  const tmdb = fakeTmdb({
    '/movie/612706': film(612706, 'Work It', 2020, 93),
    '/movie/1000': film(1000, 'Fall 2: Deadpoint', 2026, 100),
  }, { M1: { id: 55, type: 'movie' }, M2: { id: 985939, type: 'movie' } }, {
    M1: { tmdb: 55, title: 'For Man Must Work or the Fantastic Voyage', y: 2020, d: 4800 },
    M2: { tmdb: 985939, title: 'Fall', y: 2022, d: 6420 },
  });
  const r = await run(items, deps(tmdb, fixes));
  assert.strictEqual(r.fixed, 1);
  assert.deepStrictEqual(tmdb.map.data.m.M1, { id: 612706, type: 'movie', vf: 'list', rc: 1, list: 1 });
  assert.deepStrictEqual(tmdb.map.data.m.M2, { id: 985939, type: 'movie' });
  assert.strictEqual(fixes.list[0].why, 'list');
}));

test('a film whose file runs far from TMDB’s length moves to the entry of that name that runs as long', () => withFixes(async (fixes) => {
  const it = { k: 'G', t: 'movie', n: 'The Gate', y: 0, d: 0 };
  const tmdb = fakeTmdb({
    '/search/movie': { results: [{ id: 1, title: 'The Gate' }, { id: 2, title: 'The Gate' }] },
    '/movie/2': film(2, 'The Gate', 1987, 83),
  }, { G: { id: 1, type: 'movie' } }, { G: { tmdb: 1, title: 'The Gate', y: 2016, d: 140 * 60 } });
  // Nobody has watched it: nothing to go by.
  assert.strictEqual((await run([it], deps(tmdb, fixes))).asked, 0);
  // Watched: the file runs 82 minutes.
  const r = await run([it], deps(tmdb, fixes, { realLength: (k) => (k === 'G' ? 82 * 60 : 0) }));
  assert.strictEqual(r.fixed, 1);
  assert.strictEqual(tmdb.map.data.m.G.id, 2);
  assert.strictEqual(fixes.list[0].why, 'length');
}));

test('the evidence is only the provider’s own', () => {
  const d = { cast: 'A Person, B Person', d: 5400 };
  assert.deepStrictEqual(evidence({ t: 'movie', n: 'X (2001)', y: 2001, cast: 'A Person, B Person', d: 5400 }, d, 2001, 0), { name: 'X', year: 2001, cast: '', length: 0, tol: 120 });
  assert.deepStrictEqual(evidence({ t: 'movie', n: 'X', cast: 'C Person', d: 95 }, d, 0, 0), { name: 'X', year: 0, cast: 'C Person', length: 5700, tol: 120 });
  assert.strictEqual(evidence({ t: 'movie', n: 'X', d: 95 }, d, 0, 4000).length, 4000, 'the real length first');
  assert.strictEqual(evidence({ t: 'show', n: 'X', d: 95 }, d, 0, 4000).length, 0, 'not for a series');
});

test('the provider’s number isn’t taken over a match that fits better', () => withFixes(async (fixes) => {
  // "BLAME!" (2017) matched to itself; the provider's number is "Blame" (2018), another film.
  const it = { k: 'B', t: 'movie', n: 'BLAME!', y: 2017, tmdb: '500' };
  const tmdb = fakeTmdb({ '/movie/500': film(500, 'Blame', 2018, 100) }, { B: { id: 9, type: 'movie' } }, { B: { tmdb: 9, title: 'BLAME!', y: 2017, d: 6360 } });
  const r = await run([it], deps(tmdb, fixes));
  assert.deepStrictEqual([r.asked, r.fixed], [1, 0]);
  assert.strictEqual(tmdb.map.data.m.B.id, 9);
}));

test('one copy of many is no evidence for the title — and a correction a rule no longer allows is put back', () => withFixes(async (fixes) => {
  // "The Odyssey" (2026): 21 copies of the 173-minute film, the first an 86-minute namesake (the provider's number is
  // the namesake's, and someone watched that copy).
  const it = { k: 'O', t: 'movie', n: 'The Odyssey', y: 2026, tmdb: '1698863', d: 0, alts: Array.from({ length: 20 }, (_, i) => ({ u: 'x' + i })) };
  const meta = { O: { tmdb: 1368337, title: 'The Odyssey', y: 2026, d: 173 * 60 } };
  const tmdb = fakeTmdb({ '/movie/1698863': film(1698863, 'The Odyssey', 2026, 86) }, { O: { id: 1368337, type: 'movie' } }, meta);
  const r = await run([it], deps(tmdb, fixes, { realLength: () => 86 * 60 }));
  assert.strictEqual(r.fixed, 0);
  assert.strictEqual(tmdb.map.data.m.O.id, 1368337);
  assert.ok(!tmdb.asked.length, 'a match already of this name and year: the namesake’s number isn’t even looked up');
  // A correction made before (the namesake's number taken): put back, and not checked again.
  tmdb.map.data.m.O = { id: 1698863, type: 'movie', vf: 'list', rc: 1, list: 1 };
  tmdb.meta.data.m.O = { tmdb: 1698863, title: 'The Odyssey', y: 2026, d: 86 * 60 };
  const id = fixes.add({ k: 'O', n: 'The Odyssey', t: 'movie', y: 2026, why: 'list', at: 1, from: { id: 1368337, type: 'movie', title: 'The Odyssey', y: 2026 }, to: { id: 1698863, type: 'movie', title: 'The Odyssey', y: 2026 } });
  const keep = fixes.add({ k: 'W', n: 'Wonder', t: 'movie', y: 2017, why: 'list', at: 1, from: { id: 297762, type: 'movie', title: 'Wonder Woman', y: 2017 }, to: { id: 406997, type: 'movie', title: 'Wonder', y: 2017 } });
  tmdb.map.data.m.W = { id: 406997, type: 'movie', vf: 'list', rc: 1, list: 1 };
  const r2 = await run([it, { k: 'W', t: 'movie', n: 'Wonder', y: 2017 }], deps(tmdb, fixes));
  assert.strictEqual(r2.putBack, 1);
  assert.deepStrictEqual(tmdb.map.data.m.O, { id: 1368337, type: 'movie', vf: 'kept', rc: 1 });
  assert.strictEqual(tmdb.meta.data.m.O, undefined);
  assert.ok(fixes.get(id).undone && fixes.get(id).auto);
  assert.strictEqual(tmdb.map.data.m.W.id, 406997, '“Wonder” (not “Wonder Woman”) stays corrected');
  assert.ok(!fixes.get(keep).undone);
  assert.strictEqual((await run([it], deps(tmdb, fixes))).putBack, 0, 'only once');
}));

test('the copies’ own lengths and TMDB numbers: what most of them say, not one of them', () => withFixes(async (fixes) => {
  // "Brother" (2003) matched to "Brother Bear" (85 min): its three copies run 120 minutes and their providers say 996569.
  const it = { k: 'BR', t: 'movie', n: 'Brother', y: 2003, alts: [{ u: 'a' }, { u: 'b' }] };
  const copies = [{ len: 7200, tmdb: 996569 }, { len: 7210, tmdb: 996569 }, { len: 7190, tmdb: 0 }];
  const tmdb = fakeTmdb({ '/movie/996569': film(996569, 'Brother', 2003, 120) }, { BR: { id: 10009, type: 'movie' } }, { BR: { tmdb: 10009, title: 'Brother Bear', y: 2003, d: 85 * 60 } });
  const r = await run([it], deps(tmdb, fixes, { copies: () => copies }));
  assert.strictEqual(r.fixed, 1);
  assert.strictEqual(tmdb.map.data.m.BR.id, 996569);
  // "The Odyssey": 20 copies run 173 minutes, 2 run 86 (and say the namesake's number): the match stays, nothing asked.
  const od = { k: 'OD', t: 'movie', n: 'The Odyssey', y: 2026, alts: Array.from({ length: 21 }, () => ({ u: 'x' })) };
  const ocopies = Array.from({ length: 20 }, () => ({ len: 10380, tmdb: 1368337 })).concat([{ len: 5163, tmdb: 1698863 }, { len: 5170, tmdb: 1698863 }]);
  const t2 = fakeTmdb({}, { OD: { id: 1368337, type: 'movie' } }, { OD: { tmdb: 1368337, title: 'The Odyssey', y: 2026, d: 10380 } });
  const r2 = await run([od], deps(t2, fixes, { copies: () => ocopies }));
  assert.deepStrictEqual([r2.asked, r2.fixed], [0, 0]);
}));
