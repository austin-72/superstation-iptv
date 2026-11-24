'use strict';
// Is each copy of a film the film its TMDB details are for? Most providers' film info says how long the file itself
// runs (their own scan of it: "duration": "01:17:40"), and — in a household's lists — 88% of copies run within two
// minutes of TMDB's running time, most within one. A copy that doesn't is another film of the same name, another cut,
// a trailer or a broken file. So: copies are played closest to TMDB's length first, a title none of whose copies
// match says on its page that its details may be wrong, and the TMDB checks (lib/tmdbfix.js) go by what the copies
// agree on. Players also say how long a copy really ran (CopyLens), which counts for more than the provider's word.
const path = require('path');
const { ShardedJson } = require('./store');
const C = require('./tmdbcheck');

const hms = (x) => { const m = /^(\d+):(\d\d):(\d\d)/.exec(String(x || '')); return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : 0; };

/**
 * How long a copy's file runs, from the provider's film info (get_vod_info): its "duration" (HH:MM:SS, from the file),
 * the video stream's own, or duration_secs (some send minutes there: "78" for 78 minutes, told apart by the others).
 */
function copyLength(info) {
  if (!info) return 0;
  const d = hms(info.duration);
  if (d > 30) return d;
  const v = parseFloat((info.video || {}).duration) || 0;
  if (v > 30 && v < 12 * 3600) return Math.round(v);
  const s = parseInt(info.duration_secs, 10) || 0;
  const run = parseInt(info.runtime, 10) || 0; // (TMDB's minutes, copied by the provider)
  if (s > 0 && s < 400 && run && Math.abs(s - run) <= 2) return 0; // (minutes, not the file's: nothing known)
  return s > 120 ? s : 0;
}

/** What a provider's film info says about the copy: its length, the TMDB entry it says it is, its year, its cast. */
function factsOf(info) {
  if (!info) return null;
  return {
    len: copyLength(info),
    tmdb: /^\d+$/.test(String(info.tmdb_id || '').trim()) ? Number(info.tmdb_id) : 0,
    y: parseInt(String(info.releasedate || info.releaseDate || '').slice(0, 4), 10) || 0,
    cast: String(info.cast || info.actors || '').slice(0, 400),
  };
}

/**
 * A copy's length against TMDB's (seconds; tol: how close counts as the same, in seconds):
 * 'match' within tol (or as much shorter as a PAL copy runs: 24/25), 'short' (a clip, trailer or broken file),
 * 'near' (within 15%: another cut, or a few minutes of something), 'off' (another film), '' (not known).
 */
function classify(len, tmdbSecs, tol = 120) {
  if (!(len > 0) || !(tmdbSecs > 0)) return '';
  if (Math.abs(len - tmdbSecs) <= tol || Math.abs(len - tmdbSecs * 24 / 25) <= tol) return 'match';
  if (len < 600 && tmdbSecs > 1200) return 'short'; // (under ten minutes, for a film: a trailer, a clip, a broken file)
  const r = len / tmdbSecs;
  return r >= 0.85 && r <= 1.15 ? 'near' : 'off';
}

/**
 * How likely a copy is the film TMDB's details are for, lower is better: about 0 it is, 1 nothing known, 2 doubtful,
 * 4 and over it's something else (played only after the others). f: { cls, tmdb (the provider's number for it), y,
 * castV ('yes'|'no'|'') }; match: { id (the title's TMDB entry), y }.
 */
function copyScore(f, match) {
  let s = 1;
  const cls = f.cls || '';
  if (cls === 'match') s = 0;
  else if (cls === 'near') s = 2;
  else if (cls === 'off' || cls === 'short') s = 4;
  if (f.tmdb && match && match.id) s += String(f.tmdb) === String(match.id) ? -0.5 : (cls === 'match' ? 0 : 1.5);
  if (f.castV === 'yes') s -= 0.5; else if (f.castV === 'no' && cls !== 'match') s += 2;
  if (f.y && match && match.y && Math.abs(f.y - match.y) > 1 && cls !== 'match') s += 1;
  return Math.max(0, s);
}
const WRONG = 3.5; // (a score from here: something else)

/**
 * What the copies agree a film runs, for the TMDB checks: a length one of them shares with TMDB's entry (then the match
 * is right), or the length most of them run (60% or more, within tol of each other), or 0 (too few, or they disagree).
 */
