'use strict';
// Checking a title's TMDB match against what the provider says about it — and finding the right entry when it's
// clearly another one. The evidence: the provider's own TMDB number, its cast (every series has one in the provider's
// list; a film once its details are opened), the film's length (the provider's, or the real one, from watching it),
// and its year. A name search can land on a namesake: "Whose Line Is It Anyway?" (the 2013 revival) on the 1988
// original, "Traffic Light" (Russian, 2011) on the American one of the same year, "I.T." on "It". The cast or the
// provider's number says which it really is. (Pure functions: lib/tmdbcheck.js run() in server.js does the asking.)

const STOP = new Set(['jr', 'sr', 'ii', 'iii', 'van', 'von', 'der', 'den', 'del', 'des', 'les', 'mac', 'the', 'and', 'dos', 'das', 'bin', 'ibn', 'mrs', 'ms']);
const plain = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');

/** A cast as the provider wrote it, as names: "Ving Rhames, LisaRaye McCoy / …" → ['ving rhames', …]. */
function castNames(s) {
  return plain(s).split(/\s*(?:[,;/|•·]|\s-\s|\sand\s|\n)\s*/).map((x) => x.replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()).filter((x) => x.length >= 3);
}

/**
 * How many of TMDB's cast are in the provider's cast — however the provider wrote them: in another order ("Yuxuan
 * Liu" / "Liu Yuxuan"), run together ("Jessica BardenHarry Lawtey"), with or without accents. A name counts when every
 * word of it of three letters or more (at least one; "Akira 100" → "akira") is in the provider's cast.
 * → { found, of (TMDB's names looked at), given (the provider's names) }
 */
function castAgree(providerCast, tmdbCast, max = 10) {
  const squash = plain(providerCast).replace(/[^a-z0-9]+/g, '');
  const given = castNames(providerCast).length;
  const names = (Array.isArray(tmdbCast) ? tmdbCast : castNames(tmdbCast)).map((n) => plain(n)).slice(0, max);
  let found = 0, of = 0;
  for (const n of names) {
    const words = n.replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length >= 3 && !STOP.has(w));
    if (!words.length) continue;
    of++;
    if (words.every((w) => squash.includes(w))) found++;
  }
  return { found, of, given };
}

/**
 * Do the casts say it's the same title? 'yes' (two or more in common, or the only one or two there are), 'no' (none
 * in common, with three or more on each side), or '' (too little to say).
 */
function castVerdict(providerCast, tmdbCast) {
  const a = castAgree(providerCast, tmdbCast);
  if (!a.given || !a.of) return '';
  if (a.found >= 2 || (a.found >= 1 && (a.given <= 2 || a.of <= 2))) return 'yes';
  if (a.found === 0 && a.given >= 3 && a.of >= 3) return 'no';
  return '';
}

/**
 * Does a length agree with TMDB's running time? 'yes' within tol seconds (two minutes unless the admin says otherwise;
 * or as much shorter as a PAL copy runs, 24/25), 'no' when it's over 15% off (another film, or a cut of it), ''
 * between or unknown. (Providers' scans of their files run within a minute of TMDB's time for most films.)
 */
function lengthVerdict(real, tmdbSeconds, tol = 120) {
  if (!(real > 60) || !(tmdbSeconds > 60)) return '';
  if (Math.abs(real - tmdbSeconds) <= tol || Math.abs(real - tmdbSeconds * 24 / 25) <= tol) return 'yes';
  const r = real / tmdbSeconds;
  if (r < 0.85 || r > 1.15) return 'no';
  return '';
}

/**
 * A provider's length in seconds, made sense of: some give minutes where seconds go ("114" for The Goonies) — then,
 * when TMDB's time is known and it's sixty times that, it's minutes.
 */
function providerLength(secs, tmdbSeconds) {
  const s = Number(secs) || 0;
  if (!(s > 0)) return 0;
  if (tmdbSeconds > 600 && s < 400 && Math.abs(s * 60 - tmdbSeconds) / tmdbSeconds < 0.25) return s * 60;
  return s < 120 ? 0 : s; // (two minutes or less: not a film's length)
}

