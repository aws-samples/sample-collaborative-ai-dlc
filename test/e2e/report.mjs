// test/e2e/report.mjs
import { writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';

function esc(s) {
  return String(s ?? '').replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c],
  );
}

function fmtDur(ms) {
  if (ms == null || !isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m}m ${r}s` : `${m}m`;
}

export function computeMetrics({ events = [], prs = [] }) {
  const ts = (label) => {
    const e = events.find((x) => x.label === label);
    return e ? Date.parse(e.ts) : null;
  };
  const first = events.length ? Date.parse(events[0].ts) : null;
  const last = events.length ? Date.parse(events[events.length - 1].ts) : null;
  const span = (a, b) => (a != null && b != null ? b - a : null);

  const runStart = events.find((e) => e.label === 'run-start');
  const repos = runStart?.repos?.length ?? null;
  const countAnswered = (prefix) => events.filter((e) => e.label === `${prefix}-answered`).length;
  const prsCollected = events.find((e) => e.label === 'prs-collected');
  const reviewResults = events.find((e) => e.label === 'review-results');

  return {
    total: span(first, last),
    inception: span(ts('inception-started'), ts('inception-complete')),
    construction: span(ts('construction-started'), ts('construction-complete')),
    review: span(ts('review-started'), ts('review-complete')),
    reviewStatus: reviewResults?.status ?? null,
    riskScore: reviewResults?.riskScore ?? null,
    repos,
    questionsInception: countAnswered('inception'),
    questionsConstruction: countAnswered('construction'),
    questionsReview: countAnswered('review'),
    screenshots: events.filter((e) => e.file).length,
    prs: prs.length || prsCollected?.count || 0,
    events: events.length,
    startedAt: first ? new Date(first).toISOString() : null,
  };
}

export function renderReportHtml({ status, prs, assertion, meta, events }) {
  const m = computeMetrics({ events, prs: prs || [] });
  const stats = [
    ['Total', fmtDur(m.total)],
    ['Inception', fmtDur(m.inception)],
    ['Construction', fmtDur(m.construction)],
    ...(m.review != null ? [['Review', fmtDur(m.review)]] : []),
    ['Repos', m.repos ?? '—'],
    ['Questions', `${m.questionsInception + m.questionsConstruction + m.questionsReview}`],
    ['PRs', m.prs],
    ...(m.reviewStatus ? [['Review result', m.reviewStatus]] : []),
    ...(m.riskScore != null ? [['Risk', m.riskScore]] : []),
    ['Screenshots', m.screenshots],
  ]
    .map(
      ([k, v]) =>
        `<div class="stat"><div class="v">${esc(v)}</div><div class="k">${esc(k)}</div></div>`,
    )
    .join('');

  const shots = (events || []).filter((e) => e.file);
  const shotHtml = shots
    .map(
      (e) =>
        `<figure class="shot"><figcaption>#${e.seq} ${esc(e.label)} <small>${esc(e.ts)}</small><br><span class="path">${esc(e.path)}</span></figcaption>` +
        `<a href="screenshots/${esc(basename(e.file))}" target="_blank" rel="noopener">` +
        `<img src="screenshots/${esc(basename(e.file))}" loading="lazy"/></a></figure>`,
    )
    .join('\n');
  const prList = prs || [];
  const prHtml = prList.length
    ? prList
        .map(
          (p) =>
            `<a class="pr-pill" href="${esc(p.prUrl)}" target="_blank" rel="noopener">${esc(p.repository)} <span>#${esc(p.prNumber)}</span></a>`,
        )
        .join('')
    : '<span class="muted">No pull requests created</span>';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>AI-DLC E2E ${esc(meta.runId)}</title>
