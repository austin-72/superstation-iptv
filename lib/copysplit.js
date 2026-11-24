'use strict';
// Copies of a title that are another film of the same name: "The Odyssey" (2026) with 20 copies of the 2 h 53 min film
// and 2 that run 86 minutes (another "The Odyssey", whose TMDB number their provider gives), "Peter Pan" (1953) with a
// copy of the 2003 film. When some copies of a title run as long as its TMDB entry and others clearly don't (by
// length, or the provider's cast), TMDB is asked what the others are — their provider's TMDB number, or the one entry
// of that name that runs as long and whose cast isn't another's — and each becomes a title of its own, as that film
// (lib/catalog.js: copySplit). Listed in Admin → Recommendations → Corrected matches, with Undo.
const path = require('path');
const crypto = require('crypto');
const { JsonFile } = require('./store');
const C = require('./tmdbcheck');
const { candidateOf } = require('./tmdbfix');

const APPEND = 'credits,release_dates,keywords,watch/providers'; // (as Tmdb.details asks for a film: one cached answer)

class CopySplits {
  constructor(dataDir) {
    this.store = new JsonFile(path.join(dataDir, 'copy-splits.json'), { s: {}, ck: {} });
    const d = this.store.data;
    if (!d.s || typeof d.s !== 'object') d.s = {};
    if (!d.ck || typeof d.ck !== 'object') d.ck = {};
  }
  /** The film a copy is instead, if it's been found to be another: { id, y, t } (copy: badcopies.copyId). */
  of(copy) { const x = this.store.data.s[copy]; return x && !x.off ? x : null; }
  has(copy) { return !!this.store.data.s[copy]; }
  add(copy, x) { this.store.data.s[copy] = { ...x, at: Date.now() }; this.store.save(); }
  /** Undone: the copy goes back to its title, and isn't split off again. */
  off(copy) { const x = this.store.data.s[copy]; if (x) { x.off = 1; this.store.save(); } return x; }
  checked(copy) { return this.store.data.ck[copy] || ''; }
  setChecked(copy, sig) { this.store.data.ck[copy] = sig; this.store.save(); }
  /** A fingerprint of what's split off (for knowing the catalogue has to be built again). */
  sig() { return crypto.createHash('sha1').update(Object.keys(this.store.data.s).filter((k) => !this.store.data.s[k].off).sort().join(',')).digest('hex').slice(0, 12); }
}

/**
 * Goes through films with several copies; splits off the copies that are another film.
 * deps: { tmdb (.get), same (titles.sameTitle), tol (seconds), splits (CopySplits), fixes (TmdbFixes, to list them),
 *         copies (it) → [{ alt, copy (copyId), len, cls, s, tmdb, cast }], meta (it) → its TMDB details or null,
 *         stop () → true to stop, status }
 * → { checked, asked, split }
 */
async function run(items, deps) {
  const { tmdb, same, splits, fixes } = deps;
  const tol = deps.tol || 120, stop = deps.stop || (() => false), st = deps.status || {};
  const get = async (p, params) => { try { return await tmdb.get(p, params); } catch { return null; } };
  const sameName = (name, c) => !!c && (same(name, 0, c.title, 0) || (!!c.otitle && same(name, 0, c.otitle, 0)));
  st.splitChecked = 0; st.splitAsked = 0; st.split = 0;
  let n = 0;
  for (const it of items) {
    if (++n % 300 === 0) await new Promise((r) => setImmediate(r));
    if (stop()) break;
    if (it.t !== 'movie' || !(it.alts && it.alts.length)) continue;
    const m = deps.meta(it);
    if (!m || !(m.d > 0)) continue;
    const fs = deps.copies(it);
    // (Only when the title's match is borne out by a copy that runs as long: then the odd ones are the odd ones.)
    if (!fs.some((f) => f.cls === 'match')) continue;
    st.splitChecked++;
    const odd = fs.filter((f) => f.copy && !splits.has(f.copy) && f.len > 0 && (f.cls === 'off' || (f.castV === 'no' && f.cls !== 'match')));
    if (!odd.length) continue;
    const name = String(it.n || '').replace(/\s*\((19|20)\d{2}\)\s*$/, '').trim();
    let cands = null; // (the entries of that name: asked once per title)
    for (const f of odd) {
      if (stop()) break;
      const sig = `${f.len >> 6}|${f.tmdb}|${m.tmdb}`;
      if (splits.checked(f.copy) === sig) continue;
      st.splitAsked++;
      const fits = (c) => c && String(c.id) !== String(m.tmdb) && sameName(name, c) && C.lengthVerdict(f.len, c.runtime, tol) === 'yes' && !(f.cast && c.cast.length && C.castVerdict(f.cast, c.cast) === 'no');
      let pick = null;
      // Its provider's own TMDB number, when that film runs as long as the copy.
      if (f.tmdb && String(f.tmdb) !== String(m.tmdb)) {
        const c = candidateOf(await get(`/movie/${f.tmdb}`, { append_to_response: APPEND }));
        if (fits(c)) pick = c;
      }
      // Else the one entry of that name that runs as long.
      if (!pick) {
        if (!cands) {
          cands = [];
          const j = await get('/search/movie', { query: name, include_adult: 'false' });
          const ids = ((j && j.results) || []).filter((r) => String(r.id) !== String(m.tmdb) && (same(name, 0, r.title || '', 0) || same(name, 0, r.original_title || '', 0))).map((r) => r.id).slice(0, 6);
          for (const id of ids) { const c = candidateOf(await get(`/movie/${id}`, { append_to_response: APPEND })); if (c) cands.push(c); }
        }
        const ok = cands.filter(fits);
        if (ok.length === 1) pick = ok[0];
      }
      if (!pick) { splits.setChecked(f.copy, sig); continue; }
      splits.add(f.copy, { id: pick.id, y: pick.year || 0, t: pick.title, k: it.k });
      if (fixes) fixes.add({ k: it.k, n: it.n, t: 'movie', y: it.y || 0, why: 'copy', copy: f.copy, len: f.len, at: Date.now(), from: { id: m.tmdb, type: 'movie', title: m.title, y: m.y || 0 }, to: { id: pick.id, type: 'movie', title: pick.title, y: pick.year || 0 } });
      st.split++;
      if (deps.onSplit) { try { await deps.onSplit(it, f, pick); } catch {} }
    }
  }
  return { checked: st.splitChecked, asked: st.splitAsked, split: st.split };
}

module.exports = { CopySplits, run };
