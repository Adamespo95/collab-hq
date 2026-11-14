'use strict';
/* Collab HQ app (phase 2). No build step, no libraries.
   - Data is cached on this device in IndexedDB, so everything works offline.
   - Edits made offline wait in an "outbox" and are sent on the next sync.
   - Nothing here makes up numbers: every figure is summed from rows in your Google Sheet.
   - Emails found by the backend land in Review. Nothing becomes a deal or payment until you approve it. */

const STAGES = ['pitched', 'signed', 'delivered', 'invoiced', 'paid', 'closed', 'disputed', 'on hold', 'declined'];
const ACTIVE_STAGES = ['signed', 'delivered', 'invoiced', 'disputed'];
const INCOME_TYPES = ['Brand cash', 'Affiliate commission', 'YouTube AdSense', 'Platform payout',
  'Review-unit resale', 'Marketplace sale', 'Unknown'];
const RESALE_TYPES = ['review-unit resale', 'marketplace sale'];
const PAY_STATUS = ['Received', 'Pending', 'Disputed', 'Report'];
const CONTRACT_STATUS = ['Signed', 'Sent', 'Not signed', 'Reference only'];
const AFF_STATUS = ['pending', 'approved', 'paid', 'declined'];
const AFF_DEAD = ['declined', 'deleted', 'reversed', 'rejected', 'cancelled', 'canceled'];
const NETWORKS = ['Amazon Associates', 'GoAffPro', 'UpPromote', 'Levanta', 'Awin', 'Impact'];
const VIEWS = [['dash', 'Dashboard'], ['review', 'Review'], ['Deals', 'Deals'], ['Payments', 'Payments'], ['more', 'More']];
const MORE_VIEWS = ['more', 'Contracts', 'Affiliate'];
const ALL_TABLES = ['Brands', 'Deals', 'Payments', 'Contracts', 'Sources', 'Payouts', 'Affiliate', 'Queue'];

const FORMS = {
  Deals: {
    title: 'deal',
    fields: [
      ['brand', 'Brand', 'brand'], ['product', 'Product', 'text'],
      ['stage', 'Status', 'select', STAGES], ['status_note', 'Status note', 'text'],
      ['deal_type', 'Deal type', 'text'], ['date', 'Date (YYYY-MM-DD or YYYY-MM)', 'text'],
      ['contact', 'Contact (name / email)', 'text'], ['deliverables', 'Deliverables', 'area'],
      ['cash_agreed', 'Rate / cash agreed ($)', 'money'], ['cash_received', 'Cash received so far ($)', 'money'],
      ['product_value', 'Product value ($)', 'money'], ['resale_value', 'Resale value ($)', 'money'],
      ['affiliate', 'Affiliate terms', 'text'], ['contract', 'Contract', 'text'],
      ['notes', 'Notes', 'area'], ['source', 'Where this info came from', 'text'],
      ['needs_review', 'Needs review (clear this when sorted)', 'text']
    ],
    defaults: () => ({ stage: 'pitched', date: today(), source: 'Added in app' })
  },
  Payments: {
    title: 'payment',
    fields: [
      ['date', 'Date (YYYY-MM-DD)', 'text'], ['payer', 'Payer as shown', 'text'],
      ['income_type', 'Income type', 'select', INCOME_TYPES], ['brand_or_program', 'Brand or program', 'brand'],
      ['amount_usd', 'Amount ($)', 'money'], ['status', 'Status', 'select', PAY_STATUS],
      ['expected_date', 'If pending: expected date (YYYY-MM-DD). Puts it on your calendar.', 'text'],
      ['fee', 'Fee ($)', 'money'], ['net', 'Net ($)', 'money'],
      ['note', 'Note', 'area'], ['evidence', 'Evidence (where the proof is)', 'text'],
      ['needs_review', 'Needs review (clear this when sorted)', 'text']
    ],
    defaults: () => ({ date: today(), income_type: 'Brand cash', status: 'Received', evidence: 'Added in app' })
  },
  Contracts: {
    title: 'contract',
    fields: [
      ['brand', 'Brand', 'brand'], ['document', 'Document', 'text'],
      ['date', 'Date', 'text'], ['status', 'Status', 'select', CONTRACT_STATUS],
      ['where_to_find', 'Where to find it', 'text'], ['drive_url', 'Google Drive link', 'text']
    ],
    defaults: () => ({ date: today(), status: 'Signed' })
  },
  Affiliate: {
    title: 'affiliate commission',
    fields: [
      ['network', 'Network', 'network'], ['program', 'Brand / program / product', 'brand'],
      ['date', 'Date (YYYY-MM-DD)', 'text'], ['order_ref', 'Order or reference', 'text'],
      ['sale_amount', 'Sale amount ($)', 'money'], ['commission', 'Commission ($)', 'money'],
      ['status', 'Status', 'select', AFF_STATUS], ['paid', 'Paid out to you?', 'select', ['no', 'yes']],
      ['source', 'Where this info came from', 'text']
    ],
    defaults: () => ({ date: today(), status: 'pending', paid: 'no', source: 'Added in app', currency: 'USD' })
  }
};

const S = {
  cfg: null, data: null, outbox: [], lastSync: null,
  syncing: false, err: null, view: 'dash', period: 'all',
  filter: { Deals: 'active', Payments: 'all', Contracts: 'all', Affiliate: 'all', review: 'new' }, q: '', csv: null
};

/* ---------------------------------------------------------------- helpers */
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clean = (v) => String(v ?? '').replace(/[$,\s]/g, '');
const hasNum = (v) => clean(v) !== '' && isFinite(Number(clean(v)));
const num = (v) => (hasNum(v) ? Number(clean(v)) : 0);
const usd = (n) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => ymd(new Date());
const curYear = () => today().slice(0, 4);
const curMonth = () => today().slice(0, 7);
const monthName = () => new Date().toLocaleString('en-US', { month: 'short', year: 'numeric' });
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'x' + Date.now() + Math.random().toString(16).slice(2));
const low = (s) => String(s ?? '').trim().toLowerCase();
const T = (name) => (S.data && S.data.tables[name]) || [];
const v2 = () => !!(S.data && S.data.version >= 2);

function inPeriod(date, p) {
  const d = String(date ?? '');
  if (p === 'all') return true;
  return d.startsWith(p === 'ytd' ? curYear() : curMonth());
}
function ago(iso) {
  if (!iso) return 'never';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' h ago';
  return Math.floor(s / 86400) + ' d ago';
}
function when(iso) {
  if (!iso) return 'never';
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 3500);
}
function hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

/* ------------------------------------------------- on-device storage (IDB) */
let dbp = null;
function db() {
  if (!dbp) {
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open('collab-hq', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  return dbp;
}
async function kvGet(k) {
  const d = await db();
  return new Promise((res, rej) => {
    const q = d.transaction('kv').objectStore('kv').get(k);
    q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
  });
}
async function kvSet(k, v) {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(v, k);
    tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
  });
}
async function persist() {
  try {
    await kvSet('state', { cfg: S.cfg, data: S.data, outbox: S.outbox, lastSync: S.lastSync });
  } catch (e) { console.error('Could not save on this device', e); }
}

