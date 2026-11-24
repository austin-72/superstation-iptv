'use strict';
// Each copy's length against TMDB's (lib/copyfit.js). The examples are from a household's lists.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const F = require('../lib/copyfit');
const { sameTitle } = require('../lib/titles');

test('a copy’s length, from its provider’s film info', () => {
  // "A Goofy Movie": the provider's scan of the file says 01:17:40; duration_secs says "78" (minutes).
  assert.strictEqual(F.copyLength({ duration: '01:17:40', duration_secs: '78', runtime: '78' }), 4660);
  assert.strictEqual(F.copyLength({ video: { duration: '4660.704000' } }), 4661);
  assert.strictEqual(F.copyLength({ duration_secs: '6840' }), 6840);
  assert.strictEqual(F.copyLength({ duration_secs: '78', runtime: '78' }), 0, 'minutes, not the file’s length: nothing known');
  assert.strictEqual(F.copyLength({}), 0);
  assert.deepStrictEqual(F.factsOf({ duration: '02:00:00', tmdb_id: '996569', releasedate: '2003-06-01', cast: 'A, B' }), { len: 7200, tmdb: 996569, y: 2003, cast: 'A, B' });
});

test('against TMDB’s running time: match within the admin’s minutes, short, near, off', () => {
  const T = 78 * 60;
  assert.strictEqual(F.classify(4660, T), 'match', '20 s off');
  assert.strictEqual(F.classify(T + 110, T), 'match');
  assert.strictEqual(F.classify(T + 110, T, 60), 'near', 'the admin’s one minute');
  assert.strictEqual(F.classify(Math.round(T * 24 / 25), T), 'match', 'a PAL copy: 4% shorter');
  assert.strictEqual(F.classify(120, 111 * 60), 'short', '“Kill Bill: Vol. 1”, a 2-minute file');
  assert.strictEqual(F.classify(62 * 60, T), 'off', '“A Goofy Movie”, 62 minutes');
  assert.strictEqual(F.classify(113 * 60, 77 * 60), 'off', '“Peter Pan” (1953): the 2003 film');
  assert.strictEqual(F.classify(T + 6 * 60, T), 'near');
  assert.strictEqual(F.classify(25 * 60, 81 * 60), 'off', 'a 25-minute file against an 81-minute film: something else, not a clip');
  assert.strictEqual(F.classify(0, T), '');
  assert.strictEqual(F.classify(T, 0), '');
});

test('copies in order: the same length first, nothing known next, the others last', () => {
  const match = { id: 1368337, y: 2026 };
  const s = (f) => F.copyScore(f, match);
  const same = s({ cls: 'match', tmdb: 1368337 }), unknown = s({ cls: '' }), near = s({ cls: 'near' });
  const namesake = s({ cls: 'off', tmdb: 1698863 }), clip = s({ cls: 'short' });
  assert.ok(same < unknown && unknown < near && near < F.WRONG);
  assert.ok(namesake >= F.WRONG && clip >= F.WRONG);
  // The provider's number and cast count where the length isn't known.
  assert.ok(s({ cls: '', tmdb: 1368337, castV: 'yes' }) < unknown);
  assert.ok(s({ cls: '', castV: 'no', tmdb: 5 }) >= F.WRONG);
  // A copy that runs as long as TMDB's entry isn't put back for a provider's wrong number.
  assert.strictEqual(s({ cls: 'match', tmdb: 5 }), 0);
});

test('what the copies agree a film runs', () => {
  // "The Odyssey": 20 run 173 minutes, 2 run 86 — one runs as long as TMDB's entry, so that's it.
  const od = Array(20).fill(10380).concat([5163, 5170]);
  assert.strictEqual(F.consensus(od, 10380), 10380);
  // "Brother" (2003), matched to "Brother Bear" (85 min): its copies run 120.
  assert.strictEqual(F.consensus([7200, 7210, 7190], 85 * 60), 7200);
  // Split down the middle, none TMDB's: nothing to go by.
  assert.strictEqual(F.consensus([5000, 5010, 7200, 7210], 6000), 0);
  assert.strictEqual(F.consensus([], 6000), 0);
  assert.strictEqual(F.idConsensus([996569, 996569, 0, 5]), 996569);
  assert.strictEqual(F.idConsensus([1, 2]), 0);
});

test('a title page says its details may be wrong when nothing fits', () => {
  const m = { title: 'Godzilla Minus Zero', y: 2026, d: 135 * 60, cast: 'Ryunosuke Kamiki, Minami Hamabe, Yuki Yamada' };
  const film = (copies) => F.verdict({ kind: 'movie', name: 'Zero', year: 2026 }, m, copies, sameTitle);
  // "Zero" (2026): its copy runs 86 minutes.
  const v = film([{ len: 86 * 60, cls: F.classify(86 * 60, m.d) }]);
  assert.strictEqual(v.level, 'warn');
  assert.match(v.reasons[0], /runs 2 h 15 min, but the copy here runs 1 h 26 min/);
  // One copy that runs as long: fine (the others are played after it).
  assert.strictEqual(film([{ len: 86 * 60, cls: 'off' }, { len: m.d, cls: 'match' }]).level, 'ok');
  // Nothing known: nothing said.
  assert.strictEqual(film([{ len: 0, cls: '' }]).level, '');
  // A 2-minute file (a trailer, a broken copy) says nothing about the details; nor a copy a few minutes off.
  assert.strictEqual(film([{ len: 120, cls: 'short' }]).level, '');
  assert.strictEqual(film([{ len: m.d + 300, cls: 'near' }]).level, '');
  assert.strictEqual(film([{ len: m.d + 300, cls: 'near' }, { len: 86 * 60, cls: 'off' }]).level, '', 'one near and one off: likely the film, and one wrong copy');
  // Picked by hand: the household's word.
  assert.strictEqual(F.verdict({ kind: 'movie', name: 'Zero', year: 2026, manual: true }, m, [{ len: 86 * 60, cls: 'off' }], sameTitle).level, '');
  // The cast: none of the copies' casts are TMDB's.
  assert.strictEqual(film([{ len: 0, cls: '', castV: 'no' }]).level, 'warn');
  // Another name from another year ("Hamilton" (2020) matched to "Bethany Hamilton: Unstoppable" (2019)).
  const h = F.verdict({ kind: 'movie', name: 'Hamilton', year: 2020 }, { title: 'Bethany Hamilton: Unstoppable', y: 2018, d: 0 }, [], sameTitle);
  assert.strictEqual(h.level, 'warn');
  // A series: the provider's cast against TMDB's.
  const s = F.verdict({ kind: 'show', name: 'Traffic Light', year: 2011, cast: 'Ivan Stebunov, Sergey Kristovsky, Mikhail Bespalov' }, { title: 'Traffic Light', y: 2011, cast: 'David Denman, Nelson Franklin, Kris Marshall, Liza Lapira' }, [], sameTitle);
  assert.strictEqual(s.level, 'warn');
  assert.match(s.reasons[0], /cast/);
});

test('what players saw a copy run is kept', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copylens-'));
  try {
    const l = new F.CopyLens(dir);
    assert.strictEqual(l.get('A:m:1'), 0);
    assert.ok(l.set('A:m:1', 6000.4));
    assert.strictEqual(l.get('A:m:1'), 6000);
    assert.strictEqual(l.set('A:m:1', 6001), false, 'the same, give or take a second');
    assert.strictEqual(l.set('A:m:2', 30), false, 'not a film’s length');
    l.s._flushSync();
    clearTimeout(l.s._timer);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
