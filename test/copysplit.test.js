'use strict';
// Copies of a title that are another film of the same name become titles of their own (lib/copysplit.js), and the
// catalogue builds them so (lib/catalog.js: copySplit).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { CopySplits, run } = require('../lib/copysplit');
const { TmdbFixes } = require('../lib/tmdbfix');
const { Catalog } = require('../lib/catalog');
const { copyId } = require('../lib/badcopies');
const { sameTitle } = require('../lib/titles');

const film = (id, title, year, runtime, cast = []) => ({ id, title, release_date: `${year}-05-01`, runtime, credits: { cast: cast.map((n) => ({ name: n })) } });
function fakeTmdb(answers) {
  const asked = [];
  return { asked, async get(p, q) { asked.push(p + (q && q.query ? '?' + q.query : '')); const a = answers[p]; return a || { results: [] }; } };
}
function withDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copysplit-'));
  const splits = new CopySplits(dir), fixes = new TmdbFixes(dir);
  return Promise.resolve(fn(splits, fixes)).finally(() => { splits.store.flush(true); fixes.store.flush(true); fs.rmSync(dir, { recursive: true, force: true }); });
}

test('the copies that are another film of the same name: their provider’s TMDB number, or the one entry that runs as long', () => withDir(async (splits, fixes) => {
  // "The Odyssey" (2026): 20 copies run 173 minutes (TMDB's), 2 run 86 and their provider says they're 1698863.
  const od = { k: 'OD', t: 'movie', n: 'The Odyssey', y: 2026, alts: Array(21).fill({}) };
  const odCopies = Array.from({ length: 20 }, (_, i) => ({ copy: 'A:m:' + i, len: 10380, cls: 'match', tmdb: 1368337 }))
    .concat([{ copy: 'B:m:1', len: 5163, cls: 'off', tmdb: 1698863 }, { copy: 'C:m:2', len: 5170, cls: 'off', tmdb: 1698863 }]);
  // "Peter Pan" (1953, 77 min): a copy runs 113 minutes and says nothing of what it is — the 2003 film does.
  const pp = { k: 'PP', t: 'movie', n: 'Peter Pan', y: 1953, alts: [{}] };
  const ppCopies = [{ copy: 'A:m:50', len: 4620, cls: 'match' }, { copy: 'D:m:51', len: 6802, cls: 'off', tmdb: 0 }];
  // "Twins": two other entries of that name run as long as the odd copy — can't tell which: left.
  const tw = { k: 'TW', t: 'movie', n: 'Twins', y: 1988, alts: [{}] };
  const twCopies = [{ copy: 'A:m:60', len: 6420, cls: 'match' }, { copy: 'E:m:61', len: 5400, cls: 'off' }];
  // "Zed": no copy runs as long as its entry — the whole match is in question, not one copy (lib/tmdbfix.js).
  const zd = { k: 'ZD', t: 'movie', n: 'Zed', y: 2020, alts: [{}] };
  const zdCopies = [{ copy: 'A:m:70', len: 5000, cls: 'off' }, { copy: 'A:m:71', len: 5010, cls: 'off' }];
  const meta = { OD: { tmdb: 1368337, title: 'The Odyssey', y: 2026, d: 10380 }, PP: { tmdb: 10693, title: 'Peter Pan', y: 1953, d: 4620 }, TW: { tmdb: 9493, title: 'Twins', y: 1988, d: 6420 }, ZD: { tmdb: 5, title: 'Zed', y: 2020, d: 7000 } };
  const copies = { OD: odCopies, PP: ppCopies, TW: twCopies, ZD: zdCopies };
  const tmdb = fakeTmdb({
    '/movie/1698863': film(1698863, 'The Odyssey', 2026, 86),
    '/search/movie': null,
    '/movie/10693': film(10693, 'Peter Pan', 1953, 77),
    '/movie/10601': film(10601, 'Peter Pan', 2003, 113),
    '/movie/71': film(71, 'Twins', 2001, 90), '/movie/72': film(72, 'Twins', 2015, 90),
  });
  tmdb.get = ((orig) => async (p, q) => {
    if (p === '/search/movie') { tmdb.asked.push(p + '?' + q.query); return { results: q.query === 'Peter Pan' ? [{ id: 10693, title: 'Peter Pan' }, { id: 10601, title: 'Peter Pan' }] : q.query === 'Twins' ? [{ id: 71, title: 'Twins' }, { id: 72, title: 'Twins' }] : [] }; }
    return orig(p, q);
  })(tmdb.get);
  const deps = { tmdb, same: sameTitle, splits, fixes, meta: (it) => meta[it.k], copies: (it) => copies[it.k] };
  const r = await run([od, pp, tw, zd], deps);
  assert.deepStrictEqual([r.checked, r.split], [3, 3]);
  assert.deepStrictEqual(splits.of('B:m:1'), { ...splits.of('B:m:1'), id: 1698863, y: 2026, t: 'The Odyssey' });
  assert.strictEqual(splits.of('C:m:2').id, 1698863);
  assert.deepStrictEqual([splits.of('D:m:51').id, splits.of('D:m:51').y], [10601, 2003]);
  assert.strictEqual(splits.of('E:m:61'), null, 'two of them run as long: can’t tell');
  assert.strictEqual(splits.of('A:m:3'), null, 'a copy that runs as long stays');
  assert.ok(!tmdb.asked.some((a) => /Zed/.test(a)), 'no copy bears the match out: left to the TMDB checks');
  assert.strictEqual(fixes.list.filter((f) => f.why === 'copy').length, 3);
  // Asked once: not again till what's known about the copy changes.
  tmdb.asked.length = 0;
  await run([od, pp, tw, zd], deps);
  assert.strictEqual(tmdb.asked.length, 0);
  // Undone: back, and never split off again.
  splits.off('D:m:51');
  assert.strictEqual(splits.of('D:m:51'), null);
  assert.strictEqual((await run([pp], deps)).split, 0);
}));