/* ------------------------------------------------------------------- sync */
function validUrl(u) {
  return /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(u) ||
    /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/api$/.test(u);
}
async function api(body, cfg = S.cfg) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 240000);
  try {
    // text/plain keeps the browser from sending a preflight request, which Apps Script cannot answer.
    const res = await fetch(cfg.url, {
      method: 'POST', redirect: 'follow', signal: ctl.signal,
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ key: cfg.key, ...body })
    });
    const text = await res.text();
    try { return JSON.parse(text); } catch (e) {
      throw new Error('The web app did not answer with data. Check the web app URL and that access is set to "Anyone".');
    }
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'Timed out' : e.message);
  } finally { clearTimeout(timer); }
}
function takeSnapshot(res) {
  S.data = {
    version: res.version || 1, tables: res.tables, youtube: res.youtube || [], meta: res.meta || {},
    sheet_url: res.sheet_url, folder_url: res.folder_url
  };
  for (const name of ALL_TABLES) if (!S.data.tables[name]) S.data.tables[name] = [];
  S.lastSync = new Date().toISOString();
}
function applyLocal(c) {
  const rows = S.data.tables[c.table] || (S.data.tables[c.table] = []);
  const i = rows.findIndex((r) => r.id === c.id);
  if (c.fields.deleted === '1') { if (i >= 0) rows.splice(i, 1); return; }
  if (i >= 0) Object.assign(rows[i], c.fields, { updated_at: c.updated_at });
  else rows.push({ id: c.id, ...c.fields, updated_at: c.updated_at });
}
function mutateMany(list) {
  const ts = new Date().toISOString();
  for (const [table, id, fields] of list) {
    const c = { seq: uid(), table, id, fields, updated_at: ts };
    applyLocal(c);
    S.outbox.push(c);
  }
  persist(); render(); scheduleSync(1200);
}
function mutate(table, id, fields) { mutateMany([[table, id, fields]]); }
let syncTimer = null;
function scheduleSync(ms) { clearTimeout(syncTimer); syncTimer = setTimeout(() => sync(), ms); }

async function sync(action = 'sync') {
  if (!S.cfg || S.syncing) return;
  if (!navigator.onLine) { renderStatus(); return; }
  S.syncing = true; renderStatus();
  const sent = S.outbox.slice();
  try {
    const res = await api({ action, changes: sent });
    if (!res.ok) throw new Error(res.error || 'Sync failed');
    const done = new Set(sent.map((c) => c.seq));
    S.outbox = S.outbox.filter((c) => !done.has(c.seq));
    takeSnapshot(res);
    S.outbox.forEach(applyLocal); // edits made while the request was in flight
    S.err = null;
  } catch (e) {
    S.err = e.message;
  } finally {
    S.syncing = false;
    await persist();
    render();
  }
}

/* ------------------------------------------------------------------ maths */
function brandKey(raw) {
  const k = String(raw ?? '').replace(/\(.*?\)/g, '').trim() || 'No brand';
  const hit = T('Brands').map((b) => b.name).filter((n) => n && low(k).startsWith(low(n))).sort((a, b) => b.length - a.length)[0];
  return hit || k;
}
function totals(p) {
  const out = { cash: 0, resale: 0, yt: 0, ytDays: 0, bySource: {}, byBrand: {}, product: 0, productDeals: 0 };
  for (const r of T('Payments')) {
    if (low(r.status) !== 'received' || !hasNum(r.amount_usd) || !inPeriod(r.date, p)) continue;
    const type = low(r.income_type);
    const a = num(r.amount_usd);
    if (type === 'youtube adsense') continue; // YouTube comes from the Analytics API, not deposit notices
    if (RESALE_TYPES.includes(type)) { out.resale += a; continue; }
    out.cash += a;
    const label = !type || type === 'unknown' ? 'Unlabeled' : r.income_type.trim();
    out.bySource[label] = (out.bySource[label] || 0) + a;
    const b = label === 'Unlabeled' ? 'Unlabeled' : brandKey(r.brand_or_program);
    out.byBrand[b] = (out.byBrand[b] || 0) + a;
  }
  for (const [d, v] of (S.data.youtube || [])) if (inPeriod(d, p)) { out.yt += v; out.ytDays++; }
  if (out.ytDays) out.bySource['YouTube AdSense (estimated)'] = out.yt;
  for (const d of T('Deals')) {
    if (!hasNum(d.product_value) || ['pitched', 'declined'].includes(low(d.stage)) || !inPeriod(d.date, p)) continue;
    out.product += num(d.product_value); out.productDeals++;
  }
  out.total = out.cash + out.yt;
  return out;
}
function affBucket(r) {
  const s = low(r.status);
  if (AFF_DEAD.includes(s)) return 'declined';
  if (low(r.paid) === 'yes' || s === 'paid') return 'paid';
  if (s === 'approved' || s === 'confirmed' || s === 'locked') return 'approved';
  return 'pending';
}
function affTotals(p) {
  const by = {};
  for (const r of T('Affiliate')) {
    if (!hasNum(r.commission) || !inPeriod(r.date, p)) continue;
    const n = r.network || 'Other';
    const o = by[n] || (by[n] = { pending: 0, approved: 0, paid: 0, declined: 0, rows: 0 });
    o[affBucket(r)] += num(r.commission); o.rows++;
  }
  return by;
}

/* ----------------------------------------------------------------- render */
function renderStatus() {
  const el = $('#status');
  if (!S.cfg) { el.hidden = true; return; }
  el.hidden = false;
  let cls = '', txt = 'Synced ' + ago(S.lastSync);
  const n = S.outbox.length;
  if (S.syncing) txt = 'Syncing…';
  else if (!navigator.onLine) { cls = 'off'; txt = `Offline · data from ${ago(S.lastSync)}`; }
  else if (S.err) { cls = 'err'; txt = 'Sync problem · tap to retry'; }
  if (n && !S.syncing) { cls = cls || 'pending'; txt += ` · ${n} to send`; }
  el.className = 'status ' + cls;
  el.innerHTML = `<span class="dot"></span>${esc(txt)}`;
}
function renderTabs() {
  const el = $('#tabs');
  el.hidden = !S.data;
  const fresh = T('Queue').filter((q) => low(q.status) === 'new').length;
  el.innerHTML = VIEWS.map(([v, label]) => {
    const on = S.view === v || (v === 'more' && MORE_VIEWS.includes(S.view));
    return `<button data-act="nav" data-view="${v}" class="${on ? 'on' : ''}">${label}${v === 'review' && fresh ? ` <span class="count">${fresh}</span>` : ''}</button>`;
  }).join('');
}
function render() {
  renderStatus(); renderTabs();
  const v = $('#view');
  if (!S.data) { v.innerHTML = connectHtml(); return; }
  if (S.view === 'dash') v.innerHTML = dashHtml();
  else if (S.view === 'review') v.innerHTML = reviewHtml();
  else if (S.view === 'more') v.innerHTML = settingsHtml();
  else v.innerHTML = listViewHtml(S.view);
}

