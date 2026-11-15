'use strict';
// Putting wrong TMDB matches right, in the background. Every matched film and series is checked against what the
// provider says about it (lib/tmdbcheck.js): its cast, its length (the provider's, or the real one from watching it),
// its year, and the provider's own TMDB number. When the evidence clearly says the match is another title, TMDB is
// asked for the entries of that name, and the match moves to the one that clearly fits — never one picked by hand,
// and each change is listed (Admin → Recommendations → Corrected matches) with an Undo.
const path = require('path');
const crypto = require('crypto');
const { JsonFile } = require('./store');
const C = require('./tmdbcheck');

const APPEND = { movie: 'credits,release_dates,keywords,watch/providers', tv: 'credits,content_ratings,keywords,watch/providers' }; // (as Tmdb.details asks: one answer in the cache for both)
const yearOf = (s) => parseInt(String(s || '').slice(0, 4), 10) || 0;
const KEEP = 400; // (corrections listed)

class TmdbFixes {
  constructor(dataDir) {
    this.store = new JsonFile(path.join(dataDir, 'tmdb-fixes.json'), { list: [], ck: {} });
    const d = this.store.data;
    if (!Array.isArray(d.list)) d.list = [];
    if (!d.ck || typeof d.ck !== 'object') d.ck = {};
  }
  get list() { return this.store.data.list; }
  /** What TMDB was asked about a title last time (its evidence, as a fingerprint): not asked again till that changes. */
  checked(k) { return this.store.data.ck[k] || ''; }
  setChecked(k, sig) { this.store.data.ck[k] = sig; this.store.save(); }
  add(fix) {
    const id = crypto.randomBytes(6).toString('hex');
    this.store.data.list = [{ id, ...fix }].concat(this.list).slice(0, KEEP);
    this.store.save();
    return id;
  }
  get(id) { return this.list.find((x) => x.id === id) || null; }
  mark(id, patch) { const f = this.get(id); if (f) { Object.assign(f, patch); this.store.save(); } return f; }
}

/** A TMDB answer (with credits) as a candidate for tmdbcheck: { id, title, otitle, year, cast, runtime }. */
function candidateOf(j) {
  if (!j || !j.id) return null;
  return {
    id: j.id, title: j.title || j.name || '', otitle: j.original_title || j.original_name || '',
    year: yearOf(j.release_date || j.first_air_date), cast: ((j.credits || {}).cast || []).slice(0, 10).map((c) => c && c.name).filter(Boolean),
    runtime: j.runtime ? j.runtime * 60 : 0,
  };
}

/**
 * What the provider says about a title, beside its TMDB details (d) — only what's the provider's own: applyMeta fills
 * in TMDB's cast and length where the provider has none, and those would agree with TMDB, saying nothing.
 * realLength: the file's length as it played, if anyone has watched it.
 */
function evidence(it, d, own, realLength) {
  const name = String(it.n || '').replace(/\s*\((19|20)\d{2}\)\s*$/, '').trim();
  const cast = it.cast && String(it.cast) !== String(d.cast || '') ? String(it.cast) : '';
  let length = 0;
  if (it.t === 'movie') length = realLength || (it.d && it.d !== d.d ? C.providerLength(it.d, d.d) : 0);
  return { name, year: own || 0, cast, length };
}

/** A title's evidence and match, as a fingerprint: asked about again only when one of them changes. */
const sigOf = (m, ev, pnum) => crypto.createHash('sha1').update([m.id, pnum, ev.cast, Math.round(ev.length / 120), ev.year].join('|')).digest('hex').slice(0, 12);

/**
 * Goes through the catalogue's films and series: checks each match, and corrects those the evidence says are wrong.
 * deps: { tmdb, same (titles.sameTitle), ownYear (tmdb.ownYear), conflict (it, year) → years apart (tmdb.yearConflict),
 *         realLength (key) → seconds, fixes (TmdbFixes), stop () → true to stop, status (updated as it goes) }
 * → { checked, asked, fixed }
 */
