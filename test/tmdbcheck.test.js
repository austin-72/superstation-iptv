'use strict';
// Checking a TMDB match against what the provider says (lib/tmdbcheck.js): the cast, the length, the year and the
// title. The examples are real ones from a household's lists.
const test = require('node:test');
const assert = require('node:assert');
const C = require('../lib/tmdbcheck');
const { sameTitle } = require('../lib/titles');

test('cast names, however the provider wrote them', () => {
  assert.deepStrictEqual(C.castNames('Ving Rhames, LisaRaye McCoy / Clifton Powell'), ['ving rhames', 'lisaraye mccoy', 'clifton powell']);
  assert.deepStrictEqual(C.castNames('Penélope Cruz; Javier Bardem'), ['penelope cruz', 'javier bardem']);
  // In another order, run together, with accents: all found.
  assert.strictEqual(C.castAgree('Liu Yuxuan, Zhang Ruonan', ['Yuxuan Liu', 'Ruonan Zhang']).found, 2);
  assert.strictEqual(C.castAgree('Jessica BardenHarry Lawtey', ['Jessica Barden', 'Harry Lawtey']).found, 2);
  assert.strictEqual(C.castAgree('Penelope Cruz', ['Penélope Cruz']).found, 1);
  // "Jr." and short words don't decide anything; a name of short words only isn't counted.
  assert.deepStrictEqual(C.castAgree('Robert Downey, Gwyneth Paltrow', ['Robert Downey Jr.', 'Bo Li']), { found: 1, of: 1, given: 2 });
});

test('the verdict: yes, no, or too little to say', () => {
  // "Whose Line Is It Anyway?" — the 2013 revival's cast against the 1988 original's.
  const revival = 'Aisha Tyler, Wayne Brady, Colin Mochrie, Ryan Stiles';
  assert.strictEqual(C.castVerdict(revival, ['Aisha Tyler', 'Ryan Stiles', 'Colin Mochrie', 'Wayne Brady']), 'yes');
  assert.strictEqual(C.castVerdict(revival, ['Clive Anderson', 'Tony Slattery', 'Josie Lawrence', 'Paul Merton']), 'no');
  // One in common out of one or two: yes. One of many: can't say.
  assert.strictEqual(C.castVerdict('Paul Mescal', ['Paul Mescal', 'Daisy Edgar-Jones', 'Sarah Greene']), 'yes');
  assert.strictEqual(C.castVerdict('A Bee, Cee Dee, Eff Gee, Aitch Eye', ['Aitch Eye', 'Jay Kay', 'Ell Emm', 'Enn Oh']), '');
  // Too few names to say no.
  assert.strictEqual(C.castVerdict('Ann Smith, Bob Jones', ['Cat Brown', 'Dan Green', 'Eve White']), '');
  assert.strictEqual(C.castVerdict('', ['Cat Brown']), '');
});

test('lengths: within two minutes (or a PAL copy’s 4% shorter) yes, more than 15% off no; minutes where seconds go', () => {
  assert.strictEqual(C.lengthVerdict(6840, 6840), 'yes');
  assert.strictEqual(C.lengthVerdict(6840 + 100, 6840), 'yes');
  assert.strictEqual(C.lengthVerdict(6840 + 300, 6840), '', 'five minutes off: not the same length, not another film either');
  assert.strictEqual(C.lengthVerdict(6840 + 60, 6840, 30), '', 'the admin’s half a minute');
  assert.strictEqual(C.lengthVerdict(Math.round(6840 * 24 / 25), 6840), 'yes', 'a PAL copy runs 4% shorter');
  assert.strictEqual(C.lengthVerdict(6840 * 1.3, 6840), 'no');
  assert.strictEqual(C.lengthVerdict(1500, 5400), 'no', 'a 25-minute file against a 90-minute film');
  assert.strictEqual(C.lengthVerdict(0, 5400), '');
  // The Goonies: "114" from the provider, 114 minutes on TMDB.
  assert.strictEqual(C.providerLength(114, 114 * 60), 6840);
  assert.strictEqual(C.providerLength(6840, 114 * 60), 6840);
  assert.strictEqual(C.providerLength(90, 0), 0, 'too short to be a film, and nothing to say it’s minutes');
});

const same = sameTitle;
const tv = (id, title, year, cast) => ({ id, title, year, cast });

test('a namesake with another cast is switched for the one whose cast agrees', () => {
  // "Traffic Light" (Russian, 2011) matched to the American one of the same year.
  const ev = { name: 'Traffic Light', year: 2011, cast: 'Ivan Stebunov, Dmitry Shevchenko, Sergey Kristovsky, Mikhail Bespalov' };
  const cur = tv(1, 'Traffic Light', 2011, ['David Denman', 'Nelson Franklin', 'Kris Marshall', 'Liza Lapira']);
  const right = tv(2, 'Traffic Light', 2011, ['Ivan Stebunov', 'Sergey Kristovsky', 'Mikhail Bespalov', 'Olga Lomonosova']);
  const b = C.better(ev, cur, [cur, right], same);
  assert.ok(b);
  assert.strictEqual(b.id, 2);
  assert.strictEqual(b.why, 'cast');
  assert.strictEqual(b.was.cast, 'no');
});