function connectHtml() {
  return `<div class="card connect">
    <h2>Connect to your Google Sheet</h2>
    <p class="small muted">One time per device. Paste the two values from the setup guide, or a connection code copied from a device that is already connected.</p>
    <label>Web app URL</label><input id="c-url" placeholder="https://script.google.com/macros/s/…/exec" autocapitalize="off" autocorrect="off" spellcheck="false">
    <label>Secret key</label><input id="c-key" autocapitalize="off" autocorrect="off" spellcheck="false">
    <div class="or">or</div>
    <label>Connection code</label><textarea id="c-code" rows="3" autocapitalize="off" autocorrect="off" spellcheck="false"></textarea>
    <button class="btn primary" data-act="connect">Connect</button>
    ${S.err ? `<p class="note" style="color:var(--bad)">${esc(S.err)}</p>` : ''}
  </div>`;
}

function barsHtml(obj) {
  const rows = Object.entries(obj).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  if (!rows.length) return '<div class="empty small">Nothing in this period.</div>';
  const max = rows[0][1];
  return `<div class="bars">${rows.map(([k, v]) => `<div class="row"><div class="name">${esc(k)}</div><div class="amt">${usd(v)}</div>
    <div class="track"><div class="fill" style="width:${(v / max * 100).toFixed(1)}%"></div></div></div>`).join('')}</div>`;
}
function tileHtml(label, t, ytOk) {
  const sub = ytOk ? `Cash payments ${usd(t.cash)} · YouTube est. ${usd(t.yt)}` : `Cash payments only · YouTube not synced yet`;
  return `<div class="tile"><div class="lab">${esc(label)}</div><div class="val">${usd(t.total)}</div><div class="sub">${sub}</div></div>`;
}
function payoutsCardHtml() {
  const m = S.data.meta || {};
  const pays = T('Payments');
  const disputed = pays.filter((r) => low(r.status) === 'disputed');
  const payRow = (r) => `<div class="kv"><span>${esc(brandKey(r.brand_or_program))} <span class="muted small">· ${esc(r.date)}${r.note ? ' · ' + esc(r.note) : ''}</span></span><b>${hasNum(r.amount_usd) ? usd(num(r.amount_usd)) : 'no amount'}</b></div>`;
  let body, note;
  if (v2()) {
    const open = T('Payouts').filter((r) => low(r.status) !== 'paid')
      .sort((a, b) => String(a.expected_date || '9999').localeCompare(String(b.expected_date || '9999')));
    const total = open.reduce((s, r) => s + num(r.amount_usd), 0);
    body = open.length ? open.map((r) => `<div class="kv"><span>${esc(r.source)}
        <span class="muted small">· ${r.expected_date ? 'expected ' + esc(r.expected_date) : 'no expected date set'}</span>
        ${r.note ? `<br><span class="muted small">${esc(r.note)}</span>` : ''}</span>
        <span style="text-align:right;white-space:nowrap"><b>${hasNum(r.amount_usd) ? usd(num(r.amount_usd)) : 'no amount'}</b><br><span class="badge ${stageClass(r.status)}">${esc(r.status)}</span></span></div>`).join('') +
      `<div class="kv"><span class="muted">Total expected</span><b>${usd(total)}</b></div>` : '<div class="empty small">Nothing expected right now.</div>';
    note = `From Payments marked Pending and YouTube estimates. Mirrored to your "Collab HQ Payouts" Google Calendar, last updated ${esc(when(m.payouts_last_sync))}.` +
      (m.payouts_last_error ? ` <span style="color:var(--bad)">${esc(m.payouts_last_error)}</span>` : '');
  } else {
    const pending = pays.filter((r) => low(r.status) === 'pending');
    body = pending.length ? pending.map(payRow).join('') + `<div class="kv"><span class="muted">Total pending</span><b>${usd(pending.reduce((s, r) => s + num(r.amount_usd), 0))}</b></div>` : '<div class="empty small">No pending payments logged.</div>';
    note = 'From Payments rows marked Pending.';
  }
  return `<div class="card"><h2>Upcoming payouts</h2>${body}
    ${disputed.length ? `<h2 style="margin-top:14px">Disputed</h2>${disputed.map(payRow).join('')}` : ''}
    <p class="note">${note}</p></div>`;
}
function affCardHtml(periodLabel) {
  const by = affTotals(S.period);
  const names = Object.keys(by).sort();
  if (!T('Affiliate').length) return '';
  const m = S.data.meta || {};
  return `<div class="card"><h2>Affiliate commissions reported by networks · ${esc(periodLabel)}</h2>
    ${names.length ? `<div class="tbl"><div class="tr th"><span>Network</span><span>Pending</span><span>Approved</span><span>Paid out</span></div>
      ${names.map((n) => `<div class="tr"><span>${esc(n)} <span class="muted small">· ${by[n].rows}</span></span><span>${usd(by[n].pending)}</span><span>${usd(by[n].approved)}</span><span>${usd(by[n].paid)}</span></div>`).join('')}</div>` : '<div class="empty small">Nothing in this period.</div>'}
    <p class="note">Not added to "earned": a commission only counts once the payment arrives and is logged in Payments.
      ${m.awin_last_sync ? ` Awin fetched ${esc(when(m.awin_last_sync))}.` : ''}${m.impact_last_sync ? ` Impact fetched ${esc(when(m.impact_last_sync))}.` : ''} Other networks: your CSV imports and approved emails.</p>
    <button class="btn" data-act="nav" data-view="Affiliate">Open affiliate log</button></div>`;
}
function dashHtml() {
  const m = S.data.meta || {};
  const ytOk = (S.data.youtube || []).length > 0;
  const all = totals('all'), ytd = totals('ytd'), mon = totals('month'), cur = totals(S.period);
  const pays = T('Payments');
  const review = pays.filter((r) => r.needs_review).length + T('Deals').filter((r) => r.needs_review).length;
  const fresh = T('Queue').filter((q) => low(q.status) === 'new').length;
  const overdue = T('Payouts').filter((r) => low(r.status) === 'overdue');
  const active = T('Deals').filter((d) => ACTIVE_STAGES.includes(low(d.stage))).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const pitched = T('Deals').filter((d) => low(d.stage) === 'pitched').length;
  const noAmt = pays.filter((r) => low(r.income_type) === 'youtube adsense' && !hasNum(r.amount_usd)).length;
  const periodLabel = { all: 'all-time', ytd: curYear(), month: monthName() }[S.period];

  let ytNote;
  if (ytOk) ytNote = `YouTube: YouTube Analytics API, estimated revenue, data through ${esc(m.yt_data_through || '?')}, fetched ${esc(when(m.yt_last_sync))}.`;
  else if (m.yt_last_error) ytNote = `YouTube: no data. Last attempt failed: ${esc(m.yt_last_error)}`;
  else ytNote = 'YouTube: not synced yet.';

  return `
  ${!v2() ? `<div class="alert"><span>The app is updated but your Google backend is still the old version. Payout calendar, Review and affiliate imports switch on after you update it (SETUP.md, Part D).</span></div>` : ''}
  ${overdue.length ? `<div class="alert bad"><span>${overdue.length} payout${overdue.length === 1 ? ' is' : 's are'} overdue: ${esc(overdue.map((r) => r.source + (hasNum(r.amount_usd) ? ' ' + usd(num(r.amount_usd)) : '')).join(', '))}</span></div>` : ''}
  ${fresh ? `<div class="alert"><span>${fresh} new email${fresh === 1 ? '' : 's'} waiting in Review.</span><button data-act="nav" data-view="review">Review</button></div>` : ''}
  ${review ? `<div class="alert"><span>${review} ${review === 1 ? 'entry needs' : 'entries need'} a second look (unknown payers, mismatches).</span><button data-act="review">Show</button></div>` : ''}
  ${!ytOk && m.yt_last_error ? `<div class="alert bad"><span>YouTube revenue is not syncing: ${esc(m.yt_last_error)}</span></div>` : ''}
  <div class="tiles">
    ${tileHtml('Earned all-time', all, ytOk)}
    ${tileHtml('Earned ' + curYear() + ' (YTD)', ytd, ytOk)}
    ${tileHtml('Earned ' + monthName(), mon, ytOk)}
  </div>
  <div class="card small muted" style="padding:12px 16px">
    <div>Cash payments: rows marked Received in your Sheet's Payments tab. Sheet last read ${esc(when(S.lastSync))}.</div>
    <div>${ytNote}</div>
    ${noAmt ? `<div>${noAmt} AdSense deposit notices have no amount and are not counted; YouTube totals come from the API only.</div>` : ''}
  </div>

  <div class="seg">
    ${[['all', 'All-time'], ['ytd', 'YTD'], ['month', 'This month']].map(([p, l]) => `<button data-act="period" data-p="${p}" class="${S.period === p ? 'on' : ''}">${l}</button>`).join('')}
  </div>
  <div class="grid2">
    <div class="card"><h2>By source · ${esc(periodLabel)}</h2>${barsHtml(cur.bySource)}</div>
    <div class="card"><h2>By brand or program · ${esc(periodLabel)}</h2>${barsHtml(cur.byBrand)}
      <p class="note">Cash payments only. YouTube is listed under sources.</p></div>
  </div>
  <div class="card"><h2>Not counted in "earned" · ${esc(periodLabel)}</h2>
    <div class="kv"><span>Review-unit and marketplace resale <span class="muted small">· Payments tab</span></span><b>${usd(cur.resale)}</b></div>
    <div class="kv"><span>Product value received <span class="muted small">· ${cur.productDeals} deals with a value logged, Deals tab</span></span><b>${usd(cur.product)}</b></div>
  </div>
  ${affCardHtml(periodLabel)}
  <div class="grid2">
    ${payoutsCardHtml()}
    <div class="card"><h2>Active deals (${active.length})</h2>
      ${active.length ? active.map((d) => `<div class="kv"><span>${esc(d.brand)} <span class="muted small">· ${esc(d.product)}</span></span><span class="badge ${stageClass(d.stage)}">${esc(d.stage)}</span></div>`).join('') : '<div class="empty small">No active deals.</div>'}
      <p class="note">${pitched} more pitched and waiting on the brand. From the Deals tab.</p>
    </div>
  </div>`;
}