function consensus(lens, tmdbSecs, tol = 120) {
  const ls = lens.filter((x) => x > 0);
  if (!ls.length) return 0;
  const hit = tmdbSecs > 0 && ls.find((x) => classify(x, tmdbSecs, tol) === 'match');
  if (hit) return hit;
  const sorted = ls.slice().sort((a, b) => a - b), mid = sorted[sorted.length >> 1];
  const near = ls.filter((x) => Math.abs(x - mid) <= tol).length;
  return near / ls.length >= 0.6 ? mid : 0;
}

/** The TMDB number most of the copies say they are (60% or more of those that say), or 0. */
function idConsensus(ids) {
  const xs = ids.filter((x) => x > 0);
  if (!xs.length) return 0;
  const n = new Map();
  for (const x of xs) n.set(x, (n.get(x) || 0) + 1);
  const [best, c] = [...n].sort((a, b) => b[1] - a[1])[0];
  return c / xs.length >= 0.6 ? best : 0;
}

const fmt = (s) => { const m = Math.round(s / 60); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`; };

/**
 * Does a title fit its TMDB details? → { level: 'ok' | 'warn' | '' (can't tell), reasons: [text] }.
 * t: { kind ('movie'|'show'), name, year (the provider's), cast (the provider's, a series'), manual (picked by hand) };
 * m: TMDB's { title, ot (original title), y, d (seconds), cast }; copies: [{ len, cls, castV }]; same: titles.sameTitle.
 */
function verdict(t, m, copies, same, tol = 120) {
  if (!m || t.manual) return { level: '', reasons: [] };
  const reasons = [];
  let good = 0;
  const film = t.kind === 'movie';
  const what = `TMDB’s “${m.title}”${m.y ? ` (${m.y})` : ''}`;
  // The length: none of the copies whose length is known runs anywhere near as long as TMDB's entry. (A trailer or a
  // broken file of a few minutes says nothing about the details — only that copy is wrong, and it's played last. One
  // a few minutes off is likely the film with other credits, or another edition: it's played after the exact ones.)
  const known = film ? copies.filter((c) => c.len > 0 && c.cls !== 'short') : [];
  if (known.length && m.d > 0) {
    if (known.some((c) => c.cls === 'match')) good++;
    else if (known.every((c) => c.cls === 'off')) {
      const ls = [...new Set(known.map((c) => fmt(c.len)))].slice(0, 3);
      reasons.push(`${what} runs ${fmt(m.d)}, but ${known.length > 1 ? 'the copies here run ' + ls.join(', ') : 'the copy here runs ' + ls[0]}.`);
    }
  }
  // The cast: the provider's names for it, against TMDB's.
  const castVs = film ? copies.map((c) => c.castV).filter(Boolean) : [t.cast && m.cast ? C.castVerdict(t.cast, String(m.cast).split(/\s*,\s*/)) : ''].filter(Boolean);
  if (castVs.includes('yes')) good++;
  else if (castVs.length && castVs.every((v) => v === 'no')) reasons.push(`The cast the provider lists isn’t the cast of ${what}.`);
  // The name and year: another title, from another year.
  const nm = String(t.name || '').replace(/\s*\((19|20)\d{2}\)\s*$/, '').trim();
  const sameName = same(nm, 0, m.title || '', 0) || (m.ot && same(nm, 0, m.ot, 0));
  if (!sameName && t.year && m.y && Math.abs(t.year - m.y) > 1) reasons.push(`${what} has another name and year than “${nm}” (${t.year}).`);
  if (reasons.length) return { level: 'warn', reasons };
  return { level: good ? 'ok' : '', reasons };
}

/** What players saw a copy run (seconds), by copy: from a real play, it counts for more than the provider's word. */
class CopyLens {
  constructor(dataDir) { this.s = new ShardedJson(path.join(dataDir, 'copy-lens'), { delay: 30000 }); }
  get(id) { const r = this.s.data.m[id]; return r && r.r > 0 ? r.r : 0; }
  set(id, secs) {
    if (!id || !(secs > 60) || secs > 12 * 3600) return false;
    const r = this.s.data.m[id];
    if (r && Math.abs(r.r - secs) < 2) return false;
    this.s.data.m[id] = { r: Math.round(secs), at: Date.now() };
    this.s.touch(id);
    return true;
  }
}

module.exports = { copyLength, factsOf, classify, copyScore, WRONG, consensus, idConsensus, verdict, fmt, CopyLens };