test('a contradicted match stays when no candidate clearly fits — an English dub’s cast against the Japanese one', () => {
  const ev = { name: 'Transformers: Armada', year: 2002, cast: 'Kirby Morrow, Brian Drummond, Garry Chalk, David Kaye' };
  const cur = tv(1, 'Transformers: Armada', 2002, ['Kenji Nojima', 'Mayumi Iizuka', 'Daisuke Gōri', 'Kenichi Ogata']);
  assert.strictEqual(C.contradicted(C.fit(ev, cur, same)), 'cast');
  // Another series of the same name, but not this cast either: nothing to switch to.
  const other = tv(3, 'Transformers: Armada', 2003, ['Someone Else', 'Another Person', 'Third Actor']);
  assert.strictEqual(C.better(ev, cur, [cur, other], same), null);
});

test('a candidate needs the same title, a year that fits, and a clear lead', () => {
  const ev = { name: 'Muppet Babies', year: 1984, cast: 'Greg Berg, Laurie O’Brien, Frank Welker, Howie Mandel' };
  const cur = tv(1, 'Muppet Babies', 2018, ['Matt Danner', 'Jenny Slate', 'Ben Diskin', 'Dee Bradley Baker']);
  const right = tv(2, 'Muppet Babies', 1984, ['Frank Welker', 'Greg Berg', 'Laurie O’Brien', 'Howie Mandel']);
  assert.strictEqual(C.better(ev, cur, [right], same).id, 2);
  // The right cast under another title: not taken.
  assert.strictEqual(C.better(ev, cur, [{ ...right, title: 'Jim Henson’s Puppets' }], same), null);
  // Years off the provider's: not taken.
  assert.strictEqual(C.better(ev, cur, [{ ...right, year: 1991 }], same), null);
  // Its original title is enough.
  assert.strictEqual(C.better(ev, cur, [{ ...right, title: 'Los Muppet Babies', otitle: 'Muppet Babies' }], same).id, 2);
});

test('a match the evidence agrees with is never switched', () => {
  const ev = { name: 'The Bridge', year: 2011, cast: 'Sofia Helin, Kim Bodnia, Dag Malmberg' };
  const cur = tv(1, 'The Bridge', 2011, ['Sofia Helin', 'Kim Bodnia', 'Dag Malmberg', 'Sarah Boberg']);
  assert.strictEqual(C.contradicted(C.fit(ev, cur, same)), '');
  assert.strictEqual(C.better(ev, cur, [tv(2, 'The Bridge', 2011, ['Sofia Helin', 'Kim Bodnia', 'Dag Malmberg'])], same), null);
});

test('the length: a film that runs far longer or shorter than TMDB’s entry, and one of the same name that fits', () => {
  // "I.T." (2016, 95 min) matched to "It" (2017, 135 min): the file runs 95 minutes, the entry of that name as long.
  const ev = { name: 'I.T.', year: 0, length: 95 * 60 };
  const cur = { id: 1, title: 'It', year: 2017, runtime: 135 * 60 };
  assert.strictEqual(C.contradicted(C.fit(ev, cur, same)), 'length');
  assert.strictEqual(C.better(ev, cur, [{ id: 2, title: 'I.T.', year: 2016, runtime: 95 * 60 }], same).id, 2);
  // Ten minutes longer (8%): a longer cut, maybe — nothing said either way.
  assert.strictEqual(C.contradicted(C.fit({ name: 'It', year: 2017, length: 145 * 60 }, cur, same)), '');
  const ev2 = { name: 'The Gate', year: 0, length: 80 * 60 };
  const cur2 = { id: 1, title: 'The Gate', year: 2016, runtime: 140 * 60 };
  const right2 = { id: 2, title: 'The Gate', year: 1987, runtime: 81 * 60 };
  assert.strictEqual(C.contradicted(C.fit(ev2, cur2, same)), 'length');
  assert.strictEqual(C.better(ev2, cur2, [right2], same).id, 2);
  // The length alone never beats a cast that agrees.
  const ev3 = { ...ev2, cast: 'Stephen Dorff, Christa Denton, Louis Tripp' };
  const cur3 = { ...cur2, cast: ['Stephen Dorff', 'Christa Denton', 'Louis Tripp'] };
  assert.strictEqual(C.contradicted(C.fit(ev3, cur3, same)), '');
});

test('a match by another name from another year: the one entry with this name from the provider’s year', () => {
  const ev = { name: 'Hamilton', year: 2020 };
  const cur = { id: 1, title: 'Bethany Hamilton: Unstoppable', year: 2019 };
  const right = { id: 2, title: 'Hamilton', year: 2020 };
  assert.ok(C.misnamed(C.fit(ev, cur, same), ev));
  assert.strictEqual(C.renamed(ev, cur, [right, { id: 3, title: 'Hamilton', year: 2025 }], same).id, 2);
  assert.strictEqual(C.renamed(ev, cur, [right, { id: 4, title: 'Hamilton', year: 2020 }], same), null, 'two of them: can’t tell');
  // Another name, but the provider's year: a special's longer name ("Liza Treyger: Night Owl"), left.
  assert.ok(!C.misnamed(C.fit({ name: 'Night Owl', year: 2025 }, { id: 5, title: 'Liza Treyger: Night Owl', year: 2025 }, same), { name: 'Night Owl', year: 2025 }));
  // No year from the provider: left.
  assert.ok(!C.misnamed(C.fit({ name: 'Hamilton', year: 0 }, cur, same), { name: 'Hamilton', year: 0 }));
});