function stageClass(s) {
  s = low(s);
  if (['paid', 'closed', 'received', 'signed', 'approved'].includes(s)) return 'good';
  if (['delivered', 'invoiced', 'pending', 'on hold', 'sent', 'report', 'expected', 'check', 'no date', 'new'].includes(s)) return 'warn';
  if (['disputed', 'declined', 'not signed', 'overdue', 'dismissed', ...AFF_DEAD].includes(s) || s.startsWith('not ')) return 'bad';
  return '';
}

/* ----------------------------------------------------------- list screens */
function chipsFor(table) {
  const rows = T(table);
  const count = (fn) => rows.filter(fn).length;
  if (table === 'Deals') {
    return [['active', 'Active', count((d) => ACTIVE_STAGES.includes(low(d.stage)))], ['all', 'All', rows.length],
      ...STAGES.map((s) => [s, s[0].toUpperCase() + s.slice(1), count((d) => low(d.stage) === s)]).filter((c) => c[2]),
      ['review', 'Needs review', count((d) => d.needs_review)]];
  }
  if (table === 'Payments') {
    const types = [...new Set(rows.map((r) => (r.income_type || 'Unknown').trim()))].sort();
    return [['all', 'All', rows.length], ['review', 'Needs review', count((r) => r.needs_review)],
      ['pending', 'Pending', count((r) => low(r.status) === 'pending')],
      ...types.map((t) => ['type:' + t, t, count((r) => (r.income_type || 'Unknown').trim() === t)])];
  }
  if (table === 'Affiliate') {
    const nets = [...new Set(rows.map((r) => r.network || 'Other'))].sort();
    return [['all', 'All', rows.length], ...nets.map((n) => ['net:' + n, n, count((r) => (r.network || 'Other') === n)])];
  }
  return [['all', 'All', rows.length], ['linked', 'With Drive link', count((r) => r.drive_url)]];
}
function filtered(table) {
  const f = S.filter[table], q = low(S.q);
  let rows = T(table).filter((r) => {
    if (f === 'all') return true;
    if (f === 'review') return !!r.needs_review;
    if (f === 'active') return ACTIVE_STAGES.includes(low(r.stage));
    if (f === 'pending') return low(r.status) === 'pending';
    if (f === 'linked') return !!r.drive_url;
    if (f.startsWith('type:')) return (r.income_type || 'Unknown').trim() === f.slice(5);
    if (f.startsWith('net:')) return (r.network || 'Other') === f.slice(4);
    return low(r.stage) === f;
  });
  if (q) rows = rows.filter((r) => low(Object.values(r).join(' ')).includes(q));
  return rows.sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')));
}
function itemHtml(table, r) {
  const flag = r.needs_review ? `<span class="badge warn">Review</span> ${esc(r.needs_review)}` : '';
  if (table === 'Deals') {
    const money = hasNum(r.cash_agreed) ? usd(num(r.cash_agreed)) : (hasNum(r.product_value) ? usd(num(r.product_value)) + ' product' : '');
    return `<button class="item" data-act="edit" data-table="Deals" data-id="${esc(r.id)}">
      <div class="l1"><span class="t">${esc(r.brand)}</span><span class="a">${money}</span></div>
      <div class="l2">${esc(r.product)}${r.deal_type ? ' · ' + esc(r.deal_type) : ''}${r.date ? ' · ' + esc(r.date) : ''}</div>
      <div class="l3"><span class="badge ${stageClass(r.stage)}">${esc(r.stage)}</span>${r.status_note ? esc(r.status_note) : ''}${r.contract ? ' · Contract: ' + esc(r.contract) : ''}</div>
      ${flag ? `<div class="l3">${flag}</div>` : ''}</button>`;
  }
  if (table === 'Payments') {
    return `<button class="item" data-act="edit" data-table="Payments" data-id="${esc(r.id)}">
      <div class="l1"><span class="t">${esc(r.payer || r.brand_or_program)}</span><span class="a">${hasNum(r.amount_usd) ? usd(num(r.amount_usd)) : '<span class="muted">no amount</span>'}</span></div>
      <div class="l2">${esc(r.date)} · ${esc(r.income_type)} · ${esc(r.brand_or_program)}</div>
      <div class="l3"><span class="badge ${stageClass(r.status)}">${esc(low(r.status))}</span>${low(r.status) === 'pending' ? (r.expected_date ? 'Expected ' + esc(r.expected_date) + ' · ' : 'No expected date · ') : ''}${r.evidence ? 'Source: ' + esc(r.evidence) : ''}</div>
      ${flag ? `<div class="l3">${flag}</div>` : ''}</button>`;
  }
  if (table === 'Affiliate') {
    const b = affBucket(r);
    return `<button class="item" data-act="edit" data-table="Affiliate" data-id="${esc(r.id)}">
      <div class="l1"><span class="t">${esc(r.program || r.network)}</span><span class="a">${hasNum(r.commission) ? usd(num(r.commission)) : '<span class="muted">no amount</span>'}</span></div>
      <div class="l2">${esc(r.date)} · ${esc(r.network)}${hasNum(r.sale_amount) ? ' · sale ' + usd(num(r.sale_amount)) : ''}${r.order_ref ? ' · ' + esc(r.order_ref) : ''}</div>
      <div class="l3"><span class="badge ${stageClass(b)}">${b === 'paid' ? 'paid out' : esc(b)}</span>${r.source ? 'Source: ' + esc(r.source) : ''}</div></button>`;
  }
  const st = low(r.status);
  const signed = st.startsWith('signed') || st.startsWith('completed') || st.startsWith('accepted');
  return `<button class="item" data-act="edit" data-table="Contracts" data-id="${esc(r.id)}">
    <div class="l1"><span class="t">${esc(r.brand)}</span><span class="a small">${esc(r.date)}</span></div>
    <div class="l2">${esc(r.document)}</div>
    <div class="l3"><span class="badge ${stageClass(signed ? 'signed' : st)}">${esc(r.status)}</span>${r.drive_url ? 'PDF linked' : esc(r.where_to_find)}</div></button>`;
}
function listHtml(table) {
  const rows = filtered(table);
  if (!rows.length) return '<div class="empty">Nothing here.</div>';
  const cap = 300;
  return rows.slice(0, cap).map((r) => itemHtml(table, r)).join('') +
    (rows.length > cap ? `<div class="empty small">Showing the newest ${cap} of ${rows.length}. Search or filter to narrow down.</div>` : '');
}
function listViewHtml(table) {
  const chips = chipsFor(table);
  const sub = table === 'Contracts' || table === 'Affiliate';
  return `${sub ? `<button class="btn back" data-act="nav" data-view="more">‹ More</button>` : ''}
    ${table === 'Affiliate' ? `<p class="small muted" style="margin:0 0 10px">Commissions as reported by each network. Awin and Impact fill in by themselves once their keys are added; everything else comes from a CSV export or an approved email. Not counted in "earned" until the payment is logged.</p>` : ''}
    <div class="toolbar">
      <input type="search" id="q" placeholder="Search ${table.toLowerCase()}" value="${esc(S.q)}">
      ${table === 'Affiliate' ? `<button class="btn" data-act="pickcsv" ${v2() ? '' : 'disabled'}>Import CSV</button><input type="file" id="csvfile" accept=".csv,.tsv,.txt,text/csv" hidden>` : ''}
      <button class="btn primary" data-act="add" data-table="${table}" ${table === 'Affiliate' && !v2() ? 'disabled' : ''}>+ Add</button>
    </div>
    <div class="chips">${chips.map(([k, l, n]) => `<button data-act="filter" data-f="${esc(k)}" class="${S.filter[table] === k ? 'on' : ''}">${esc(l)} ${n}</button>`).join('')}</div>
    <div class="list" id="list">${listHtml(table)}</div>`;
}