/**
 * How well a TMDB entry fits what the provider says. ev: { name, year (the provider's), cast, length (seconds) };
 * c: { title, otitle, year, cast (names), runtime (seconds) }; same(name, year, title, titleYear): titles.sameTitle.
 * (ev.tol: how close a length must be, in seconds; two minutes if not given.)
 * → { score, cast ('yes'|'no'|''), length, title (true: the same title), year ('yes'|'near'|'no'|'') }
 */
function fit(ev, c, same) {
  const castV = ev.cast && c.cast && c.cast.length ? castVerdict(ev.cast, c.cast) : '';
  const lenV = ev.length && c.runtime ? lengthVerdict(ev.length, c.runtime, ev.tol || 120) : '';
  const title = !!(same(ev.name, 0, c.title || '', 0) || (c.otitle && same(ev.name, 0, c.otitle, 0)));
  const yearV = !ev.year || !c.year ? '' : ev.year === c.year ? 'yes' : Math.abs(ev.year - c.year) <= 1 ? 'near' : 'no';
  let score = 0;
  if (castV) score += castV === 'yes' ? 10 + Math.min(5, castAgree(ev.cast, c.cast).found) : -12;
  if (lenV) score += lenV === 'yes' ? 6 : -8;
  score += title ? 4 : -2;
  if (yearV) score += yearV === 'yes' ? 4 : yearV === 'near' ? 2 : -6;
  return { score, cast: castV, length: lenV, title, year: yearV };
}

/**
 * Is the current match clearly wrong, given the evidence? Only on solid ground: the cast says no, or the length
 * says no while nothing else says yes. → the reason ('cast', 'length') or ''.
 */
function contradicted(f) {
  if (f.cast === 'no') return 'cast';
  if (f.length === 'no' && f.cast !== 'yes') return 'length';
  return '';
}

/**
 * The candidate to switch to, if one clearly fits better: what contradicted the current match must be put right by
 * it (the cast agrees, or the length does), its title must be this one's, its year can't be years off the
 * provider's, and it must beat the current match by a clear margin. → the candidate or null.
 */
function better(ev, cur, cands, same) {
  const fc = fit(ev, cur, same);
  const why = contradicted(fc);
  if (!why) return null;
  let best = null;
  for (const c of cands) {
    if (String(c.id) === String(cur.id)) continue;
    const f = fit(ev, c, same);
    if (!f.title || f.year === 'no') continue;
    if (why === 'cast' && f.cast !== 'yes') continue;
    if (why === 'length' && (f.length !== 'yes' || f.cast === 'no')) continue;
    if (f.score < fc.score + 8) continue;
    if (!best || f.score > best.f.score) best = { c, f };
  }
  return best ? { ...best.c, why, fit: best.f, was: fc } : null;
}

/**
 * A match by another name in another year: the name search took something else ("Hamilton" (2020), the stage show,
 * matched to "Bethany Hamilton: Unstoppable" (2019)). Only when the provider gives a year, and nothing else (the cast,
 * the length) says the match is right.
 */
function misnamed(f, ev) {
  return !f.title && !!ev.year && f.year !== 'yes' && f.cast !== 'yes' && f.length !== 'yes';
}

/**
 * For a misnamed match: the one entry with this title from the provider's very year (none of the evidence against
 * it). Two of them, or none: nothing. → the candidate or null.
 */
function renamed(ev, cur, cands, same) {
  const fc = fit(ev, cur, same);
  if (!misnamed(fc, ev)) return null;
  const ok = [];
  for (const c of cands) {
    if (String(c.id) === String(cur.id)) continue;
    const f = fit(ev, c, same);
    if (f.title && f.year === 'yes' && f.cast !== 'no' && f.length !== 'no') ok.push({ c, f });
  }
  return ok.length === 1 ? { ...ok[0].c, why: 'title', fit: ok[0].f, was: fc } : null;
}

module.exports = { castNames, castAgree, castVerdict, lengthVerdict, providerLength, fit, contradicted, better, misnamed, renamed };
