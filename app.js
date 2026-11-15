'use strict';
/* Collab HQ app (phases 1-3). No build step, no libraries.
   - Data is cached on this device in IndexedDB, so everything works offline.
   - Edits made offline wait in an "outbox" and are sent on the next sync.
   - Nothing here makes up numbers: every figure is summed from rows in your Google Sheet.
   - Emails found by the backend land in Review. Nothing becomes a deal or payment until you approve it. */

const STAGES = ['talking', 'in progress', 'owed', 'done', 'on hold', 'declined'];
const LIVE = ['talking', 'in progress', 'owed'];
const PAST = ['done', 'on hold', 'declined'];
const ACTIVE_STAGES = ['signed', 'delivered', 'invoiced', 'disputed'];
const INCOME_TYPES = ['Brand cash', 'Affiliate commission', 'YouTube AdSense', 'Platform payout',
  'Review-unit resale', 'Marketplace sale', 'Unknown'];
const RESALE_TYPES = ['review-unit resale', 'marketplace sale'];
const PAY_STATUS = ['Received', 'Pending', 'Disputed', 'Report'];
const CONTRACT_STATUS = ['Signed', 'Sent', 'Not signed', 'Reference only'];
const AFF_STATUS = ['pending', 'approved', 'paid', 'declined'];
const AFF_DEAD = ['declined', 'deleted', 'reversed', 'rejected', 'cancelled', 'canceled'];
const NETWORKS = ['Amazon Associates', 'GoAffPro', 'UpPromote', 'Levanta', 'Awin', 'Impact'];
const VIEWS = [['home', 'Home'], ['review', 'Review'], ['money', 'Money'], ['more', 'More']];
const MORE_VIEWS = ['more', 'Contracts'];
const ALL_TABLES = ['Brands', 'Deals', 'Payments', 'Contracts', 'Sources', 'Payouts', 'Affiliate', 'Queue'];