/* ----------------------------------------------------------------- review */
const KIND_LABEL = { deal: 'Labeled "Collab"', payment: 'Money received', affiliate: 'Referral sale' };
function reviewHtml() {
  const m = S.data.meta || {};
  const f = S.filter.review;
  const all = T('Queue');
  const rows = all.filter((q) => low(q.status) === f).sort((a, b) => String(b.received).localeCompare(String(a.received)));
  const n = (s) => all.filter((q) => low(q.status) === s).length;
  const head = `<p class="small muted" style="margin:0 0 10px">Emails Collab HQ noticed. Nothing here is saved as a deal or payment until you approve it.
    To send a brand thread here, put the Gmail label <b>Collab</b> on it. PayPal, Venmo and GoAffPro receipts arrive on their own.
    Gmail last checked ${esc(when(m.gmail_last_scan))}.${m.gmail_last_error ? ` <span style="color:var(--bad)">${esc(m.gmail_last_error)}</span>` : ''}</p>`;
  if (!v2()) return head + '<div class="empty">Review switches on after you update the Google backend (SETUP.md, Part D).</div>';
  return head + `<div class="chips">${[['new', 'New'], ['approved', 'Approved'], ['dismissed', 'Dismissed']].map(([k, l]) => `<button data-act="rfilter" data-f="${k}" class="${f === k ? 'on' : ''}">${l} ${n(k)}</button>`).join('')}</div>
    <div class="list">${rows.length ? rows.map(queueItemHtml).join('') : `<div class="empty">${f === 'new' ? 'Nothing waiting. You are caught up.' : 'Nothing here.'}</div>`}</div>`;
}
function queueItemHtml(q) {
  const isNew = low(q.status) === 'new';
  const title = q.kind === 'payment' ? q.payer : (q.brand_guess || q.from);
  let detail = '';
  if (q.kind === 'deal') {
    detail = `<div class="l3">${q.amounts ? 'Amounts mentioned: ' + esc(q.amounts) : 'No dollar amounts found'}${q.dates ? ' · Dates mentioned: ' + esc(q.dates) : ''}</div>`;
  } else if (q.kind === 'affiliate') {
    detail = `<div class="l3">Order ${esc(q.order_ref || '?')}${hasNum(q.sale_amount) ? ' · sale ' + usd(num(q.sale_amount)) : ''} · commission ${hasNum(q.amount_usd) ? usd(num(q.amount_usd)) : '?'}</div>`;
  }
  const id = esc(q.id);
  let acts = '';
  if (isNew) {
    if (q.kind === 'deal') acts = `<button class="btn primary sm" data-act="qdeal" data-id="${id}">Create deal</button><button class="btn sm" data-act="qpay" data-id="${id}">Log payment</button>`;
    else if (q.kind === 'payment') acts = `<button class="btn primary sm" data-act="qpay" data-id="${id}">Log payment</button>`;
    else acts = `<button class="btn primary sm" data-act="qaff" data-id="${id}">Add to affiliate log</button>`;
    acts += `<button class="btn sm" data-act="qdismiss" data-id="${id}">Dismiss</button>`;
  } else {
    acts = `<button class="btn sm" data-act="qrestore" data-id="${id}">Move back to New</button>`;
  }
  return `<div class="item static">
    <div class="l1"><span class="t">${esc(title)}</span><span class="a">${q.kind !== 'deal' && hasNum(q.amount_usd) ? usd(num(q.amount_usd)) : ''}</span></div>
    <div class="l2">${esc(KIND_LABEL[q.kind] || q.kind)} · ${esc(q.received)} · ${esc(q.from)}</div>
    <div class="l3">${esc(q.subject)}</div>
    ${detail}
    ${q.kind === 'deal' && q.snippet ? `<div class="l3">“${esc(q.snippet)}”</div>` : ''}
    ${q.possible_duplicate ? `<div class="l3"><span class="badge warn">Possible duplicate</span> ${esc(q.possible_duplicate)}</div>` : ''}
    <div class="acts">${acts}${q.thread_url ? `<a class="btn sm" href="${esc(q.thread_url)}" target="_blank" rel="noopener">Open email</a>` : ''}</div>
  </div>`;
}
const queueRow = (id) => T('Queue').find((q) => q.id === id);