test('the catalogue: a split-off copy is a title of its own, as that film', () => {
  const mv = (name, list, id) => ({ name, type: 'movie', url: `http://${list.toLowerCase()}.example/movie/u/p/${id}.mp4`, group: 'Films' });
  const parsed = new Map([
    ['A', { items: [mv('The Odyssey (2026)', 'A', 1), mv('Peter Pan (1953)', 'A', 2), mv('Peter Pan (2003)', 'A', 3)], epgUrls: [] }],
    ['B', { items: [mv('The Odyssey (2026)', 'B', 11), mv('Peter Pan (1953)', 'B', 12)], epgUrls: [] }],
  ]);
  const c = new Catalog({ lists: { all: () => [{ id: 'A', name: 'A', enabled: true, type: 'm3u' }, { id: 'B', name: 'B', enabled: true, type: 'm3u' }], parsed }, epg: { has: () => false, resolve: () => null }, getSettings: () => ({ tidyGroups: true, groupRules: [], hiddenGroups: [], hiddenKeys: [] }) });
  c.build();
  const films = () => c.items.filter((x) => x.t === 'movie');
  assert.strictEqual(films().length, 3, 'The Odyssey, and the two Peter Pans');
  const sp = new Map([[copyId('B', 'movie', 'http://b.example/movie/u/p/11.mp4'), { id: 1698863, y: 2026, t: 'The Odyssey' }], [copyId('B', 'movie', 'http://b.example/movie/u/p/12.mp4'), { id: 10601, y: 2003, t: 'Peter Pan' }]]);
  c.copySplit = (l, t, u) => sp.get(copyId(l, t, u)) || null;
  c.build();
  const ods = films().filter((x) => /Odyssey/.test(x.n));
  assert.strictEqual(ods.length, 2, 'a namesake of the same year: apart');
  const nk = ods.find((x) => x.tmdb === '1698863');
  assert.ok(nk && !nk.alts, 'B’s copy, on its own');
  assert.ok(!ods.find((x) => x !== nk).alts, 'and A’s on its own');
  const pp53 = films().find((x) => /Peter Pan/.test(x.n) && x.y === 1953), pp03 = films().find((x) => /Peter Pan/.test(x.n) && x.y === 2003);
  assert.ok(!pp53.alts, 'the 1953 film keeps only its own copy');
  assert.strictEqual((pp03.alts || []).length, 1, 'the 2003 film has its copy and the one taken for the 1953 film');
});