const FORMS = {
  Deals: {
    title: 'deal',
    fields: [
      ['brand', 'Brand', 'brand'], ['product', 'Product', 'text'],
      ['stage', 'Stage', 'select', STAGES],
      ['next_step', 'Next step (what happens next)', 'text', null, 4], ['due_date', 'Due date (YYYY-MM-DD)', 'text', null, 4],
      ['cash_agreed', 'Cash they pay you ($). Leave empty for product only.', 'money'],
      ['deliverables', 'What you deliver', 'area'], ['contact', 'Contact (name / email)', 'text'],
      ['date', 'Deal date (YYYY-MM-DD or YYYY-MM)', 'text', null, 0, 1], ['deal_type', 'Deal type', 'text', null, 0, 1],
      ['product_value', 'Product value ($)', 'money', null, 0, 1], ['resale_value', 'Resale value ($)', 'money', null, 0, 1],
      ['cash_received', 'Cash received so far ($)', 'money', null, 0, 1], ['affiliate', 'Affiliate terms', 'text', null, 0, 1],
      ['contract', 'Contract', 'text', null, 0, 1], ['status_note', 'Status note', 'text', null, 0, 1],
      ['notes', 'Notes', 'area', null, 0, 1], ['source', 'Where this info came from', 'text', null, 0, 1],
      ['needs_review', 'Flag (why this needs a second look; clear it when sorted)', 'text', null, 0, 1]
    ],
    defaults: () => ({ stage: 'talking', date: today(), source: 'Added in app' })
  },
  Payments: {
    title: 'payment',
    fields: [
      ['date', 'Date (YYYY-MM-DD)', 'text'], ['payer', 'Payer as shown', 'text'],
      ['income_type', 'What kind of income', 'select', INCOME_TYPES], ['brand_or_program', 'Brand or program', 'brand'],
      ['amount_usd', 'Amount ($)', 'money'], ['status', 'Status', 'select', PAY_STATUS],
      ['expected_date', 'If pending: date you expect it (YYYY-MM-DD)', 'text'],
      ['note', 'Note', 'area'],
      ['fee', 'Fee ($)', 'money', null, 0, 1], ['net', 'Net ($)', 'money', null, 0, 1],
      ['evidence', 'Evidence (where the proof is)', 'text', null, 0, 1],
      ['needs_review', 'Flag (why this needs a second look; clear it when sorted)', 'text', null, 0, 1]
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
  syncing: false, err: null, view: 'home', period: 'month', col: 'in progress', open: false, money: 'Payments',
  filter: { Deals: 'past', Payments: 'all', Contracts: 'all', Affiliate: 'all', review: 'new' }, q: '', csv: null,
  busy: false, bfMsg: ''
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
const v4 = () => !!(S.data && S.data.version >= 4);
const v3 = () => !!(S.data && S.data.version >= 3);
const v5 = () => !!(S.data && S.data.version >= 5);
// Real AdSense payouts (date + exact amount) and the balance AdSense has not paid out yet.
const adsPaid = () => ((S.data && S.data.adsense) || []).filter((r) => r.status === 'paid' && r.date && hasNum(r.amount_usd));
const adsUnpaid = () => ((S.data && S.data.adsense) || []).filter((r) => r.status === 'unpaid' && num(r.amount_usd) > 0);
const brandMatch = (a, b) => !!low(a) && !!low(b) && (low(a).startsWith(low(b)) || low(b).startsWith(low(a)));

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
    version: res.version || 1, tables: res.tables, youtube: res.youtube || [], adsense: res.adsense || [], meta: res.meta || {},
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

function absorb(res, sent) {
  if (!res.ok) throw new Error(res.error || 'Sync failed');
  const done = new Set(sent.map((c) => c.seq));
  S.outbox = S.outbox.filter((c) => !done.has(c.seq));
  takeSnapshot(res);
  S.outbox.forEach(applyLocal); // edits made while the request was in flight
  S.err = null;
}
async function sync(action = 'sync') {
  if (!S.cfg || S.syncing || S.busy) return;
  if (!navigator.onLine) { renderStatus(); return; }
  S.syncing = true; renderStatus();
  const sent = S.outbox.slice();
  try {
    absorb(await api({ action, changes: sent }), sent);
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
  const deposits = adsPaid();
  if (deposits.length) {
    // Cash basis: what AdSense actually paid, on the day it paid.
    out.deposits = deposits.filter((r) => inPeriod(r.date, p));
    for (const r of out.deposits) out.yt += num(r.amount_usd);
    if (out.deposits.length) out.bySource['AdSense deposits (YouTube)'] = out.yt;
  } else {
    for (const [d, v] of (S.data.youtube || [])) if (inPeriod(d, p)) { out.yt += v; out.ytDays++; }
    if (out.ytDays) out.bySource['YouTube AdSense (estimated)'] = out.yt;
  }
  for (const d of T('Deals')) {
    if (!hasNum(d.product_value) || ['talking', 'declined'].includes(stageOf(d)) || !inPeriod(d.date, p)) continue;
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
function flagged() {
  return T('Payments').filter((r) => r.needs_review).map((r) => ['Payments', r])
    .concat(T('Deals').filter((r) => r.needs_review).map((r) => ['Deals', r]));
}
function listTable() { return S.view === 'money' ? S.money : S.view; }
function renderTabs() {
  const el = $('#tabs');
  el.hidden = !S.data;
  const n = T('Queue').filter((q) => low(q.status) === 'new').length + flagged().length;
  el.innerHTML = VIEWS.map(([v, label]) => {
    const on = S.view === v || (v === 'more' && MORE_VIEWS.includes(S.view));
    return `<button data-act="nav" data-view="${v}" class="${on ? 'on' : ''}">${label}${v === 'review' && n ? ` <span class="count">${n}</span>` : ''}</button>`;
  }).join('');
}
function render() {
  renderStatus(); renderTabs();
  const v = $('#view');
  if (!S.data) { v.innerHTML = connectHtml(); return; }
  if (S.view === 'home') { v.innerHTML = homeHtml(); restoreBoard(); }
  else if (S.view === 'review') v.innerHTML = reviewHtml();
  else if (S.view === 'money') v.innerHTML = moneyHtml();
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
function fmtDay(d) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d || ''));
  if (!m) return String(d || '');
  const opt = { month: 'short', day: 'numeric' };
  if (m[1] !== curYear()) opt.year = 'numeric';
  return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleString('en-US', opt);
}

/* Deals: three live stages on the board. Older stage names in the Sheet are read as the new ones. */
const STAGE_MAP = { pitched: 'talking', negotiating: 'talking', signed: 'in progress', delivered: 'owed', invoiced: 'owed', disputed: 'owed', paid: 'done', closed: 'done' };
const STAGE_LABEL = { talking: 'Talking', 'in progress': 'In progress', owed: 'Owed', done: 'Done', 'on hold': 'On hold', declined: 'Declined' };
const EMPTY_COL = { talking: 'No open conversations.', 'in progress': 'Nothing in production.', owed: 'Nobody owes you money.' };
function stageOf(d) {
  const s = low(d.stage);
  return STAGE_MAP[s] || (STAGES.includes(s) ? s : 'talking');
}
/** What to do next on a deal: your own note if you wrote one, otherwise a plain line from its stage. */
function nextStep(d) {
  const st = stageOf(d);
  const due = /^\d{4}-\d{2}-\d{2}$/.test(d.due_date || '') ? d.due_date : '';
  let text = String(d.next_step || '').trim();
  if (!text) {
    if (st === 'talking') text = 'Waiting on the brand';
    else if (st === 'in progress') text = d.deliverables ? 'Deliver: ' + d.deliverables : 'Make and deliver the content';
    else if (st === 'owed') {
      const owed = num(d.cash_agreed) - num(d.cash_received);
      text = owed > 0 ? 'Waiting on ' + usd(owed) : 'Waiting on payment';
    }
  }
  return { text, due, late: !!due && due < today() && ['talking', 'in progress', 'owed'].includes(st) };
}
/** The stage a deal naturally goes to next. Product-only deals skip Owed. */
function nextStage(d) {
  const st = stageOf(d);
  if (st === 'talking') return 'in progress';
  if (st === 'in progress') return num(d.cash_agreed) > 0 ? 'owed' : 'done';
  if (st === 'owed') return 'done';
  return '';
}
function liveDeals(stage) {
  return T('Deals').filter((d) => stageOf(d) === stage).sort((a, b) =>
    (nextStep(a).due || '9999').localeCompare(nextStep(b).due || '9999') || String(b.date ?? '').localeCompare(String(a.date ?? '')));
}
function dealCardHtml(d) {
  const n = nextStep(d);
  const cash = hasNum(d.cash_agreed) && num(d.cash_agreed) > 0 ? usd(num(d.cash_agreed)) : '';
  return `<button class="dcard" data-act="edit" data-table="Deals" data-id="${esc(d.id)}">
    <div class="dc1"><span class="t">${esc(d.brand)}</span><span class="a">${cash}</span></div>
    <div class="dc2">${esc(d.product)}</div>
    <div class="dc3${n.late ? ' late' : ''}">${esc(n.text)}${n.due ? ` · ${n.late ? 'was due' : 'due'} ${esc(fmtDay(n.due))}` : ''}</div>
  </button>`;
}
function boardHtml() {
  const cols = LIVE.map((k) => [k, STAGE_LABEL[k], liveDeals(k)]);
  const past = T('Deals').length - cols.reduce((s, c) => s + c[2].length, 0);
  return `<div class="boardhead"><h1>Deals</h1><button class="btn primary sm" data-act="add" data-table="Deals">+ New deal</button></div>
  <div class="coltabs">${cols.map(([k, label, list]) => `<button data-act="col" data-col="${k}" class="${S.col === k ? 'on' : ''}">${label} <b>${list.length}</b></button>`).join('')}</div>
  <div class="board" id="board">${cols.map(([k, label, list]) => `<section class="col" data-col="${k}">
      <div class="colhead">${label} <span>${list.length}</span></div>
      ${list.length ? list.map(dealCardHtml).join('') : `<div class="empty small">${EMPTY_COL[k]}</div>`}
    </section>`).join('')}</div>
  <button class="link" data-act="past">Past deals (${past}) ›</button>`;
}
/** On a phone the board shows one column at a time: keep the swipe position and the stage tabs in step. */
let colLock = 0;
/** Phone only: make the board as tall as the column on screen, so short columns leave no empty gap. */
function fitBoard() {
  const b = $('#board');
  if (!b) return;
  const col = b.querySelector(`.col[data-col="${S.col}"]`);
  b.style.height = b.scrollWidth > b.clientWidth + 4 && col ? col.offsetHeight + 'px' : '';
}
function restoreBoard() {
  const b = $('#board');
  if (!b) return;
  const swipes = () => b.scrollWidth > b.clientWidth + 4;
  if (swipes()) b.scrollLeft = Math.max(0, LIVE.indexOf(S.col)) * b.clientWidth;
  fitBoard();
  b.addEventListener('scroll', () => {
    if (!swipes() || Date.now() < colLock) return; // ignore the animation started by tapping a stage tab
    const k = LIVE[Math.round(b.scrollLeft / b.clientWidth)] || LIVE[0];
    if (k === S.col) return;
    S.col = k;
    document.querySelectorAll('.coltabs button').forEach((x) => x.classList.toggle('on', x.dataset.col === k));
    fitBoard();
  }, { passive: true });
}

function breakdownHtml() {
  const cur = totals(S.period);
  const m = S.data.meta || {};
  const by = affTotals(S.period);
  const nets = Object.keys(by).sort();
  return `<div class="seg" style="margin-top:14px">
      ${[['month', 'This month'], ['ytd', 'This year'], ['all', 'All-time']].map(([p, l]) => `<button data-act="period" data-p="${p}" class="${S.period === p ? 'on' : ''}">${l}</button>`).join('')}
    </div>
    <h3>Where it came from</h3>${barsHtml(cur.bySource)}
    ${cur.deposits && cur.deposits.length ? `<h3>AdSense deposits</h3>
      ${cur.deposits.slice().reverse().map((r) => `<div class="kv"><span>${esc(fmtDay(r.date))}</span><b>${usd(num(r.amount_usd))}</b></div>`).join('')}
      <div class="kv"><span>Total</span><b>${usd(cur.yt)}</b></div>
      <div class="src">Source: AdSense, exact amounts · synced ${esc(when(m.adsense_last_sync))}</div>` : ''}
    <h3>Who paid</h3>${barsHtml(cur.byBrand)}
    <div class="src">Brands and programs from your logged payments. YouTube is not split by brand.</div>
    <h3>Also received, not counted as earned</h3>
    <div class="kv"><span>Bikes and gear you sold</span><b>${usd(cur.resale)}</b></div>
    <div class="kv"><span>Value of products brands sent you <span class="muted small">(${cur.productDeals} deals)</span></span><b>${usd(cur.product)}</b></div>
    <div class="src">From your Payments and Deals tabs.</div>
    ${nets.length ? `<h3>Affiliate sales the networks report</h3>
      <div class="tbl"><div class="tr th"><span>Network</span><span>Pending</span><span>Approved</span><span>Paid out</span></div>
      ${nets.map((n) => `<div class="tr"><span>${esc(n)}</span><span>${usd(by[n].pending)}</span><span>${usd(by[n].approved)}</span><span>${usd(by[n].paid)}</span></div>`).join('')}</div>
      <div class="src">Counts as earned once the payment is logged.${m.awin_last_sync ? ' Awin synced ' + esc(when(m.awin_last_sync)) + '.' : ''}</div>` : ''}`;
}
function earningsHtml() {
  const m = S.data.meta || {};
  const ytOk = (S.data.youtube || []).length > 0;
  const cells = [['month', monthName()], ['ytd', curYear()], ['all', 'All-time']].map(([p, label]) =>
    `<div><div class="lab">${esc(label)}</div><div class="val">${usd(totals(p).total)}</div></div>`).join('');
  const src = adsPaid().length
    ? `Payments you logged + AdSense deposits since ${esc(fmtDay(m.adsense_first_date))} (actual, not estimates) · synced ${esc(when(S.lastSync))}`
    : ytOk
    ? `Payments you logged + YouTube estimate through ${esc(fmtDay(m.yt_data_through))} · synced ${esc(when(S.lastSync))}`
    : `Payments you logged only. YouTube ${m.yt_last_error ? 'failed: ' + esc(m.yt_last_error) : 'not synced yet'} · synced ${esc(when(S.lastSync))}`;
  return `<div class="card"><h2>Earned</h2><div class="earn">${cells}</div><div class="src">${src}</div>
    <button class="fold" data-act="fold">${S.open ? 'Hide breakdown' : 'Show breakdown'}</button>
    ${S.open ? breakdownHtml() : ''}</div>`;
}
function owedHtml() {
  const m = S.data.meta || {};
  const pays = T('Payments');
  let rows;
  if (v2()) {
    rows = T('Payouts').filter((r) => low(r.status) !== 'paid').map((r) => ({
      name: r.source, when: r.expected_date, amount: r.amount_usd, status: low(r.status)
    }));
  } else {
    rows = pays.filter((r) => low(r.status) === 'pending').map((r) => ({ name: brandKey(r.brand_or_program), when: '', amount: r.amount_usd, status: 'no date' }));
  }
  pays.filter((r) => low(r.status) === 'disputed').forEach((r) => rows.push({ name: brandKey(r.brand_or_program), when: '', amount: r.amount_usd, status: 'disputed' }));
  rows.sort((a, b) => String(a.when || '9999').localeCompare(String(b.when || '9999')));
  const total = rows.reduce((s, r) => s + (r.status === 'disputed' ? 0 : num(r.amount)), 0); // disputed money is not expected
  const line = (r) => {
    const sub = r.status === 'disputed' ? 'in dispute' : r.status === 'overdue' ? 'was due ' + fmtDay(r.when) : r.when ? 'expected ' + fmtDay(r.when) : 'no date set';
    const cls = r.status === 'overdue' || r.status === 'disputed' ? 'bad' : '';
    return `<div class="kv"><span>${esc(r.name)}<br><span class="small ${cls ? 'late' : 'muted'}">${esc(sub)}</span></span><b>${hasNum(r.amount) ? usd(num(r.amount)) : '?'}</b></div>`;
  };
  return `<div class="card"><h2>Money owed to you</h2>
    ${rows.length ? `<div class="earn one"><div><div class="lab">Total expected</div><div class="val">${usd(total)}</div></div></div>${rows.map(line).join('')}` : '<div class="empty small">Nothing outstanding.</div>'}
    ${adsUnpaid().map((r) => `<div class="kv"><span>${r.kind === 'youtube' ? 'YouTube balance' : 'Other AdSense balance'} waiting at AdSense right now<br><span class="small muted">not added to the total: the YouTube lines above estimate this same money</span></span><b>${usd(num(r.amount_usd))}</b></div>`).join('')}
    ${adsUnpaid().length ? `<div class="src">Balance from AdSense · synced ${esc(when(m.adsense_last_sync))}</div>` : ''}
    <div class="src">Payments marked Pending + YouTube estimates${v2() ? ' · calendar updated ' + esc(when(m.payouts_last_sync)) : ''}</div>
    ${rows.some((r) => r.status === 'no date') ? '<div class="src">To get a calendar reminder, open the payment under Money and add an expected date.</div>' : ''}
  </div>`;
}
function homeHtml() {
  const overdue = T('Payouts').filter((r) => low(r.status) === 'overdue');
  const late = T('Deals').filter((d) => nextStep(d).late);
  return `
  ${overdue.length ? `<div class="alert bad"><span>Overdue: ${esc(overdue.map((r) => r.source + (hasNum(r.amount_usd) ? ' ' + usd(num(r.amount_usd)) : '')).join(', '))}</span></div>` : ''}
  ${late.length ? `<div class="alert"><span>${late.length} deal${late.length === 1 ? ' is' : 's are'} past the due date: ${esc(late.map((d) => d.brand).join(', '))}</span></div>` : ''}
  ${v4() && !v5() ? `<div class="alert"><span>YouTube money is still an estimate. Real AdSense deposits switch on after the backend update (SETUP.md, Part G).</span></div>` : ''}
  ${!v4() ? `<div class="alert"><span>Your own next steps and due dates switch on after the backend update (SETUP.md, Part F).</span></div>` : ''}
  ${boardHtml()}
  <div class="grid2">${earningsHtml()}${owedHtml()}</div>`;
}

function stageClass(s) {
  s = low(s);
  if (['paid', 'closed', 'received', 'signed', 'approved', 'done'].includes(s)) return 'good';
  if (['delivered', 'invoiced', 'pending', 'on hold', 'sent', 'report', 'expected', 'check', 'no date', 'new', 'owed', 'in progress'].includes(s)) return 'warn';
  if (['disputed', 'declined', 'not signed', 'overdue', 'dismissed', ...AFF_DEAD].includes(s) || s.startsWith('not ')) return 'bad';
  return '';
}

/* ----------------------------------------------------------- list screens */
function chipsFor(table) {
  const rows = T(table);
  const count = (fn) => rows.filter(fn).length;
  if (table === 'Deals') {
    return [['past', 'All past', count((d) => PAST.includes(stageOf(d)))],
      ...PAST.map((s) => [s, STAGE_LABEL[s], count((d) => stageOf(d) === s)]),
      ['all', 'Every deal', rows.length]];
  }
  if (table === 'Payments') {
    const types = [...new Set(rows.map((r) => (r.income_type || 'Unknown').trim()))].sort();
    return [['all', 'All', rows.length], ['pending', 'Pending', count((r) => low(r.status) === 'pending')],
      ...types.map((t) => ['type:' + t, t === 'Unknown' ? 'Unlabeled' : t, count((r) => (r.income_type || 'Unknown').trim() === t)])];
  }
  if (table === 'Affiliate') {
    const nets = [...new Set(rows.map((r) => r.network || 'Other'))].sort();
    return [['all', 'All', rows.length], ...nets.map((n) => ['net:' + n, n, count((r) => (r.network || 'Other') === n)])];
  }
  return [['all', 'All', rows.length], ['linked', 'PDF saved', count((r) => r.drive_url)], ['nopdf', 'No PDF yet', count((r) => !r.drive_url)]];
}
function filtered(table) {
  const f = S.filter[table], q = low(S.q);
  let rows = T(table).filter((r) => {
    if (f === 'all') return true;
    if (f === 'past') return PAST.includes(stageOf(r));
    if (f === 'pending') return low(r.status) === 'pending';
    if (f === 'linked') return !!r.drive_url;
    if (f === 'nopdf') return !r.drive_url;
    if (f.startsWith('type:')) return (r.income_type || 'Unknown').trim() === f.slice(5);
    if (f.startsWith('net:')) return (r.network || 'Other') === f.slice(4);
    return table === 'Deals' ? stageOf(r) === f : true;
  });
  if (q) rows = rows.filter((r) => low(Object.values(r).join(' ')).includes(q));
  return rows.sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')));
}
function itemHtml(table, r) {
  const flag = r.needs_review ? `<div class="l3"><span class="badge warn">Flagged</span> ${esc(r.needs_review)}</div>` : '';
  if (table === 'Deals') {
    const st = stageOf(r);
    const money = hasNum(r.cash_agreed) && num(r.cash_agreed) > 0 ? usd(num(r.cash_agreed)) : (hasNum(r.product_value) ? usd(num(r.product_value)) + ' product' : '');
    return `<button class="item" data-act="edit" data-table="Deals" data-id="${esc(r.id)}">
      <div class="l1"><span class="t">${esc(r.brand)}</span><span class="a">${money}</span></div>
      <div class="l2">${esc(r.product)}${r.date ? ' · ' + esc(r.date) : ''} <span class="badge ${stageClass(st)}">${esc(STAGE_LABEL[st])}</span></div>
      ${flag}</button>`;
  }
  if (table === 'Payments') {
    const st = low(r.status);
    const type = low(r.income_type) === 'unknown' || !r.income_type ? 'Unlabeled' : r.income_type;
    return `<button class="item" data-act="edit" data-table="Payments" data-id="${esc(r.id)}">
      <div class="l1"><span class="t">${esc(r.payer || r.brand_or_program)}</span><span class="a">${hasNum(r.amount_usd) ? usd(num(r.amount_usd)) : '<span class="muted">no amount</span>'}</span></div>
      <div class="l2">${esc(fmtDay(r.date))} · ${esc(type)}${st !== 'received' ? ` <span class="badge ${stageClass(st)}">${esc(st)}${st === 'pending' && r.expected_date ? ' · ' + esc(fmtDay(r.expected_date)) : ''}</span>` : ''}</div>
      ${flag}</button>`;
  }
  if (table === 'Affiliate') {
    const b = affBucket(r);
    return `<button class="item" data-act="edit" data-table="Affiliate" data-id="${esc(r.id)}">
      <div class="l1"><span class="t">${esc(r.program || r.network)}</span><span class="a">${hasNum(r.commission) ? usd(num(r.commission)) : '<span class="muted">no amount</span>'}</span></div>
      <div class="l2">${esc(fmtDay(r.date))} · ${esc(r.network)}${hasNum(r.sale_amount) ? ' · sale ' + usd(num(r.sale_amount)) : ''} <span class="badge ${stageClass(b)}">${b === 'paid' ? 'paid out' : esc(b)}</span></div></button>`;
  }
  return `<button class="item" data-act="edit" data-table="Contracts" data-id="${esc(r.id)}">
    <div class="l1"><span class="t">${esc(r.brand)}</span><span class="a small muted">${esc(r.date)}</span></div>
    <div class="l2">${esc(r.document)} <span class="badge ${r.drive_url ? 'good' : ''}">${r.drive_url ? 'PDF saved' : 'no PDF yet'}</span></div>
    <div class="l3">${esc(r.status)}</div></button>`;
}
function listHtml(table) {
  const rows = filtered(table);
  if (!rows.length) return '<div class="empty">Nothing here.</div>';
  const cap = 300;
  return rows.slice(0, cap).map((r) => itemHtml(table, r)).join('') +
    (rows.length > cap ? `<div class="empty small">Showing the newest ${cap} of ${rows.length}. Search or filter to narrow down.</div>` : '');
}
const LIST_TITLE = { Deals: 'Past deals', Contracts: 'Contracts', Payments: 'Payments', Affiliate: 'Affiliate sales' };
const LIST_SRC = {
  Payments: 'Every payment in your Sheet. Only ones marked Received count as earned.',
  Affiliate: 'What each network reports. Awin and Impact sync daily; the rest come from CSV files and approved emails.',
  Contracts: 'Drop a PDF in your Contracts folder with the brand in its name and it links itself.',
  Deals: 'Finished, declined and paused deals. Live ones are on Home.'
};
function listViewHtml(table) {
  const chips = chipsFor(table);
  const sub = table === 'Contracts' || table === 'Deals';
  const canAdd = table !== 'Affiliate' || v2();
  return `${sub ? `<div class="boardhead"><button class="link" data-act="nav" data-view="${table === 'Deals' ? 'home' : 'more'}">‹ ${table === 'Deals' ? 'Home' : 'More'}</button></div><h1>${LIST_TITLE[table]}</h1>` : ''}
    <div class="toolbar">
      <input type="search" id="q" placeholder="Search" value="${esc(S.q)}">
      ${table === 'Affiliate' ? `<button class="btn" data-act="pickcsv" ${v2() ? '' : 'disabled'}>Import CSV</button><input type="file" id="csvfile" accept=".csv,.tsv,.txt,text/csv" hidden>` : ''}
      <button class="btn primary" data-act="add" data-table="${table}" ${canAdd ? '' : 'disabled'}>+ Add</button>
    </div>
    <div class="chips">${chips.filter((c) => c[2] || c[0] === S.filter[table]).map(([k, l, n]) => `<button data-act="filter" data-f="${esc(k)}" class="${S.filter[table] === k ? 'on' : ''}">${esc(l)} ${n}</button>`).join('')}</div>
    <div class="list" id="list">${listHtml(table)}</div>
    <div class="src">${LIST_SRC[table]} Synced ${esc(when(S.lastSync))}.</div>`;
}
function moneyHtml() {
  return `<div class="seg wide">
      ${[['Payments', 'Payments'], ['Affiliate', 'Affiliate sales']].map(([k, l]) => `<button data-act="money" data-m="${k}" class="${S.money === k ? 'on' : ''}">${l}</button>`).join('')}
    </div>${listViewHtml(S.money)}`;
}


/* ----------------------------------------------------------------- review */
const KIND_LABEL = { deal: 'Labeled "Collab"', payment: 'Money received', affiliate: 'Referral sale', contract: 'Contract PDF', contact: 'Brand contact', label: 'Unknown payer' };
function reviewHtml() {
  const m = S.data.meta || {};
  const f = S.filter.review;
  const all = T('Queue');
  const flags = flagged();
  const n = (s) => all.filter((q) => low(q.status) === s).length;
  const chips = `<div class="chips">${[['new', 'New emails', n('new')], ['flagged', 'Flagged entries', flags.length], ['approved', 'Approved', n('approved')], ['dismissed', 'Dismissed', n('dismissed')]]
    .map(([k, l, c]) => `<button data-act="rfilter" data-f="${k}" class="${f === k ? 'on' : ''}">${l} ${c}</button>`).join('')}</div>`;
  let body;
  if (f === 'flagged') {
    body = flags.length ? flags.map(([t, r]) => itemHtml(t, r)).join('') : '<div class="empty">Nothing flagged.</div>';
    body += '<div class="src">Entries from your starting data that did not add up. Open one, fix it, and clear the Flag field.</div>';
  } else if (!v2()) {
    body = '<div class="empty">Email review switches on after the backend update (SETUP.md, Part D).</div>';
  } else {
    const rows = all.filter((q) => low(q.status) === f).sort((a, b) => String(b.received).localeCompare(String(a.received)));
    body = (rows.length ? rows.map(queueItemHtml).join('') : `<div class="empty">${f === 'new' ? 'Nothing waiting. You are caught up.' : 'Nothing here.'}</div>`) +
      `<div class="src">Nothing is saved until you approve it. Label a Gmail thread "Collab" to send it here · Gmail checked ${esc(when(m.gmail_last_scan))}${m.gmail_last_error ? ` · <span class="late">${esc(m.gmail_last_error)}</span>` : ''}</div>`;
  }
  return `<h1>Review</h1>${chips}<div class="list">${body}</div>`;
}

function queueItemHtml(q) {
  const isNew = low(q.status) === 'new';
  const title = q.kind === 'payment' || q.kind === 'label' ? q.payer : (q.brand_guess || q.from);
  let detail = '';
  if (q.kind === 'deal') {
    detail = `<div class="l3">${q.amounts ? 'Amounts mentioned: ' + esc(q.amounts) : 'No dollar amounts found'}${q.dates ? ' · Dates mentioned: ' + esc(q.dates) : ''}</div>`;
  } else if (q.kind === 'affiliate') {
    detail = `<div class="l3">Order ${esc(q.order_ref || '?')}${hasNum(q.sale_amount) ? ' · sale ' + usd(num(q.sale_amount)) : ''} · commission ${hasNum(q.amount_usd) ? usd(num(q.amount_usd)) : '?'}</div>`;
  }
  else if (q.kind === 'contract') {
    detail = `<div class="l3">File: ${esc(q.attachment)}</div>`;
    if (!isNew && low(q.status) === 'approved') {
      detail += `<div class="l3">${q.filed === '1' ? `<a href="${esc(q.drive_url)}" target="_blank" rel="noopener">Saved to Drive and linked</a>` : q.filed === 'failed' ? `<span class="badge bad">Not saved</span> ${esc(q.hint)}` : 'The PDF is saved to your Contracts folder on the next sync.'}</div>`;
    }
  } else if (q.kind === 'contact') {
    detail = `<div class="l3">Suggested contact for ${esc(q.brand_guess)}: ${esc(q.from)}</div><div class="l3">${esc(q.snippet)}</div>`;
  }
  if (q.hint && q.filed !== 'failed') detail += `<div class="l3"><span class="badge">Lead</span> ${esc(q.hint)}</div>`;
  const id = esc(q.id);
  let acts = '';
  if (isNew && q.kind === 'contract') {
    const cands = T('Contracts').filter((c) => !c.drive_url && brandMatch(c.brand, q.brand_guess)).slice(0, 4);
    acts = cands.map((c) => `<button class="btn primary sm" data-act="qfile" data-id="${id}" data-c="${esc(c.id)}">File under: ${esc(c.document)}</button>`).join('') +
      `<button class="btn sm" data-act="qcontract" data-id="${id}">New contract</button><button class="btn sm" data-act="qdismiss" data-id="${id}">Dismiss</button>`;
  } else if (isNew && q.kind === 'contact') {
    acts = `<button class="btn primary sm" data-act="qcontact" data-id="${id}">Save as contact</button><button class="btn sm" data-act="qdismiss" data-id="${id}">Dismiss</button>`;
  } else if (isNew && q.kind === 'label') {
    acts = `<button class="btn primary sm" data-act="qlabel" data-id="${id}">Label this payment</button><button class="btn sm" data-act="qdismiss" data-id="${id}">Dismiss</button>`;
  } else if (isNew) {
    if (q.kind === 'deal') acts = `<button class="btn primary sm" data-act="qdeal" data-id="${id}">Create deal</button><button class="btn sm" data-act="qpay" data-id="${id}">Log payment</button>`;
    else if (q.kind === 'payment') acts = `<button class="btn primary sm" data-act="qpay" data-id="${id}">Log payment</button>`;
    else acts = `<button class="btn primary sm" data-act="qaff" data-id="${id}">Add to affiliate log</button>`;
    acts += `<button class="btn sm" data-act="qdismiss" data-id="${id}">Dismiss</button>`;
  } else {
    acts = `<button class="btn sm" data-act="qrestore" data-id="${id}">Move back to New</button>`;
  }
  return `<div class="item static">
    <div class="l1"><span class="t">${esc(title)}</span><span class="a">${['payment', 'affiliate', 'label'].includes(q.kind) && hasNum(q.amount_usd) ? usd(num(q.amount_usd)) : ''}</span></div>
    <div class="l2">${esc(KIND_LABEL[q.kind] || q.kind)} · ${esc(q.received)}${q.from ? ' · ' + esc(q.from) : ''}</div>
    <div class="l3">${esc(q.subject)}</div>
    ${detail}
    ${q.kind === 'deal' && q.snippet ? `<div class="l3">“${esc(q.snippet)}”</div>` : ''}
    ${q.possible_duplicate ? `<div class="l3"><span class="badge warn">Possible duplicate</span> ${esc(q.possible_duplicate)}</div>` : ''}
    <div class="acts">${acts}${q.thread_url ? `<a class="btn sm" href="${esc(q.thread_url)}" target="_blank" rel="noopener">${q.from === 'Google Drive' ? 'Open file' : 'Open email'}</a>` : ''}</div>
  </div>`;
}
const queueRow = (id) => T('Queue').find((q) => q.id === id);

/* --------------------------------------------------------------- settings */
function backfillCardHtml() {
  if (!v3()) return v2() ? '<div class="card"><h2>Historical backfill</h2><p class="small muted" style="margin:0">Switches on after the next backend update (SETUP.md, Part E).</p></div>' : '';
  const m = S.data.meta || {};
  let st = null;
  try { st = JSON.parse(m.backfill_state || 'null'); } catch (e) { st = null; }
  const label = S.busy ? 'Scanning…' : st && st.done ? 'Scan again' : st ? 'Continue scan' : 'Start scan';
  const msg = S.bfMsg || (st && st.done ? `Finished ${esc(when(st.finished))}. ${st.added} items went to Review, ${st.dup} matched payments you already have.` : st ? 'A scan was started and has not finished.' : 'Not run yet.');
  return `<div class="card"><h2>Historical backfill</h2>
    <p class="small muted" style="margin:0 0 8px">Reads all of your Gmail and Drive once and sends what it finds to Review: old PayPal, Venmo and referral receipts that are not logged yet, leads on unknown payers, contract PDFs, and your contact at each brand. Nothing is saved until you approve it. It takes a few minutes; keep this screen open.</p>
    <p class="small" style="margin:0 0 10px">${esc(msg)}${m.backfill_last_error && !S.busy ? ` <span style="color:var(--bad)">Last problem: ${esc(m.backfill_last_error)}</span>` : ''}</p>
    <button class="btn primary" data-act="backfill" ${S.busy ? 'disabled' : ''}>${label}</button></div>`;
}
function settingsHtml() {
  const m = S.data.meta || {};
  const src = T('Sources');
  const line = (label, value, err) => `<div class="kv"><span>${label}${err ? `<br><span class="small late">${esc(err)}</span>` : ''}</span><b>${esc(value)}</b></div>`;
  return `<h1>More</h1>
  <div class="card"><div class="rowbtns">
      <button class="btn" data-act="nav" data-view="Contracts">Contracts (${T('Contracts').length})</button>
      <button class="btn" data-act="past">Past deals</button>
      ${S.data.sheet_url ? `<a class="btn" href="${esc(S.data.sheet_url)}" target="_blank" rel="noopener">Open Google Sheet</a>` : ''}
      ${S.data.folder_url ? `<a class="btn" href="${esc(S.data.folder_url)}" target="_blank" rel="noopener">Contracts folder</a>` : ''}
  </div></div>
  <div class="card"><h2>Sync</h2>
    ${line('Your Sheet', when(S.lastSync), S.err)}
    ${S.outbox.length ? line('Changes waiting to send', String(S.outbox.length)) : ''}
    ${line('YouTube', when(m.yt_last_sync), m.yt_last_error)}
    ${v5() ? line('AdSense deposits', m.adsense_last_sync ? when(m.adsense_last_sync) : 'not synced yet', m.adsense_last_error) : ''}
    ${v2() ? line('Gmail', when(m.gmail_last_scan), m.gmail_last_error) +
      line('Payout calendar', when(m.payouts_last_sync), m.payouts_last_error) +
      line('Awin', m.awin_last_sync ? when(m.awin_last_sync) : 'keys not added', m.awin_last_error) +
      line('Impact', m.impact_last_sync ? when(m.impact_last_sync) : 'keys not added', m.impact_last_error) : ''}
    <div class="rowbtns" style="margin-top:12px">
      <button class="btn primary" data-act="sync">Sync now</button>
      <button class="btn" data-act="yt">Fetch everything from Google</button>
    </div>
    <div class="src">Google is checked on its own every hour (YouTube and affiliates once a day).</div>
  </div>
  ${backfillCardHtml()}
  <div class="card"><h2>Where each number comes from</h2>
    ${src.map((s) => `<div class="kv"><span>${esc(s.name)}<br><span class="muted small">${esc(s.method)}</span></span><span class="small muted" style="white-space:nowrap">${s.last_synced ? esc(when(s.last_synced)) : ''}</span></div>`).join('') || '<div class="empty small">No sources listed.</div>'}
  </div>
  <div class="card"><h2>This device</h2>
    <div class="rowbtns">
      <button class="btn" data-act="copycode">Copy connection code</button>
      <button class="btn danger" data-act="disconnect">Disconnect</button>
    </div>
    <div class="src">The connection code sets up another device in one paste. Treat it like a password.</div>
  </div>`;
}


/* ------------------------------------------------------------------ forms */
function formFields(table) {
  return FORMS[table].fields.filter((f) => !f[4] || (S.data && S.data.version >= f[4]));
}
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
  const existing = id ? T(table).find((r) => r.id === id) : null;
  if (id && !existing) return;
  const row = id ? { ...existing, ...(preset || {}) } : { ...def.defaults(), ...(preset || {}) };
  if (table === 'Deals') row.stage = stageOf(row);
  let top = '';
  let extra = '';
  if (table === 'Deals' && id) {
    const to = nextStage(existing);
    top = `<div class="movebar"><span>Stage: <b>${esc(STAGE_LABEL[stageOf(existing)])}</b></span>
      ${to ? `<button type="button" class="btn primary sm" data-act="move" data-to="${to}">Move to ${esc(STAGE_LABEL[to])}</button>` : ''}</div>`;
    const cons = T('Contracts').filter((c) => brandMatch(c.brand, row.brand));
    if (cons.length) {
      extra = `<label>Contracts on file for ${esc(row.brand)}</label>` + cons.map((c) => `<div class="kv small"><span>${esc(c.document)} <span class="muted">· ${esc(c.date)}</span></span>${c.drive_url ? `<a href="${esc(c.drive_url)}" target="_blank" rel="noopener">Open PDF</a>` : `<span class="muted">no PDF yet</span>`}</div>`).join('');
    }
  }
  if (table === 'Contracts' && id && row.drive_url) extra = `<p class="small"><a href="${esc(row.drive_url)}" target="_blank" rel="noopener">Open PDF in Drive</a></p>`;
  const fields = formFields(table);
  const main = fields.filter((f) => !f[5]);
  const more = fields.filter((f) => f[5]);
  const m = $('#modal');
  m.innerHTML = `<form class="sheet" id="form" data-table="${table}" data-id="${esc(id || '')}" data-queue="${esc(queueId || '')}">
    <h3>${id ? 'Edit' : 'New'} ${def.title}</h3>
    ${queueId ? '<p class="small muted" style="margin-top:-6px">Filled in from the email. Check every field before saving.</p>' : ''}
    ${top}
    <datalist id="brandlist">${T('Brands').map((b) => `<option value="${esc(b.name)}">`).join('')}</datalist>
    <datalist id="netlist">${[...new Set(NETWORKS.concat(T('Affiliate').map((a) => a.network).filter(Boolean)))].map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
    ${main.map((f) => fieldHtml(f, row[f[0]])).join('')}
    ${more.length ? `<details class="morefields"><summary>More details</summary>${more.map((f) => fieldHtml(f, row[f[0]])).join('')}</details>` : ''}
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
  for (const [name, , type] of formFields(table)) {
    let v = form.elements[name].value.trim();
    if (type === 'money' && v !== '') {
      if (!hasNum(v)) { toast('"' + v + '" is not a number'); form.elements[name].focus(); return; }
      v = String(num(v));
    }
    fields[name] = v;
  }
  if ((table === 'Deals' || table === 'Contracts') && !fields.brand) { toast('Brand is required'); return; }
  if (table === 'Affiliate' && !fields.network) { toast('Network is required'); return; }
  if (table === 'Deals' && fields.due_date && !/^\d{4}-\d{2}-\d{2}$/.test(fields.due_date)) { toast('Due date must look like 2026-11-30'); return; }
  if (table === 'Payments' && fields.expected_date && !/^\d{4}-\d{2}-\d{2}$/.test(fields.expected_date)) { toast('Expected date must look like 2026-12-21'); return; }
  const isNew = !form.dataset.id;
  if (isNew) fields.deleted = '';
  const batch = [];
  if (table === 'Deals' && !T('Brands').some((b) => low(b.name) === low(fields.brand))) {
    batch.push(['Brands', uid(), { name: fields.brand, contact_name: '', contact_email: '', notes: '', deleted: '' }]);
  }
  batch.push([table, id, fields]);
  if (form.dataset.queue) {
    const q = queueRow(form.dataset.queue);
    batch.push(['Queue', form.dataset.queue, q && q.kind === 'contract' ? { status: 'approved', link_id: id } : { status: 'approved' }]);
  }
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
  filter(el) { S.filter[listTable()] = el.dataset.f; render(); },
  money(el) { S.money = el.dataset.m; S.q = ''; render(); },
  fold() { S.open = !S.open; render(); },
  past() { S.view = 'Deals'; S.filter.Deals = 'past'; S.q = ''; render(); window.scrollTo(0, 0); },
  col(el) {
    S.col = el.dataset.col;
    document.querySelectorAll('.coltabs button').forEach((x) => x.classList.toggle('on', x.dataset.col === S.col));
    const b = $('#board');
    colLock = Date.now() + 700;
    if (!b) return;
    fitBoard();
    const left = LIVE.indexOf(S.col) * b.clientWidth;
    b.scrollTo({ left, behavior: 'smooth' });
    setTimeout(() => { if (Math.abs(b.scrollLeft - left) > 4) b.scrollLeft = left; }, 500); // if the animation did not run
  },
  move(el) {
    const f = $('#form');
    const d = T('Deals').find((r) => r.id === f.dataset.id);
    if (!d) return;
    const to = el.dataset.to;
    const wasOwed = stageOf(d) === 'owed';
    closeForm();
    if (LIVE.includes(to)) S.col = to;
    mutate('Deals', d.id, v4() ? { stage: to, next_step: '', due_date: '' } : { stage: to });
    toast(to === 'done' && wasOwed ? 'Moved to Done. Log the payment under Money so it counts as earned.' : 'Moved to ' + STAGE_LABEL[to]);
  },
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
      brand: q.brand_guess, date: q.received, contact: q.from, stage: 'talking',
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
  qfile(el) {
    mutate('Queue', el.dataset.id, { status: 'approved', link_id: el.dataset.c });
    toast('Approved. The PDF is saved to your Contracts folder and linked on sync.');
  },
  qcontract(el) {
    const q = queueRow(el.dataset.id); if (!q) return;
    openForm('Contracts', null, {
      brand: q.brand_guess, document: String(q.attachment || '').replace(/\.pdf$/i, ''), date: q.received, status: 'Signed',
      where_to_find: q.from === 'Google Drive' ? 'Google Drive' : 'Gmail: ' + q.subject
    }, q.id);
  },
  qcontact(el) {
    const q = queueRow(el.dataset.id); if (!q) return;
    const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(q.from) || [null, '', q.from];
    const batch = [['Brands', q.link_id, { contact_name: m[1], contact_email: m[2] }]];
    for (const d of T('Deals')) if (!d.contact && low(d.brand) === low(q.brand_guess)) batch.push(['Deals', d.id, { contact: q.from }]);
    batch.push(['Queue', q.id, { status: 'approved' }]);
    mutateMany(batch);
    toast(`Saved. Also filled in on ${batch.length - 2} ${q.brand_guess} deal(s) that had no contact.`);
  },
  qlabel(el) {
    const q = queueRow(el.dataset.id); if (!q) return;
    const p = T('Payments').find((r) => r.id === q.link_id);
    if (!p) return toast('That payment is no longer in the list.');
    openForm('Payments', p.id, { brand_or_program: q.brand_guess, note: [p.note, q.hint].filter(Boolean).join(' | ') }, q.id);
  },
  async backfill() {
    if (!navigator.onLine) return toast('You are offline.');
    if (S.busy) return;
    let st = null;
    try { st = JSON.parse((S.data.meta || {}).backfill_state || 'null'); } catch (e) { st = null; }
    const reset = !!(st && st.done);
    if (reset && !confirm('Scan everything again? Items you already approved or dismissed stay as they are.')) return;
    S.busy = true; S.bfMsg = 'Starting…'; render();
    try {
      let waits = 0;
      for (let i = 0; i < 60; i++) {
        const sent = S.outbox.slice();
        const res = await api({ action: 'backfill', reset: reset && i === 0, changes: sent });
        absorb(res, sent);
        S.bfMsg = (res.backfill && res.backfill.message) || '';
        await persist(); render();
        if (!res.backfill || res.backfill.done) break;
        if (res.backfill.failed) {
          // Gmail's per-minute speed limit: wait it out and carry on, instead of asking for another tap.
          if (!/quota|rate limit|too many/i.test(S.bfMsg) || waits >= 8) break;
          waits++;
          for (let s = 90; s > 0; s -= 5) {
            S.bfMsg = 'Gmail asked the scan to slow down. Continuing by itself in ' + s + ' seconds. Keep this screen open.';
            render();
            await new Promise((r) => setTimeout(r, 5000));
          }
        }
      }
    } catch (e) {
      S.bfMsg = 'Stopped: ' + e.message + '. Tap the button again to pick up where it left off.';
    }
    S.busy = false; await persist(); render();
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
    S.filter.Affiliate = 'net:' + network; S.view = 'money'; S.money = 'Affiliate'; render();
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
    S.cfg = null; S.data = null; S.outbox = []; S.lastSync = null; S.err = null; S.view = 'home';
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
  if (e.target.id === 'q') { S.q = e.target.value; const l = $('#list'); if (l) l.innerHTML = listHtml(listTable()); }
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
window.addEventListener('resize', () => { if (S.view === 'home' && S.data) restoreBoard(); });
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