/* --------------------------------------------------------------- settings */
function settingsHtml() {
  const m = S.data.meta || {};
  const src = T('Sources');
  const line = (label, value, err) => `<div class="kv"><span>${label}${err ? `<br><span class="small" style="color:var(--bad)">${esc(err)}</span>` : ''}</span><b>${esc(value)}</b></div>`;
  return `
  <div class="card"><h2>More</h2>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn" data-act="nav" data-view="Contracts">Contracts (${T('Contracts').length})</button>
      <button class="btn" data-act="nav" data-view="Affiliate">Affiliate log (${T('Affiliate').length})</button>
    </div>
  </div>
  <div class="card"><h2>Sync</h2>
    ${line('Last synced with your Sheet', when(S.lastSync), S.err)}
    ${line('Changes waiting to send', String(S.outbox.length))}
    ${line('YouTube revenue fetched', when(m.yt_last_sync), m.yt_last_error)}
    ${v2() ? line('Gmail checked', when(m.gmail_last_scan), m.gmail_last_error) +
      line('Payout calendar updated', when(m.payouts_last_sync), m.payouts_last_error) +
      line('Awin commissions fetched', m.awin_last_sync ? when(m.awin_last_sync) : 'keys not added', m.awin_last_error) +
      line('Impact commissions fetched', m.impact_last_sync ? when(m.impact_last_sync) : 'keys not added', m.impact_last_error) : ''}
    ${m.yt_channel ? line('YouTube channel', m.yt_channel) : ''}
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
      <button class="btn primary" data-act="sync">Sync now</button>
      <button class="btn" data-act="yt">Fetch everything from Google now</button>
    </div>
    <p class="note">"Fetch everything" re-reads YouTube, Gmail, Awin, Impact, the Contracts folder and the payout calendar. It can take a minute or two.</p>
  </div>
  <div class="card"><h2>Where each number comes from</h2>
    ${src.map((s) => `<div class="kv"><span>${esc(s.name)}<br><span class="muted small">${esc(s.method)} · ${esc(s.status)}${s.note ? ' · ' + esc(s.note) : ''}</span></span><span class="small muted" style="white-space:nowrap">${s.last_synced ? esc(when(s.last_synced)) : ''}</span></div>`).join('') || '<div class="empty small">No sources listed.</div>'}
    ${m.seed_imported_at ? `<p class="note">Starting CSVs imported ${esc(when(m.seed_imported_at))}.</p>` : ''}
  </div>
  <div class="card"><h2>Your data</h2>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      ${S.data.sheet_url ? `<a class="btn" href="${esc(S.data.sheet_url)}" target="_blank" rel="noopener">Open Google Sheet</a>` : ''}
      ${S.data.folder_url ? `<a class="btn" href="${esc(S.data.folder_url)}" target="_blank" rel="noopener">Open Contracts folder</a>` : ''}
    </div>
    <p class="note">Drop a contract PDF in that folder with the brand in the file name (for example "Tenvels partnership agreement.pdf"). It is linked to its contract once a day, or right away with "Fetch everything".</p>
  </div>
  <div class="card"><h2>This device</h2>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn" data-act="copycode">Copy connection code</button>
      <button class="btn danger" data-act="disconnect">Disconnect this device</button>
    </div>
    <p class="note">The connection code sets up another device in one paste. Treat it like a password.</p>
  </div>`;
}

/* ------------------------------------------------------------------ forms */
function fieldHtml([name, label, type, opts], val) {
  const v = esc(val ?? '');
  if (type === 'select') {
    const list = opts.slice();
    if (val && !list.some((o) => low(o) === low(val))) list.unshift(val);
    return `<label>${label}</label><select name="${name}">${list.map((o) => `<option ${low(o) === low(val) ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
  }
  if (type === 'area') return `<label>${label}</label><textarea name="${name}">${v}</textarea>`;
  if (type === 'money') return `<label>${label}</label><input name="${name}" inputmode="decimal" value="${v}">`;
  if (type === 'brand') return `<label>${label}</label><input name="${name}" list="brandlist" value="${v}" autocomplete="off">`;
  if (type === 'network') return `<label>${label}</label><input name="${name}" list="netlist" value="${v}" autocomplete="off">`;
  return `<label>${label}</label><input name="${name}" value="${v}">`;
}
/** id = edit that row. No id = new row, optionally pre-filled (preset) and tied to a Review item (queueId). */
function openForm(table, id, preset, queueId) {
  const def = FORMS[table];
  const row = id ? T(table).find((r) => r.id === id) : { ...def.defaults(), ...(preset || {}) };
  if (!row) return;
  let extra = '';
  if (table === 'Deals' && id) {
    const cons = T('Contracts').filter((c) => low(c.brand) && (low(row.brand).startsWith(low(c.brand)) || low(c.brand).startsWith(low(row.brand))));
    if (cons.length) {
      extra = `<label>Contracts on file for ${esc(row.brand)}</label>` + cons.map((c) => `<div class="kv small"><span>${esc(c.document)} <span class="muted">· ${esc(c.date)} · ${esc(c.status)}</span></span>${c.drive_url ? `<a href="${esc(c.drive_url)}" target="_blank" rel="noopener">Open PDF</a>` : `<span class="muted">${esc(c.where_to_find)}</span>`}</div>`).join('');
    }
  }
  if (table === 'Contracts' && id && row.drive_url) extra = `<p class="small"><a href="${esc(row.drive_url)}" target="_blank" rel="noopener">Open PDF in Drive</a></p>`;
  const m = $('#modal');
  m.innerHTML = `<form class="sheet" id="form" data-table="${table}" data-id="${esc(id || '')}" data-queue="${esc(queueId || '')}">
    <h3>${id ? 'Edit' : 'Add'} ${def.title}</h3>
    ${queueId ? '<p class="small muted" style="margin-top:-6px">Filled in from the email. Check every field before saving.</p>' : ''}
    <datalist id="brandlist">${T('Brands').map((b) => `<option value="${esc(b.name)}">`).join('')}</datalist>
    <datalist id="netlist">${[...new Set(NETWORKS.concat(T('Affiliate').map((a) => a.network).filter(Boolean)))].map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
    ${def.fields.map((f) => fieldHtml(f, row[f[0]])).join('')}
    ${extra}
    <div class="actions">
      ${id ? '<button type="button" class="btn danger" data-act="del">Delete</button>' : ''}
      <span class="sp"></span>
      <button type="button" class="btn" data-act="close">Cancel</button>
      <button type="submit" class="btn primary">Save</button>
    </div></form>`;
  m.hidden = false;
}
function closeForm() { const m = $('#modal'); m.hidden = true; m.innerHTML = ''; S.csv = null; }
function saveForm(form) {
  const table = form.dataset.table, id = form.dataset.id || uid();
  const fields = {};
  for (const [name, , type] of FORMS[table].fields) {
    let v = form.elements[name].value.trim();
    if (type === 'money' && v !== '') {
      if (!hasNum(v)) { toast('"' + v + '" is not a number'); form.elements[name].focus(); return; }
      v = String(num(v));
    }
    fields[name] = v;
  }
  if ((table === 'Deals' || table === 'Contracts') && !fields.brand) { toast('Brand is required'); return; }
  if (table === 'Affiliate' && !fields.network) { toast('Network is required'); return; }
  if (table === 'Payments' && fields.expected_date && !/^\d{4}-\d{2}-\d{2}$/.test(fields.expected_date)) { toast('Expected date must look like 2026-12-21'); return; }
  const isNew = !form.dataset.id;
  if (isNew) fields.deleted = '';
  const batch = [];
  if (table === 'Deals' && !T('Brands').some((b) => low(b.name) === low(fields.brand))) {
    batch.push(['Brands', uid(), { name: fields.brand, contact_name: '', contact_email: '', notes: '', deleted: '' }]);
  }
  batch.push([table, id, fields]);
  if (form.dataset.queue) batch.push(['Queue', form.dataset.queue, { status: 'approved' }]);
  closeForm();
  mutateMany(batch);
  toast(navigator.onLine ? 'Saved' : 'Saved on this device. Will sync when you are back online.');
}

/* ------------------------------------------------------------- CSV import */
function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const firstLines = text.split(/\r?\n/).slice(0, 5).join('\n');
  const delim = (firstLines.match(/\t/g) || []).length > (firstLines.match(/,/g) || []).length ? '\t' : ',';
  const rows = [];
  let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); cur = ''; rows.push(row); row = []; }
    else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}
