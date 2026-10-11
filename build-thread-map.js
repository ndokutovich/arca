#!/usr/bin/env node
/**
 * Render the threads layer into a self-contained interactive HTML navigator.
 * Three views (constellation graph / time-river / timeline+arcs) over the same
 * data, click a thread to dive into its chronology. Zero deps, opens via file://.
 *
 * Usage:  node build-thread-map.js   ->   writes thread-map.html
 */
import { getDb, closeDb } from './lib/db.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function cos(a, b) {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}

function main() {
  const db = getDb();
  const threadsRaw = db.prepare('SELECT * FROM threads ORDER BY id').all();
  if (!threadsRaw.length) { console.error('No threads — run build-threads.js first.'); process.exit(1); }
  const segsRaw = db.prepare('SELECT thread_id, project, ts_start, n_turns, summary FROM thread_segments').all();

  // dominant project per thread (by turn mass)
  const domAcc = new Map();
  for (const s of segsRaw) {
    if (s.thread_id == null) continue;
    let m = domAcc.get(s.thread_id); if (!m) { m = new Map(); domAcc.set(s.thread_id, m); }
    m.set(s.project, (m.get(s.project) || 0) + s.n_turns);
  }
  const domProject = (id) => {
    const m = domAcc.get(id); if (!m) return null;
    return [...m.entries()].sort((a, b) => b[1] - a[1])[0][0];
  };

  // project palette — distinct hues over projects seen in segments
  const projects = [...new Set(segsRaw.map((s) => s.project))].sort();
  const projectColors = {};
  projects.forEach((p, i) => {
    const hue = Math.round((i / projects.length) * 360);
    projectColors[p] = `hsl(${hue} 62% 60%)`;
  });

  const threads = threadsRaw.map((t) => ({
    id: t.id, label: t.label,
    ex: t.n_turns, sess: t.n_sessions, proj: t.n_projects, ret: t.return_count,
    first: t.first_ts, last: t.last_ts,
    entities: JSON.parse(t.entities || '[]'),
    projects: JSON.parse(t.projects || '[]'),
    domProject: domProject(t.id),
  }));
  const idx = new Map(threads.map((t, i) => [t.id, i]));

  // edges from thread centroids: each thread's top neighbours above threshold
  const cents = new Map();
  for (const r of db.prepare('SELECT thread_id, embedding FROM vec_threads').all()) {
    const buf = r.embedding;
    cents.set(r.thread_id, new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
  }
  const edgeSet = new Map();
  const TH = 0.5, PER = 4;
  for (const t of threads) {
    const ca = cents.get(t.id); if (!ca) continue;
    const sims = [];
    for (const u of threads) {
      if (u.id === t.id) continue; const cb = cents.get(u.id); if (!cb) continue;
      const w = cos(ca, cb); if (w > TH) sims.push([u.id, w]);
    }
    sims.sort((a, b) => b[1] - a[1]);
    for (const [uid, w] of sims.slice(0, PER)) {
      const key = t.id < uid ? `${t.id}-${uid}` : `${uid}-${t.id}`;
      if (!edgeSet.has(key)) edgeSet.set(key, [idx.get(t.id), idx.get(uid), +w.toFixed(3)]);
    }
  }
  const edges = [...edgeSet.values()];

  const segments = segsRaw
    .filter((s) => s.thread_id != null)
    .map((s) => ({ t: s.thread_id, p: s.project, ts: s.ts_start, ex: s.n_turns, s: (s.summary || '').slice(0, 110) }));

  const data = { threads, edges, segments, projectColors };
  const tpl = fs.readFileSync(path.join(__dirname, 'thread-map.template.html'), 'utf8');
  // A summary containing </script> would otherwise close the tag it is being
  // embedded in, and JSON leaves U+2028/2029 raw where JavaScript treats them
  // as line terminators. Escaping all three is the price of JSON inside HTML.
  const safeJson = JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(new RegExp(String.fromCharCode(0x2028), 'g'), '\\u2028')
    .replace(new RegExp(String.fromCharCode(0x2029), 'g'), '\\u2029');
  const html = tpl.replace('/*__DATA__*/ null', safeJson);
  const out = path.join(__dirname, 'thread-map.html');
  fs.writeFileSync(out, html);

  console.error(`Wrote ${out}`);
  console.error(`  ${threads.length} threads · ${edges.length} edges · ${segments.length} segments · ${projects.length} projects`);
  console.error(`  open:  file:///${out.replace(/\\/g, '/')}`);
  closeDb();
}

main();