<style>
  :root { color-scheme: light; }
  body{font-family:system-ui,sans-serif;margin:24px;color:#222}
  h1{font-size:20px}
  h2{font-size:16px;border-bottom:1px solid #eee;padding-bottom:6px;margin-top:32px}
  .meta{color:#555;font-size:13px;margin:4px 0 16px}
  .pass{color:#0a0}.fail{color:#b00}.muted{color:#888}
  .warn{background:#fff3cd;border:1px solid #ffe69c;color:#664d03;padding:8px 12px;border-radius:6px;font-size:13px;margin:8px 0}
  pre{background:#f6f8fa;padding:12px;border-radius:6px;overflow:auto;font-size:12px}
  .prbar{display:flex;flex-wrap:wrap;gap:10px;margin:12px 0 8px}
  .pr-pill{display:inline-flex;align-items:center;gap:6px;background:#0969da;color:#fff;text-decoration:none;
    padding:8px 14px;border-radius:20px;font-size:13px;font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.15)}
  .pr-pill:hover{background:#0757ba}
  .pr-pill span{background:rgba(255,255,255,.25);padding:1px 7px;border-radius:10px;font-weight:500}
  .metrics{display:flex;flex-wrap:wrap;gap:28px 40px;margin:18px 0 10px;padding:4px 0 18px;border-bottom:1px solid #eee}
  .stat .v{font-size:30px;font-weight:700;line-height:1;font-variant-numeric:tabular-nums;color:#111}
  .stat .k{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:#999;margin-top:6px}
  .grid{display:grid;grid-template-columns:repeat(2,1fr);gap:14px}
  @media(max-width:900px){.grid{grid-template-columns:1fr}}
  .timeline{margin-top:32px}
  .timeline>summary{font-size:16px;font-weight:600;cursor:pointer;list-style:none;
    border-bottom:1px solid #eee;padding:6px 0;user-select:none;display:flex;align-items:center;gap:8px}
  .timeline>summary::-webkit-details-marker{display:none}
  .timeline>summary::before{content:"\\25BC";font-size:11px;color:#888;transition:transform .15s}
  .timeline:not([open])>summary::before{transform:rotate(-90deg)}
  .timeline>summary:hover{color:#0969da}
  .timeline[open]>summary{margin-bottom:14px}
  .shot{margin:0;border:1px solid #ddd;border-radius:8px;padding:10px;background:#fafafa}
  .shot figcaption{font-size:13px;font-weight:600;margin-bottom:8px}
  .shot figcaption small{font-weight:400;color:#888}
  .shot .path{color:#888;font:11px monospace;font-weight:400}
  .shot img{width:100%;height:auto;border:1px solid #eee;border-radius:4px;display:block;cursor:zoom-in}
</style>
</head><body>
<h1>AI-DLC E2E Run <code>${esc(meta.runId)}</code> &mdash; <span class="${status === 'PASS' ? 'pass' : 'fail'}">${esc(status)}</span></h1>
${meta.cleanupWarning ? `<p class="warn">⚠ ${esc(meta.cleanupWarning)}</p>` : ''}
<div class="prbar">${prHtml}</div>
<p class="meta">Project: <code>${esc(meta.projectId)}</code> &middot; Sprint: <code>${esc(meta.sprintId)}</code> &middot; Branch: <code>${esc(meta.branch)}</code>${m.startedAt ? ` &middot; Started: ${esc(m.startedAt)}` : ''}</p>
<div class="metrics">${stats}</div>
<h2>Assertion &mdash; PRs only on changed repos</h2><pre>${esc(JSON.stringify(assertion, null, 2))}</pre>
<details class="timeline">
<summary>Screenshot timeline (${shots.length}) &mdash; click to expand &middot; click any image to enlarge</summary>
<div class="grid">${shotHtml}</div>
</details>
</body></html>`;
}

export function createReporter(outDir) {
  mkdirSync(outDir, { recursive: true });
  const eventsPath = join(outDir, 'events.jsonl');
  const events = [];

  function event(e) {
    const withTs = { ts: new Date().toISOString(), ...e };
    events.push(withTs);
    appendFileSync(eventsPath, JSON.stringify(withTs) + '\n');
    return withTs;
  }

  function finalize({ status, prs, assertion, meta }) {
    const html = renderReportHtml({ status, prs, assertion, meta, events });
    writeFileSync(join(outDir, 'report.html'), html);
    writeFileSync(
      join(outDir, 'summary.json'),
      JSON.stringify({ status, prs, assertion, meta, events }, null, 2),
    );
  }

  return { event, finalize };
}