const CSV_FIELDS = [
  ['date', 'Date', /date|time/i],
  ['program', 'Brand / program / product', /advertiser|merchant|campaign|program|brand|store|^name$|product|title/i],
  ['order_ref', 'Order or reference', /order|transaction|reference|^id$/i],
  ['commission', 'Commission (required)', /commission|ad fees|earning|payout|bounty/i],
  ['sale_amount', 'Sale amount', /revenue|sale|gmv|total/i, /amount|price/i],
  ['status', 'Status', /status|state/i]
];
function normDate(v) {
  v = String(v || '').trim();
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(v);
  if (iso) return iso[1];
  const d = new Date(v);
  return v && !isNaN(d) ? ymd(d) : v;
}
function openCsv(name, text) {
  const all = parseCsv(text);
  const hi = all.findIndex((r) => r.filter((v) => v.trim() !== '').length >= 3);
  if (hi < 0 || all.length < hi + 2) { toast('That file has no table of rows I can read.'); return; }
  const headers = all[hi].map((h) => h.trim());
  S.csv = { name, headers, rows: all.slice(hi + 1) };
  const taken = new Set();
  const guess = {};
  for (const [key, , re, re2] of CSV_FIELDS) {
    let i = headers.findIndex((h, idx) => !taken.has(idx) && re.test(h));
    if (i < 0 && re2) i = headers.findIndex((h, idx) => !taken.has(idx) && re2.test(h));
    guess[key] = i; if (i >= 0) taken.add(i);
  }
  const netGuess = /fee-earnings|amazon|associates/i.test(name + headers.join(' ')) || headers.some((h) => /^asin$/i.test(h)) ? 'Amazon Associates' : '';
  const m = $('#modal');
  m.innerHTML = `<div class="sheet" id="csvsheet">
    <h3>Import affiliate CSV</h3>
    <p class="small muted" style="margin-top:-6px">${esc(name)} · ${S.csv.rows.length} rows · columns: ${esc(headers.join(', '))}</p>
    <datalist id="netlist">${NETWORKS.map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
    <label>Which network is this from?</label><input id="csv-net" list="netlist" value="${esc(netGuess)}" autocomplete="off">
    ${CSV_FIELDS.map(([key, label]) => `<label>${label}</label><select data-csv="${key}"><option value="-1">(not in this file)</option>${headers.map((h, i) => `<option value="${i}" ${guess[key] === i ? 'selected' : ''}>${esc(h)}</option>`).join('')}</select>`).join('')}
    <label>If the file has no status column, treat every row as</label>
    <select id="csv-status">${['approved', 'pending', 'paid'].map((s) => `<option>${s}</option>`).join('')}</select>
    <p class="small" id="csv-sum" style="margin:14px 0 0"></p>
    <div class="actions"><span class="sp"></span>
      <button type="button" class="btn" data-act="close">Cancel</button>
      <button type="button" class="btn primary" data-act="csvimport">Import</button></div></div>`;
  m.hidden = false;
  csvSummary();
}
function csvMapped() {
  const map = {};
  document.querySelectorAll('[data-csv]').forEach((s) => { map[s.dataset.csv] = Number(s.value); });
  const network = $('#csv-net').value.trim();
  const fallback = $('#csv-status').value;
  const seen = {};
  const out = [];
  let skipped = 0;
  for (const r of S.csv.rows) {
    const get = (k) => (map[k] >= 0 ? String(r[map[k]] ?? '').trim() : '');
    if (!hasNum(get('commission'))) { skipped++; continue; }
    const h = hash(r.join('\u0001'));
    seen[h] = (seen[h] || 0) + 1; // identical lines in one file are separate sales
    const status = low(get('status')) || fallback;
    out.push(['Affiliate', `csv:${low(network).replace(/[^a-z0-9]+/g, '-')}:${h}-${seen[h]}`, {
      network, program: get('program'), date: normDate(get('date')), order_ref: get('order_ref'),
      sale_amount: hasNum(get('sale_amount')) ? String(num(get('sale_amount'))) : '', commission: String(num(get('commission'))),
      currency: 'USD', status, paid: status === 'paid' ? 'yes' : 'no',
      source: 'CSV: ' + S.csv.name, synced_at: new Date().toISOString(), deleted: ''
    }]);
  }
  return { network, out, skipped, map };
}
function csvSummary() {
  const el = $('#csv-sum');
  if (!el || !S.csv) return;
  const { out, skipped, map } = csvMapped();
  if (map.commission < 0) { el.textContent = 'Pick the commission column to continue.'; return; }
  const total = out.reduce((s, c) => s + num(c[2].commission), 0);
  el.innerHTML = `<b>${out.length} rows</b> will be imported, commission total <b>${usd(total)}</b>.` +
    (skipped ? ` ${skipped} rows have no number in the commission column and are skipped.` : '') +
    ' Importing the same file again updates the same rows instead of doubling them.';
}