async function run(items, deps) {
  const { tmdb, same, ownYear, conflict, fixes } = deps;
  const realLength = deps.realLength || (() => 0);
  const stop = deps.stop || (() => false);
  const st = deps.status || {};
  const map = tmdb.map.data.m, metas = tmdb.meta.data.m;
  const get = async (p, params) => { try { return await tmdb.get(p, params); } catch { return null; } };
  const sameName = (name, own, c) => !!c && (same(name, own, c.title, c.year) || (!!c.otitle && same(name, own, c.otitle, c.year)));
  st.total = items.length; st.checked = 0; st.asked = 0; st.fixed = 0;
  let n = 0;
  for (const it of items) {
    if (++n % 300 === 0) { await new Promise((r) => setImmediate(r)); }
    if (stop()) break;
    st.checked++;
    if (it.t !== 'movie' && it.t !== 'show') continue;
    const m = map[it.k];
    // (Picked by hand, or corrected here already: left alone.)
    if (!m || !m.id || m.manual || m.vf) continue;
    const d = metas[it.k];
    if (!d || String(d.tmdb) !== String(m.id)) continue; // (its details aren't in yet: checked next time)
    const type = m.type === 'tv' || (!m.type && it.t === 'show') ? 'tv' : 'movie';
    const own = ownYear(it);
    const ev = evidence(it, d, own, it.t === 'movie' ? realLength(it.k) : 0);
    // The provider's own TMDB number, when it's another one than the match (it came after the name was looked up).
    const pnum = /^\d+$/.test(String(it.tmdb || '')) && String(it.tmdb) !== String(m.id) && Number(it.tmdb) !== m.badList && !m.list ? Number(it.tmdb) : 0;
    const cur = { id: m.id, title: d.title || '', otitle: d.ot || '', year: d.y || 0, cast: d.cast ? String(d.cast).split(/\s*,\s*/) : [], runtime: d.d || 0 };
    const fc = C.fit(ev, cur, same);
    const why = C.contradicted(fc) || (C.misnamed(fc, ev) ? 'title' : '');
    if (!pnum && !why) continue;
    const sig = sigOf(m, ev, pnum);
    if (fixes.checked(it.k) === sig) continue;
    st.asked++;
    st.current = it.n;
    let pick = null;
    // 1. The provider's number: taken when it's this title (the same name, a year that fits), nothing says otherwise,
    // and it fits better than the match — not "BLAME!" (2017) given the number of "Blame" (2018).
    if (pnum) {
      const c = candidateOf(await get(`/${type}/${pnum}`, { append_to_response: APPEND[type] }));
      if (c && sameName(ev.name, own, c) && !conflict(it, c.year)) {
        const f = C.fit(ev, c, same);
        if (f.cast !== 'no' && f.length !== 'no' && f.score > fc.score) pick = { ...c, why: 'list', fit: f };
      }
      if (deps.onList) deps.onList(it, cur, c, pick);
    }
    // 2. The entries of that name on TMDB: the one the cast (or the length) says it is.
    if (!pick && why && !stop()) {
      const ids = [];
      const tries = own ? [{ [type === 'tv' ? 'first_air_date_year' : 'year']: String(own) }, {}] : [{}];
      for (const extra of tries) {
        const j = await get(`/search/${type}`, { query: ev.name, include_adult: 'false', ...extra });
        for (const r of (j && j.results) || []) {
          if (String(r.id) === String(m.id) || ids.includes(r.id)) continue;
          if (!same(ev.name, 0, r.title || r.name || '', 0) && !same(ev.name, 0, r.original_title || r.original_name || '', 0)) continue;
          ids.push(r.id);
        }
      }
      const cands = [];
      for (const id of ids.slice(0, 6)) {
        if (stop()) break;
        const c = candidateOf(await get(`/${type}/${id}`, { append_to_response: APPEND[type] }));
        if (c && !conflict(it, c.year)) cands.push(c);
      }
      const b = C.better(ev, cur, cands, same) || C.renamed(ev, cur, cands, same);
      if (b) pick = b;
      if (deps.onAsk) deps.onAsk(it, cur, why, cands, pick);
    }
    // (Someone picked a match by hand meanwhile: theirs stays.)
    const now = map[it.k];
    if (!now || now.manual || String(now.id) !== String(m.id)) continue;
    if (!pick) { fixes.setChecked(it.k, sig); continue; }
    // rc: tmdb.doubtful leaves it (it was looked at again); list: it's the provider's number.
    map[it.k] = Object.assign({ id: pick.id, type, vf: pick.why, rc: 1 }, pick.why === 'list' ? { list: 1 } : null);
    delete metas[it.k];
    tmdb.map.save(); tmdb.meta.save();
    fixes.add({
      k: it.k, n: it.n, t: it.t, y: own || 0, why: pick.why, at: Date.now(),
      from: { id: m.id, type, title: cur.title, y: cur.year }, to: { id: pick.id, type, title: pick.title, y: pick.year },
    });
    st.fixed++;
    if (deps.onFix) { try { await deps.onFix(it, pick); } catch {} }
  }
  st.current = '';
  return { checked: st.checked, asked: st.asked, fixed: st.fixed };
}

module.exports = { TmdbFixes, run, evidence, candidateOf };