/* ----------------------------------------------------------------- events */
const ACT = {
  nav(el) { S.view = el.dataset.view; S.q = ''; render(); window.scrollTo(0, 0); },
  sync() { if (!navigator.onLine) toast('You are offline. Showing saved data.'); else sync(); },
  yt() {
    if (!navigator.onLine) return toast('You are offline.');
    toast('Asking Google… this can take a minute or two');
    sync(v2() ? 'refreshAll' : 'refreshYouTube');
  },
  period(el) { S.period = el.dataset.p; render(); },
  filter(el) { S.filter[S.view] = el.dataset.f; render(); },
  rfilter(el) { S.filter.review = el.dataset.f; render(); },
  review() {
    const dealsFirst = !T('Payments').some((r) => r.needs_review);
    S.view = dealsFirst ? 'Deals' : 'Payments'; S.filter[S.view] = 'review'; S.q = ''; render();
  },
  add(el) { openForm(el.dataset.table, null); },
  edit(el) { openForm(el.dataset.table, el.dataset.id); },
  close() { closeForm(); },
  del() {
    const f = $('#form');
    if (!confirm('Delete this entry? It is removed from the app and marked deleted in your Sheet.')) return;
    closeForm(); mutate(f.dataset.table, f.dataset.id, { deleted: '1' });
  },
  qdeal(el) {
    const q = queueRow(el.dataset.id); if (!q) return;
    const amounts = String(q.amounts || '').split(', ').filter(Boolean);
    openForm('Deals', null, {
      brand: q.brand_guess, date: q.received, contact: q.from, stage: 'pitched',
      cash_agreed: amounts.length === 1 && hasNum(amounts[0].replace(/usd/i, '')) ? String(num(amounts[0].replace(/usd/i, ''))) : '',
      notes: [q.amounts && 'Amounts mentioned in the email: ' + q.amounts, q.dates && 'Dates mentioned: ' + q.dates].filter(Boolean).join('\n'),
      source: 'Gmail: ' + q.subject
    }, q.id);
  },
  qpay(el) {
    const q = queueRow(el.dataset.id); if (!q) return;
    openForm('Payments', null, {
      date: q.received, payer: q.kind === 'payment' ? q.payer : q.brand_guess, income_type: 'Unknown',
      brand_or_program: q.brand_guess, amount_usd: q.kind === 'payment' ? q.amount_usd : '', status: 'Received',
      evidence: 'Gmail: ' + q.subject
    }, q.id);
  },
  qaff(el) {
    const q = queueRow(el.dataset.id); if (!q) return;
    mutateMany([
      ['Affiliate', 'goaffpro:' + (q.order_ref || q.id), {
        network: 'GoAffPro', program: q.brand_guess, date: q.received, order_ref: q.order_ref, sale_amount: q.sale_amount,
        commission: q.amount_usd, currency: 'USD', status: 'pending', paid: 'no', source: 'Gmail: ' + q.subject,
        synced_at: new Date().toISOString(), deleted: ''
      }],
      ['Queue', q.id, { status: 'approved' }]
    ]);
    toast('Added to the affiliate log');
  },
  qdismiss(el) { mutate('Queue', el.dataset.id, { status: 'dismissed' }); },
  qrestore(el) { mutate('Queue', el.dataset.id, { status: 'new' }); },
  pickcsv() { const f = $('#csvfile'); if (f) f.click(); },
  csvimport() {
    const { network, out, map } = csvMapped();
    if (!network) return toast('Say which network this file is from');
    if (map.commission < 0) return toast('Pick the commission column');
    if (!out.length) return toast('No rows with a commission amount');
    closeForm();
    mutateMany(out);
    S.filter.Affiliate = 'net:' + network; render();
    toast(`Imported ${out.length} rows from ${network}`);
  },
  async connect() {
    let url = $('#c-url').value.trim(), key = $('#c-key').value.trim();
    const code = $('#c-code').value.trim();
    if (code) {
      try { const o = JSON.parse(atob(code)); url = o.u; key = o.k; } catch (e) { S.err = 'That connection code is not valid.'; return render(); }
    }
    if (!validUrl(url || '')) { S.err = 'The web app URL should look like https://script.google.com/macros/s/…/exec'; return render(); }
    if (!key) { S.err = 'Paste the secret key.'; return render(); }
    const cfg = { url, key };
    $('#view').innerHTML = '<div class="empty">Connecting…</div>';
    try {
      const res = await api({ action: 'sync', changes: [] }, cfg);
      if (!res.ok) throw new Error(res.error || 'Could not connect');
      S.cfg = cfg; S.err = null; S.outbox = []; takeSnapshot(res);
      await persist();
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
    } catch (e) { S.err = 'Could not connect: ' + e.message; }
    render();
  },
  async copycode() {
    const code = btoa(JSON.stringify({ u: S.cfg.url, k: S.cfg.key }));
    try { await navigator.clipboard.writeText(code); toast('Connection code copied'); } catch (e) { prompt('Copy this code:', code); }
  },
  async disconnect() {
    const n = S.outbox.length;
    if (!confirm((n ? n + ' unsent change(s) will be lost. ' : '') + 'Remove the saved data and key from this device? Your Google Sheet is not touched.')) return;
    S.cfg = null; S.data = null; S.outbox = []; S.lastSync = null; S.err = null; S.view = 'dash';
    await persist(); render();
  }
};
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (el && ACT[el.dataset.act]) { e.preventDefault(); ACT[el.dataset.act](el); return; }
  if (e.target.id === 'modal') closeForm();
});
document.addEventListener('submit', (e) => { e.preventDefault(); if (e.target.id === 'form') saveForm(e.target); });
document.addEventListener('input', (e) => {
  if (e.target.id === 'q') { S.q = e.target.value; const l = $('#list'); if (l) l.innerHTML = listHtml(S.view); }
  if (e.target.id === 'csv-net') csvSummary();
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'csvfile' && e.target.files[0]) {
    const file = e.target.files[0];
    const reader = new FileReader();
    reader.onload = () => openCsv(file.name, String(reader.result));
    reader.onerror = () => toast('Could not read that file');
    reader.readAsText(file);
    e.target.value = '';
  }
  if (e.target.dataset && (e.target.dataset.csv || e.target.id === 'csv-status')) csvSummary();
});
window.addEventListener('online', () => { renderStatus(); sync(); });
window.addEventListener('offline', renderStatus);
document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });
setInterval(() => { if (!document.hidden) { renderStatus(); if (Date.now() - new Date(S.lastSync || 0).getTime() > 110000) sync(); } }, 30000);

/* ------------------------------------------------------------------ start */
(async function start() {
  try {
    const st = await kvGet('state');
    if (st) {
      S.cfg = st.cfg; S.data = st.data; S.outbox = st.outbox || []; S.lastSync = st.lastSync;
      if (S.data) for (const name of ALL_TABLES) if (!S.data.tables[name]) S.data.tables[name] = [];
    }
  } catch (e) { console.error(e); }
  render();
  if (S.cfg) sync();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch((e) => console.error('Offline mode unavailable', e));
})();
