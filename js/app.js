/*!
 * Event Settlement - dashboard UI.
 * Reads RAW data from the team's Google Sheet, settles per TID for exact dates, writes the payout date
 * into "Settleted", keeps a payout log in a separate sheet and builds the bank bulk file.
 */
(function () {
'use strict';
var E = window.ESEngine, SH = window.ESSheets, FK = window.ESFake;
var esc = E.esc;
var root = document.getElementById('root');

var VIEWS = [
  ['tid', 'Settle a TID'], ['batch', 'Sales request'], ['search', 'Search'], ['unpaid', 'Unpaid'],
  ['payouts', 'Payouts'], ['import', 'Import'], ['check', 'Data check'], ['settings', 'Settings']
];

var S = {
  cfg: null, demo: false, auth: null, client: null, store: null,
  raw: null, log: null, idx: null, byRow: null, today: E.todayKey(), issues: null,
  view: 'tid',
  tid: freshTid(''),
  batch: { source: '', lines: [], payKey: E.todayKey(), results: null, alert: null },
  search: { q: '', filter: 'all' },
  payouts: { open: null, picked: {} },
  imp: { name: '', plan: null, error: '', result: null },
  checkPicked: null
};

function freshTid(tid) {
  return { tid: tid, input: tid, from: null, to: null, pick: false, adjText: '', adjReason: '', brand: '', account: '',
    holder: '', bankCode: '', payKey: E.todayKey(), prefill: null, alert: null };
}

/* ------------------------------------------------------------------ */
/*  small helpers                                                       */
/* ------------------------------------------------------------------ */
function $(sel, el) { return (el || document).querySelector(sel); }
function lsGet(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } }
function lsDel(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }
function money(c) { return '<span class="num' + (c < 0 ? ' neg' : '') + '">' + E.fmtC(c) + '</span>'; }
var WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function weekday(k) { return WD[new Date(E.EPOCH + E.keyToSerial(k) * 86400000).getUTCDay()]; }
function shortDay(k) { if (!k) return 'No date'; var p = E.keyParts(k); return p.d + ' ' + E.MON[p.m - 1]; }
function plural(n, one, many) { return n.toLocaleString('en-US') + ' ' + (n === 1 ? one : (many || one + 's')); }
function parseAdj(text) {
  var t = String(text || '').trim();
  if (!t) return { c: 0, bad: false };
  var n = E.num(t);
  return isNaN(n) ? { c: 0, bad: true } : { c: Math.round(n * 100), bad: false };
}
/** dd/mm/yyyy (also 12-Nov-2026 or 2026-11-12) -> key, '' -> null, anything else -> false */
function parseDateInput(v) {
  v = String(v || '').trim();
  if (!v) return null;
  return E.parseTextDate(v, 'DMY') || E.isoToKey(v) || false;
}
function dateField(label, bind, key, width) {
  return '<label class="field"><span>' + esc(label) + '</span><input type="text" inputmode="numeric" autocomplete="off" placeholder="dd/mm/yyyy" ' +
    'data-bind="' + bind + '" data-date="1" value="' + E.keyDMY(key) + '" style="width:' + (width || 124) + 'px">' +
    '<small class="muted">' + (key ? weekday(key) + ' ' + esc(E.keyLabel(key)) : '&nbsp;') + '</small></label>';
}
function dateCellInput(bind, key) {
  return '<input type="text" inputmode="numeric" autocomplete="off" placeholder="dd/mm/yyyy" data-bind="' + bind + '" data-date="1" value="' +
    E.keyDMY(key) + '" style="width:92px" title="' + esc(key ? weekday(key) + ' ' + E.keyLabel(key) : '') + '">';
}
function ctx() { return { todayKey: S.today, lastDataKey: S.raw.lastDataKey, paidAdj: E.paidAdj(S.log.payouts) }; }
function notesHtml(notes) {
  if (!notes || !notes.length) return '';
  return '<ul class="notes">' + notes.map(function (n) { return '<li class="' + n.k + '">' + esc(n.t) + '</li>'; }).join('') + '</ul>';
}
var STATUS_TEXT = { OK: 'Ready', WARN: 'Ready, check note', BLOCK: 'Blocked', ZERO: 'Nothing to pay', DONE: 'Paid',
  PAID: 'Paid', REVERSED: 'Undone', STAMPING: 'Not finished', CHECK: 'Check', 'PARTLY REVERSED': 'Partly undone' };
function chip(status, text) { return '<span class="chip ' + esc(status) + '">' + esc(text || STATUS_TEXT[status] || status) + '</span>'; }
function lastPayout(tid) {
  var best = null;
  (S.log ? S.log.payouts : []).forEach(function (p) {
    if (p.tid === tid && (p.status === 'PAID' || p.status === 'CHECK') && (!best || p.row > best.row)) best = p;
  });
  return best;
}
function sheetUrl(id) { return 'https://docs.google.com/spreadsheets/d/' + encodeURIComponent(id) + '/edit'; }

/* ------------------------------------------------------------------ */
/*  toast, modal, busy                                                  */
/* ------------------------------------------------------------------ */
var toastTimer = null;
function toast(msg, isErr) {
  var t = $('#toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
  t.className = 'toast' + (isErr ? ' err' : '');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { t.hidden = true; }, isErr ? 9000 : 5000);
}

/** opts: {title, html, ok, okClass, cancel, wide, onOk(el) -> false to keep open} */
function modal(opts) {
  return new Promise(function (resolve) {
    var back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="mtitle"' + (opts.wide ? ' style="width:min(760px,100%)"' : '') + '>' +
      '<h2 id="mtitle">' + esc(opts.title) + '</h2><div class="body">' + (opts.html || '') + '</div>' +
      '<div class="foot">' + (opts.cancel === false ? '' : '<button class="btn" data-m="cancel">' + esc(opts.cancel || 'Cancel') + '</button>') +
      (opts.ok ? '<button class="btn ' + (opts.okClass || 'primary') + '" data-m="ok">' + esc(opts.ok) + '</button>' : '') + '</div></div>';
    document.body.appendChild(back);
    var prev = document.activeElement;
    var close = function (v) { back.remove(); document.removeEventListener('keydown', onKey); if (prev && prev.focus) prev.focus(); resolve(v); };
    var onKey = function (e) { if (e.key === 'Escape') close(false); };
    document.addEventListener('keydown', onKey);
    back.addEventListener('click', function (e) {
      var b = e.target.closest('[data-m]');
      if (e.target === back) { close(false); return; }
      if (!b) return;
      if (b.getAttribute('data-m') === 'cancel') { close(false); return; }
      if (opts.onOk && opts.onOk(back) === false) return;
      close(true);
    });
    var first = back.querySelector('input, select, textarea') || back.querySelector('[data-m="ok"]') || back.querySelector('[data-m]');
    if (first) first.focus();
  });
}

function busy(text) {
  var b = $('#busy');
  if (!b) {
    b = document.createElement('div'); b.id = 'busy'; b.className = 'busy';
    b.innerHTML = '<div class="box" role="status" aria-live="polite"><div id="busytext"></div><div class="bar"></div></div>';
    document.body.appendChild(b);
  }
  b.hidden = false;
  $('#busytext').textContent = text;
}
function busyStep(text) { var t = $('#busytext'); if (t) t.textContent = text; }
function done() { var b = $('#busy'); if (b) b.hidden = true; }

/* ------------------------------------------------------------------ */
/*  start                                                               */
/* ------------------------------------------------------------------ */
function readConfig() {
  var cfg = lsGet('es.cfg') || {};
  var p = new URLSearchParams(location.hash.slice(1)), got = false;
  [['c', 'clientId'], ['s', 'sheetId'], ['l', 'logId'], ['h', 'hd']].forEach(function (x) {
    var v = p.get(x[0]);
    if (v) { cfg[x[1]] = v.trim(); got = true; }
  });
  if (got) {
    lsSet('es.cfg', cfg);
    history.replaceState(null, '', location.pathname + location.search);
  }
  cfg.rawTab = cfg.rawTab || 'RAW data';
  cfg.hd = cfg.hd || '';
  cfg.prefix = cfg.prefix || 'Event';
  return cfg;
}

function boot() {
  S.demo = !!window.ES_DEMO || /[?&]demo=1\b/.test(location.search);
  var draft = lsGet(S.demo ? 'es.batch.demo' : 'es.batch');
  if (draft && draft.lines) { S.batch.lines = draft.lines; S.batch.source = draft.source || ''; }
  if (S.demo) { startDemo(); return; }
  S.cfg = readConfig();
  if (!S.cfg.clientId || !S.cfg.sheetId || !S.cfg.logId) { renderConnect(); return; }
  S.auth = new SH.GoogleAuth(S.cfg.clientId, S.cfg.hd);
  renderSignIn();
}

function startDemo() {
  var fake = new FK.FakeSheets({ latency: 90, user: 'you@example.com' });
  var books = window.ES_TEST_BOOKS || FK.demoBooks(E, S.today, { seed: 7 });
  fake.addBook('demo-raw', books.raw);
  fake.addBook('demo-log', books.log);
  S.demoSales = books.sales;
  S.cfg = { sheetId: 'demo-raw', logId: 'demo-log', rawTab: 'RAW data', prefix: 'Event' };
  S.auth = new SH.DemoAuth('you@example.com');
  S.client = new SH.SheetsClient({ fetch: fake.fetch, getToken: function () { return S.auth.token; } });
  S.store = new SH.Store(S.client, S.cfg, function () { return S.auth.email; });
  loadAll();
}

function renderConnect(msg) {
  var c = S.cfg || {};
  root.innerHTML = '<div class="center"><div class="card"><div class="ledgerline"></div><h1>Event Settlement</h1>' +
    '<p>Open the tool from the team link, or paste the three values from it here.</p>' +
    (msg ? '<div class="alert err">' + esc(msg) + '</div>' : '') +
    '<label class="field"><span>Google client ID</span><input type="text" id="cf-c" value="' + esc(c.clientId || '') + '"></label><br>' +
    '<label class="field"><span>Event settlement sheet (link or ID)</span><input type="text" id="cf-s" value="' + esc(c.sheetId || '') + '"></label><br>' +
    '<label class="field"><span>Payout Log sheet (link or ID)</span><input type="text" id="cf-l" value="' + esc(c.logId || '') + '"></label><br>' +
    '<div class="row"><button class="btn primary" data-action="save-connect">Save</button><a class="btn" href="?demo=1">Try with demo data</a></div>' +
    '</div></div>';
}
function idFrom(v) { var m = /\/d\/([A-Za-z0-9_-]{20,})/.exec(v || ''); return m ? m[1] : String(v || '').trim(); }

function renderSignIn(err) {
  root.innerHTML = '<div class="center"><div class="card"><div class="ledgerline"></div><h1>Event Settlement</h1>' +
    '<p>Sign in with your work Google account. You see the same sheets you can open in Google Sheets, nothing more.</p>' +
    (err ? '<div class="alert err">' + esc(err) + '</div>' : '') +
    '<button class="btn primary" data-action="signin">Sign in with Google</button> ' +
    '<button class="btn link" data-action="signin-other">Use another account</button></div></div>';
}

function doSignIn(choose) {
  S.auth.signIn(choose).then(function () {
    S.client = new SH.SheetsClient({ getToken: function () { return S.auth.token; } });
    S.store = new SH.Store(S.client, S.cfg, function () { return S.auth.email || 'unknown'; });
    loadAll();
  }, function (e) { renderSignIn(e.message); });
}

function loadAll(keepView) {
  busy('Opening the sheets');
  var raw;
  S.store.loadRaw(busyStep).catch(function (e) { e.message = 'Event settlement sheet: ' + e.message; throw e; })
    .then(function (r) {
      raw = r;
      busyStep('Reading the payout log');
      return S.store.ensureLog().then(function () { return S.store.loadLog(); })
        .catch(function (e) { e.message = 'Payout Log sheet: ' + e.message; throw e; });
    })
    .then(function (log) {
      setData(raw, log);
      done();
      renderApp();
      if (!keepView && !S.demo && S.batch.lines.length && S.batch.lines.some(function (l) { return !l.done; })) {
        toast('Your unfinished Sales request is still in Sales request.');
      }
    })
    .catch(function (e) {
      done();
      if (e.status === 401) { renderSignIn(e.message); return; }
      if (!S.raw) {
        root.innerHTML = '<div class="center"><div class="card"><h1>Could not open the data</h1><div class="alert err">' + esc(e.message) +
          '</div><div class="row"><button class="btn primary" data-action="retry">Try again</button>' +
          (S.demo ? '' : '<button class="btn" data-action="goto-settings-reset">Change sheet links</button>') + '</div></div></div>';
      } else toast(e.message, true);
    });
}

function setData(raw, log) {
  S.raw = raw; S.log = log; S.today = raw.todayKey;
  S.idx = E.tidIndex(raw.recs, S.today);
  S.byRow = {};
  raw.recs.forEach(function (r) { S.byRow[r.row] = r; });
  S.issues = null;
  if (S.batch.lines.length) recomputeBatch();
}

/** Writes need a Google session with time left; returns false after asking the user to sign in again. */
function sessionOk() {
  if (S.demo || S.auth.validFor(5 * 60 * 1000)) return true;
  modal({ title: 'Sign in again', html: '<p>Your Google session is about to end. Sign in again, then repeat the action.</p>', ok: 'Sign in' })
    .then(function (yes) {
      if (!yes) return;
      S.auth.signIn(false).then(function () { toast('Signed in again. Repeat the action.'); }, function (e) { toast(e.message, true); });
    });
  return false;
}

/* ------------------------------------------------------------------ */
/*  frame                                                               */
/* ------------------------------------------------------------------ */
function renderApp() {
  var loaded = new Date(S.raw.loadedAt);
  var time = ('0' + loaded.getHours()).slice(-2) + ':' + ('0' + loaded.getMinutes()).slice(-2);
  root.innerHTML = '<div class="app">' +
    (S.demo ? '<div class="banner">Demo data: nothing here is real and nothing is saved to Google Sheets. ' +
      '<a href="./">Open the real tool</a></div>' : '') +
    '<header class="top"><div class="name">Event Settlement</div><div class="data">' +
    '<span>RAW data <b>' + S.raw.recs.length.toLocaleString('en-US') + '</b> transactions</span>' +
    '<span>Last day <b>' + esc(E.keyLabel(S.raw.lastDataKey)) + '</b></span>' +
    '<span>Read at <b>' + time + '</b></span>' +
    '<button data-action="reload" title="Read the sheets again">Reload</button></div>' +
    '<div class="who"><span>' + esc(S.auth.email || '') + '</span></div></header>' +
    '<div class="body"><nav class="rail" aria-label="Views">' + railLinks() + '</nav>' +
    '<main id="main" tabindex="-1"></main></div></div>';
  renderView();
}

function railLinks() {
  var unpaidTids = 0;
  Object.keys(S.idx).forEach(function (k) { if (S.idx[k].unpaidN) unpaidTids++; });
  if (!S.issues) S.issues = E.issues(S.raw.recs, S.today);
  var open = S.batch.lines.filter(function (l) { return !l.done && !l.removed; }).length;
  var counts = { unpaid: unpaidTids, check: S.issues.length, batch: open || '' };
  return VIEWS.map(function (v, i) {
    return (i === 6 ? '<hr>' : '') + '<a href="#" data-action="go" data-view="' + v[0] + '"' + (S.view === v[0] ? ' aria-current="page"' : '') + '>' +
      '<span>' + esc(v[1]) + '</span>' + (counts[v[0]] ? '<span class="count">' + counts[v[0]] + '</span>' : '') + '</a>';
  }).join('');
}

function go(view) {
  S.view = view;
  var rail = $('.rail');
  if (rail) rail.innerHTML = railLinks();
  renderView();
  var m = $('#main');
  if (m) { m.focus({ preventScroll: true }); window.scrollTo(0, 0); }
}

function renderView() {
  var m = $('#main');
  if (!m) return;
  var fn = { tid: viewTid, batch: viewBatch, search: viewSearch, unpaid: viewUnpaid, payouts: viewPayouts,
    import: viewImport, check: viewCheck, settings: viewSettings }[S.view] || viewTid;
  m.innerHTML = fn();
  afterRender();
}
function refreshRail() { var rail = $('.rail'); if (rail) rail.innerHTML = railLinks(); }

function afterRender() {
  if (S.view === 'search') {
    var i = $('#q');
    if (i && document.activeElement !== i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); }
  }
  if (S.view === 'tid') {
    var led = $('.ledger'), sel = $('.day.edge');
    if (led) {
      if (sel) led.scrollLeft = Math.max(0, sel.offsetLeft - led.offsetLeft - led.clientWidth / 2 + sel.offsetWidth / 2);
      else led.scrollLeft = led.scrollWidth;
    }
  }
}

function head(title, text, actions) {
  return '<div class="view-head"><div><h1>' + esc(title) + '</h1>' + (text ? '<p>' + text + '</p>' : '') + '</div>' +
    (actions ? '<div class="actions">' + actions + '</div>' : '') + '</div>';
}

/* ------------------------------------------------------------------ */
/*  Settle a TID                                                        */
/* ------------------------------------------------------------------ */
function selectTid(tid, from, to) {
  tid = E.normTid(tid);
  var t = freshTid(tid), info = S.idx[tid];
  if (info) {
    t.from = from || info.firstUnpaid || null;
    t.to = to || info.lastUnpaid || null;
    var lp = lastPayout(tid);
    if (lp) {
      t.brand = lp.brand; t.account = lp.account; t.holder = lp.holder; t.bankCode = lp.bankCode;
      t.prefill = { batch: lp.batch, payKey: lp.payKey };
    }
  }
  S.tid = t;
}

function tidLine() {
  var t = S.tid, adj = parseAdj(t.adjText);
  var noBank = !(t.account || t.holder || t.bankCode);
  return { row: 1, tid: t.tid, from: t.from, to: t.to, adjC: adj.c, adjInvalid: adj.bad, adjReason: t.adjReason.trim(),
    brand: t.brand.trim(), bankName: t.bankCode, bankCode: t.bankCode, account: t.account.replace(/\s/g, ''),
    holder: t.holder.trim(), accountIsNumber: false, noBank: noBank, done: false };
}

function viewTid() {
  var t = S.tid, info = t.tid ? S.idx[t.tid] : null;
  var opts = Object.keys(S.idx).sort().map(function (k) {
    var x = S.idx[k];
    return '<option value="' + esc(k) + '">' + esc(x.mid + (x.unpaidN ? ', unpaid ' + E.fmtC(x.unpaidC) : ', all paid')) + '</option>';
  }).join('');
  var h = head('Settle a TID', 'Pick the TID, choose its dates, then mark the unpaid money in those dates as paid on the payout date. ' +
    'Paid transactions are never counted again.');
  h += '<div class="panel"><div class="row"><label class="field grow"><span>TID</span>' +
    '<input class="big id" id="tid-input" list="tidlist" autocomplete="off" spellcheck="false" placeholder="Type or paste a TID" value="' + esc(t.input) + '"></label>' +
    '<datalist id="tidlist">' + opts + '</datalist>' +
    (t.tid ? '<button class="btn" data-action="tid-clear">Clear</button>' : '') + '</div>';
  if (t.input && !info) h += '<p class="muted small">No transactions for TID ' + esc(t.input) + ' in RAW data.</p>';
  if (info) {
    var lp = lastPayout(t.tid);
    h += '<p class="small" style="margin:10px 0 0">MID <b>' + esc(info.mid) + '</b>. ' +
      (lp ? 'Last payout <span class="stamp sm">' + esc(E.payLabel(lp.payKey)) + '</span> in ' + esc(lp.batch) +
        (lp.account ? ' to <b dir="auto">' + esc(lp.brand || lp.holder) + '</b> (' + esc(lp.bankCode) + ' ' + esc(lp.account) + ').' : ', without a bank file.')
        : info.lastPaidLabel ? 'Last paid in the sheet on <span class="stamp sm">' + esc(info.lastPaidLabel) + '</span>.' : 'Never paid.') + '</p>';
  }
  h += '</div>';
  if (!info) return h + unpaidPicker();

  // day ledger
  var days = E.tidDays(S.raw.recs, t.tid);
  h += '<div class="panel"><h2>Days</h2><div class="figures">' +
    '<div class="fig due"><div class="v">' + E.fmtC(info.unpaidC) + '<small>EGP</small></div><div class="l">Unpaid, ' + plural(info.unpaidN, 'transaction') +
    (info.firstUnpaid ? ', ' + esc(E.keyLabel(info.firstUnpaid)) + ' to ' + esc(E.keyLabel(info.lastUnpaid)) : '') + '</div></div>' +
    '<div class="fig paid"><div class="v">' + E.fmtC(info.paidC) + '<small>EGP</small></div><div class="l">Already paid, ' + plural(info.paidN, 'transaction') + '</div></div>' +
    (info.badN ? '<div class="fig"><div class="v neg">' + info.badN + '</div><div class="l">Unpaid with a missing or future date</div></div>' : '') +
    '</div><p class="sub" style="margin:10px 0 8px">' + (t.pick ? 'Now click the last day of the range.' : 'Click a day to start a range, then click the last day.') + '</p>' +
    '<div class="ledger" role="list">' + days.map(dayCell).join('') + '</div>' +
    '<div class="legend"><span><span class="sw" style="background:var(--due-soft);border:1px solid #d9b77a"></span>In the selected range</span>' +
    '<span><span class="stamp sm">Paid</span> paid on that date</span>' +
    '<span><span class="sw" style="background:var(--due);border-radius:50%;width:8px;height:8px"></span>date corrected (the sheet has day and month swapped)</span></div></div>';

  h += '<div class="panel" id="tid-calc">' + tidCalcHtml() + '</div>';
  h += '<div class="panel"><h2>Transactions of TID ' + esc(t.tid) + ' in these dates</h2>' + tidTrxTable() + '</div>';
  return h;
}

function dayCell(d) {
  var t = S.tid, inR = d.dk && t.from && t.to && d.dk >= t.from && d.dk <= t.to;
  var edge = d.dk && (d.dk === t.from || d.dk === t.to);
  var labels = Object.keys(d.labels);
  var cls = 'day' + (inR ? ' in' + (d.unpaidN ? '' : ' paidonly') : '') + (edge ? ' edge' : '');
  return '<button class="' + cls + '" role="listitem" data-action="day" data-dk="' + d.dk + '"' + (d.dk ? '' : ' disabled') + '>' +
    (d.fixed ? '<span class="fixmark" title="' + d.fixed + ' transaction(s) with a corrected date"></span>' : '') +
    '<span class="d"><b>' + esc(shortDay(d.dk)) + '</b>' + (d.dk ? esc(weekday(d.dk)) : '') + '</span>' +
    (d.unpaidN ? '<span class="due">' + E.fmtC(d.unpaidC) + '<small>' + plural(d.unpaidN, 'trx', 'trx') + ' unpaid</small></span>' : '') +
    labels.slice(0, 2).map(function (l) { return '<span class="stamp">Paid ' + esc(l.replace(/\s*\d{4}\s*$/, '')) + '</span>'; }).join('') +
    (labels.length > 2 ? '<span class="small muted">+' + (labels.length - 2) + ' more</span>' : '') +
    (d.otherN ? '<span class="small muted">' + d.otherN + ' not approved</span>' : '') + '</button>';
}

function tidCalcHtml() {
  var t = S.tid;
  if (!t.from || !t.to) {
    return '<h2>Dates</h2>' + (t.alert ? '<div class="alert ' + t.alert.kind + '">' + t.alert.html + '</div>' : '') +
      '<p class="muted">Nothing unpaid for this TID. Pick days above to see what was paid.</p>' + tidRangeInputs();
  }
  var res = E.computeLines([tidLine()], S.raw.recs, ctx())[0];
  var L = res.line, ready = E.eligible(res);
  var h = '<h2>Payout</h2>' + (t.alert ? '<div class="alert ' + t.alert.kind + '">' + t.alert.html + '</div>' : '') + tidRangeInputs() +
    '<div class="figures" style="margin-top:14px">' +
    '<div class="fig due"><div class="v">' + E.fmtC(res.amtC) + '<small>EGP</small></div><div class="l">Unpaid in these dates, ' + plural(res.cnt, 'transaction') + '</div></div>' +
    (L.adjC && !L.adjInvalid ? '<div class="fig"><div class="v">' + E.fmtC(L.adjC) + '</div><div class="l">Adjustment</div></div>' : '') +
    '<div class="fig"><div class="v">' + E.fmtC(res.finalC) + '<small>EGP</small></div><div class="l">To pay</div></div>' +
    '<div class="fig"><div class="v" style="font-size:17px;padding-top:6px">' + chip(res.status) + '</div><div class="l">Check</div></div>' +
    '</div>' + notesHtml(res.notes) +
    '<div class="row" style="margin-top:16px">' +
    dateField('Payout date', 'tid.payKey', t.payKey) +
    '<label class="field"><span>Adjustment (EGP, optional)</span><input type="text" inputmode="decimal" data-bind="tid.adjText" value="' + esc(t.adjText) + '" placeholder="e.g. 250 or -100" style="width:150px"></label>' +
    '<label class="field grow"><span>Adjustment reason</span><input type="text" data-bind="tid.adjReason" value="' + esc(t.adjReason) + '"></label></div>' +
    '<details class="more-box" style="margin-top:14px"' + (t.account || t.holder || t.bankCode ? ' open' : '') + '><summary>Bank details for the bank file' +
    (t.prefill ? ' <span class="small muted">(from payout ' + esc(t.prefill.batch) + ': make sure this TID still belongs to this vendor)</span>' : '') + '</summary>' +
    '<div class="row"><label class="field"><span>Brand name</span><input type="text" data-bind="tid.brand" value="' + esc(t.brand) + '"></label>' +
    '<label class="field"><span>Account holder</span><input type="text" data-bind="tid.holder" value="' + esc(t.holder) + '" dir="auto"></label>' +
    '<label class="field"><span>Account number</span><input type="text" class="id" data-bind="tid.account" value="' + esc(t.account) + '"></label>' +
    '<label class="field"><span>Bank code</span>' + bankSelect('tid.bankCode', t.bankCode) + '</label></div>' +
    '<p class="small muted" style="margin:8px 0 0">Leave all four empty to mark the money paid without a bank file (for example, paid another way).</p></details>' +
    '<div class="row" style="margin-top:16px"><button class="btn primary" data-action="tid-pay"' + (ready ? '' : ' disabled') + '>Mark paid</button>' +
    '<button class="btn" data-action="tid-to-batch"' + (ready && !L.noBank ? '' : ' disabled') + ' title="Needs bank details">Add to Sales request</button>' +
    '<button class="btn" data-action="tid-breakdown">Download breakdown</button></div>';
  return h;
}

function tidRangeInputs() {
  var t = S.tid;
  return '<div class="row">' + dateField('From', 'tid.from', t.from) + dateField('To', 'tid.to', t.to) +
    '<button class="btn" data-action="tid-all-unpaid" style="margin-bottom:19px">All unpaid dates</button></div>';
}

function bankSelect(bind, value) {
  var codes = S.log.bankState.list;
  return '<select data-bind="' + bind + '"><option value="">-</option>' + codes.map(function (c) {
    return '<option' + (c === value ? ' selected' : '') + '>' + esc(c) + '</option>';
  }).join('') + (value && codes.indexOf(value) < 0 ? '<option selected>' + esc(value) + '</option>' : '') + '</select>';
}

function tidTrxList() {
  var t = S.tid;
  return S.raw.recs.filter(function (r) {
    return r.tid === t.tid && (t.from && t.to ? r.dateKey >= t.from && r.dateKey <= t.to : false);
  }).sort(function (a, b) { return (a.dateKey - b.dateKey) || (E.parseTime(a.time) || 0) - (E.parseTime(b.time) || 0); });
}

function trxStatus(r) {
  if (r.dupOf) return '<span class="small muted">Duplicate of row ' + r.dupOf + ', not counted</span>';
  if (r.paid) return '<span class="stamp sm">' + esc(r.paidLabel) + '</span>';
  if (!/^approved/i.test(r.status)) return '<span class="small muted">' + esc(r.status || 'No status') + '</span>';
  return '<span class="chip WARN">Unpaid</span>';
}
function dateCell(r) {
  return esc(E.keyLabel(r.dateKey) || String(r.dateRaw)) +
    (r.dateFixed ? '<br><span class="small" style="color:var(--due)">sheet: ' + esc(E.keyLabel(r.dateStored)) + '</span>' : '');
}

function tidTrxTable() {
  var list = tidTrxList();
  if (!list.length) return '<p class="muted">No transactions in these dates.</p>';
  var max = 400;
  return '<div class="tablewrap"><table class="t"><thead><tr><th>Row</th><th>Date</th><th>Time</th><th>TRX ID</th><th>Type</th><th>Card</th>' +
    '<th class="num">Amount</th><th class="num">Settlement</th><th>Settleted</th></tr></thead><tbody>' +
    list.slice(0, max).map(function (r) {
      return '<tr class="' + (r.paid || r.dupOf ? 'paid' : '') + '"><td class="muted">' + r.row + '</td><td class="nowrap">' + dateCell(r) + '</td>' +
        '<td class="muted">' + esc(E.timeLabel(r.time)) + '</td><td class="id">' + esc(r.trx) + '</td><td>' + esc(r.type) + '</td>' +
        '<td class="id">' + esc(r.card) + '</td><td class="num">' + (r.amount === null ? '' : E.fmtC(Math.round(r.amount * 100))) + '</td>' +
        '<td>' + money(r.amtC) + '</td><td>' + trxStatus(r) + '</td></tr>';
    }).join('') + '</tbody></table>' + (list.length > max ? '<div class="more">Showing ' + max + ' of ' + list.length + '. The breakdown file has all of them.</div>' : '') + '</div>';
}

function unpaidPicker() {
  var ov = E.unpaidOverview(S.raw.recs, S.today);
  if (!ov.rows.length) return '<div class="panel empty"><b>Nothing unpaid.</b> Every transaction in RAW data has a payout date.</div>';
  return '<div class="panel"><h2>TIDs with unpaid money</h2><p class="sub">Biggest first. Click one to settle it.</p>' +
    unpaidTable(ov.rows.slice(0, 12)) + (ov.rows.length > 12 ? '<p class="small muted">' + (ov.rows.length - 12) + ' more in Unpaid.</p>' : '') + '</div>';
}

function tidPay() {
  var t = S.tid, res = E.computeLines([tidLine()], S.raw.recs, ctx())[0], L = res.line;
  if (!E.eligible(res)) return;
  if (t.payKey > S.today) { toast('The payout date cannot be in the future.', true); return; }
  if (t.payKey < t.to) { toast('The payout date is before the last day of the range (' + E.keyLabel(t.to) + ').', true); return; }
  if (!sessionOk()) return;
  var warn = res.notes.filter(function (n) { return n.k === 'W'; });
  modal({
    title: 'Mark paid?',
    html: '<dl><dt>TID</dt><dd class="id">' + esc(t.tid) + '</dd><dt>Dates</dt><dd>' + esc(E.keyLabel(t.from)) + ' to ' + esc(E.keyLabel(t.to)) + '</dd>' +
      '<dt>Transactions</dt><dd>' + res.cnt + '</dd><dt>Amount</dt><dd>' + E.fmtC(res.finalC) + ' EGP</dd>' +
      '<dt>Payout date</dt><dd><span class="stamp sm">' + esc(E.payLabel(t.payKey)) + '</span></dd>' +
      '<dt>Bank file</dt><dd>' + (L.noBank ? 'None (no bank details)' : esc(L.holder + ', ' + L.bankCode + ' ' + L.account)) + '</dd></dl>' +
      (warn.length ? notesHtml(warn) : '') +
      '<p class="small muted">The tool writes "' + esc(E.payLabel(t.payKey)) + '" in Settleted for these ' + res.rowsToStamp.length +
      ' rows of RAW data and adds the payout to the Payout Log.</p>',
    ok: 'Mark paid'
  }).then(function (yes) {
    if (!yes) return;
    runSettle([L], [res], t.payKey, 'Settle a TID').then(function (out) {
      if (!out) return;
      if (!L.noBank) downloadBankFile(out.paid.map(bankLineOf), out.batchId, out.payKey);
      S.tid.alert = { kind: 'ok', html: 'Paid: ' + esc(out.batchId) + ', ' + plural(out.trx, 'transaction') + ', ' + E.fmtC(out.total) + ' EGP.' +
        (L.noBank ? '' : ' The bank file was downloaded.') };
      S.tid.adjText = ''; S.tid.adjReason = '';
      var info = S.idx[S.tid.tid];
      S.tid.from = info && info.firstUnpaid || null; S.tid.to = info && info.lastUnpaid || null;
      renderView();
    });
  });
}

function bankLineOf(res) {
  return { holder: res.line.holder, account: res.line.account, bankCode: res.line.bankCode, finalC: res.finalC, tid: res.line.tid };
}

/** Shared by Settle a TID and Sales request. Resolves with the result, or null when nothing was written. */
function runSettle(lines, expected, payKey, source) {
  busy('Starting');
  return S.store.settle({ lines: lines, expected: expected, payKey: payKey, source: source, onStep: busyStep })
    .then(function (out) {
      // the rows are now paid: update the copy in memory
      var stamped = {};
      out.paid.forEach(function (r) { r.rowsToStamp.forEach(function (x) { stamped[x] = 1; }); });
      busyStep('Reading the payout log');
      return S.store.loadLog().then(function (log) {
        var raw = out.raw || S.raw;
        raw.recs.forEach(function (r) {
          if (stamped[r.row]) { r.paid = true; r.paidLabel = out.label; r.paidKey = out.payKey; r._s = null; }
        });
        setData(raw, log);
        done();
        refreshRail();
        toast('Marked paid: ' + out.batchId + (out.notConfirmed ? '. ' + out.notConfirmed + ' cells did not read back: check the Payouts page.' : ''), !!out.notConfirmed);
        return out;
      });
    })
    .catch(function (e) {
      done();
      if (e.code === 'CHANGED') {
        setData(e.raw, e.log);
        refreshRail();
        modal({ title: 'The sheet changed', html: '<p>' + esc(e.message) + '</p>', ok: 'Review', cancel: false });
        renderView();
        return null;
      }
      if (e.status === 401) { sessionOk(); return null; }
      modal({ title: 'Nothing was marked paid', html: '<div class="alert err">' + esc(e.message) + '</div>' +
        (e.code === 'LOCKED' ? '' : '<p class="small">If the message says the connection dropped, open Payouts and check the newest batch before trying again.</p>'),
        ok: 'OK', cancel: false });
      return null;
    });
}

/* ------------------------------------------------------------------ */
/*  Sales request (batch)                                               */
/* ------------------------------------------------------------------ */
function saveDraft() {
  lsSet(S.demo ? 'es.batch.demo' : 'es.batch', { source: S.batch.source, lines: S.batch.lines });
}
function activeLines() { return S.batch.lines.filter(function (l) { return !l.removed; }); }
function recomputeBatch() {
  if (!S.raw) return;
  S.batch.results = E.computeLines(activeLines(), S.raw.recs, ctx());
}

function loadSalesGrid(grid, source) {
  var parsed = E.parseSalesGrid(grid, S.log.bankState, S.today);
  if (!parsed.lines.length) { toast('No lines with a TID were found in ' + source + '.', true); return; }
  S.batch.lines = parsed.lines;
  S.batch.source = source;
  S.batch.alert = null;
  recomputeBatch();
  saveDraft();
  refreshRail();
  renderView();
}

function viewBatch() {
  var b = S.batch, lines = activeLines();
  var h = head('Sales request', 'Open the Sales file: every line is checked against RAW data for its exact dates. ' +
    'Mark paid writes the payout date for the ready lines and downloads the bank file.',
    lines.length ? '<label class="btn">Open another file<input type="file" accept=".xlsx,.xls,.csv" data-action="sales-file" hidden></label>' +
      '<button class="btn danger" data-action="batch-clear">Clear</button>' : '');
  if (b.alert) h += '<div class="alert ' + b.alert.kind + '">' + b.alert.html + '</div>';
  if (!lines.length) {
    h += '<div class="panel"><div class="drop" id="drop"><p><b>Open the Sales request file</b> (.xlsx)</p>' +
      '<label class="btn primary">Choose file<input type="file" accept=".xlsx,.xls,.csv" data-action="sales-file" hidden></label>' +
      (S.demo ? ' <button class="btn" data-action="sales-sample">Use the sample Sales request</button>' : '') +
      '<p class="small" style="margin-top:10px">Columns: Brand name, TID, account number, account holder, Bank name, Days to settle. Extra columns are kept for reference.</p></div>' +
      '<details class="more-box" style="margin-top:14px"><summary>Or paste the lines from Excel</summary>' +
      '<textarea id="paste" rows="6" style="width:100%" placeholder="Copy the rows (with or without the header) in Excel and paste here"></textarea>' +
      '<div class="row" style="margin-top:8px"><button class="btn" data-action="sales-paste">Use pasted lines</button></div></details></div>';
    return h;
  }
  if (!b.results) recomputeBatch();
  var res = b.results, s = E.summary(res);
  var maxTo = 0;
  res.forEach(function (r) { if (E.eligible(r) && r.line.to > maxTo) maxTo = r.line.to; });
  h += '<div class="panel"><div class="row">' +
    '<div class="figures grow">' +
    '<div class="fig"><div class="v">' + E.fmtC(s.payC) + '<small>EGP</small></div><div class="l">Ready to pay: ' + plural(s.payN, 'line') + ', ' + plural(s.trx, 'transaction') +
    (s.WARN ? ' (' + s.WARN + ' with a note)' : '') + '</div></div>' +
    (s.BLOCK ? '<div class="fig"><div class="v neg">' + s.BLOCK + '</div><div class="l">Blocked</div></div>' : '') +
    (s.ZERO ? '<div class="fig"><div class="v">' + s.ZERO + '</div><div class="l">Nothing to pay</div></div>' : '') +
    (s.DONE ? '<div class="fig paid"><div class="v">' + s.DONE + '</div><div class="l">Already paid here</div></div>' : '') +
    '</div>' +
    dateField('Payout date', 'batch.payKey', b.payKey) +
    '<button class="btn primary" data-action="batch-pay"' + (s.payN ? '' : ' disabled') + '>Mark paid and download bank file</button>' +
    '<button class="btn" data-action="batch-breakdown">Download breakdown</button></div>' +
    '<p class="small muted" style="margin:8px 0 0">Source: ' + esc(b.source || 'pasted lines') + '. Blocked and zero lines are not paid. ' +
    (maxTo && b.payKey < maxTo ? '<b class="neg">The payout date is before ' + esc(E.keyLabel(maxTo)) + ', the last requested day.</b>' : '') + '</p></div>';

  h += '<div class="tablewrap batch" style="max-height:none"><table class="t"><thead><tr><th>#</th><th>Vendor and TID</th><th>Dates</th>' +
    '<th>Bank account</th><th class="num">Trx</th><th class="num">Amount</th><th>Adjustment</th>' +
    '<th class="num">To pay</th><th>Check</th></tr></thead><tbody>' +
    res.map(function (r, i) { return batchRow(r, i); }).join('') + '</tbody>' +
    '<tfoot><tr><td colspan="4">Ready lines</td><td class="num">' + s.trx + '</td><td></td><td></td><td class="num">' + E.fmtC(s.payC) + '</td><td></td></tr></tfoot></table></div>';
  return h;
}

function batchRow(r, i) {
  var L = r.line, idx = S.batch.lines.indexOf(L);
  var vendor = '<div dir="auto"><b>' + esc(L.brand || '-') + '</b></div><div class="id">' + esc(L.tid) + '</div>' +
    (L.holder ? '<div class="small muted" dir="auto">' + esc(L.holder) + '</div>' : '');
  var bankName = L.bankName && E.normText(L.bankName) !== E.normText(L.bankCode) ? '<span class="small muted" dir="auto"> ' + esc(L.bankName) + '</span>' : '';
  if (r.status === 'DONE') {
    return '<tr class="paid"><td class="muted">' + L.row + '</td><td>' + vendor + '</td>' +
      '<td class="nowrap">' + esc(E.keyLabel(L.from)) + '<br>' + esc(E.keyLabel(L.to)) + '</td>' +
      '<td><b>' + esc(L.bankCode) + '</b>' + bankName + '<div class="id">' + esc(L.account) + '</div></td>' +
      '<td class="num">' + (L.paidCnt || '') + '</td><td></td><td></td><td class="num">' + (L.paidC ? E.fmtC(L.paidC) : '') + '</td>' +
      '<td>' + chip('DONE') + ' <span class="small">' + esc(L.batch || '') + '</span></td></tr>';
  }
  var bank = L.bankCode ? '<b>' + esc(L.bankCode) + '</b>' + bankName
    : '<div class="small neg" dir="auto">' + esc(L.bankName || 'No bank') + '</div>' + bankSelect('line.bankCode.' + idx, '');
  var salesDiff = L.salesAmtC !== null && L.salesAmtC !== undefined && L.salesAmtC !== r.finalC
    ? '<div class="small" style="color:var(--due)" title="Amount written in the Sales file">Sales file: ' + E.fmtC(L.salesAmtC) + '</div>' : '';
  var adjOpen = L.adjText || L.adjReason;
  return '<tr><td class="muted">' + L.row + '</td><td style="min-width:150px">' + vendor + '</td>' +
    '<td style="min-width:200px"><div class="small">' + esc(L.daysText || '') + '</div><div class="row" style="gap:4px;flex-wrap:nowrap;margin-top:3px">' +
    dateCellInput('line.from.' + idx, L.from) + dateCellInput('line.to.' + idx, L.to) + '</div></td>' +
    '<td style="min-width:150px">' + bank + '<div class="id">' + esc(L.account) + '</div></td>' +
    '<td class="num">' + r.cnt + '</td><td>' + money(r.amtC) + '</td>' +
    '<td><input type="text" inputmode="decimal" placeholder="0" style="width:84px" data-bind="line.adj.' + idx + '" value="' + esc(L.adjText || '') + '">' +
    (adjOpen ? '<input type="text" placeholder="Reason" style="width:120px;margin-top:4px;display:block" data-bind="line.reason.' + idx + '" value="' + esc(L.adjReason || '') + '">' : '') + '</td>' +
    '<td>' + money(r.finalC) + salesDiff + '</td>' +
    '<td style="min-width:240px">' + chip(r.status) + notesHtml(r.notes.filter(function (n) { return n.k !== 'I' || /Already paid|Also unpaid|Same TID/.test(n.t); })) +
    '<div class="small" style="margin-top:4px"><button class="btn link" data-action="line-open" data-i="' + idx + '">Open in Settle a TID</button> ' +
    '<button class="btn link" data-action="line-remove" data-i="' + idx + '">Remove line</button></div></td></tr>';
}

function batchPay() {
  var b = S.batch, res = b.results, elig = res.filter(E.eligible), s = E.summary(res);
  if (!elig.length) return;
  var maxTo = Math.max.apply(null, elig.map(function (r) { return r.line.to; }));
  if (b.payKey > S.today) { toast('The payout date cannot be in the future.', true); return; }
  if (b.payKey < maxTo) { toast('The payout date is before ' + E.keyLabel(maxTo) + ', the last requested day.', true); return; }
  if (!sessionOk()) return;
  var notPaid = res.filter(function (r) { return !E.eligible(r) && r.status !== 'DONE'; });
  modal({
    title: 'Mark ' + plural(elig.length, 'line') + ' paid?',
    html: '<dl><dt>Lines</dt><dd>' + elig.length + (s.WARN ? ' (' + s.WARN + ' with a note)' : '') + '</dd>' +
      '<dt>Transactions</dt><dd>' + s.trx + '</dd><dt>Total</dt><dd>' + E.fmtC(s.payC) + ' EGP</dd>' +
      '<dt>Payout date</dt><dd><span class="stamp sm">' + esc(E.payLabel(b.payKey)) + '</span></dd></dl>' +
      (notPaid.length ? '<p class="small">Not paid now: ' + notPaid.map(function (r) { return esc((r.line.brand || r.line.tid) + ' (' + (STATUS_TEXT[r.status] || r.status) + ')'); }).join(', ') + '.</p>' : '') +
      '<p class="small muted">Then the bank file downloads. If a transfer comes back, undo it from Payouts.</p>',
    ok: 'Mark paid'
  }).then(function (yes) {
    if (!yes) return;
    runSettle(activeLines(), res, b.payKey, b.source || 'Pasted Sales lines').then(function (out) {
      if (!out) return;
      out.paid.forEach(function (r) {
        r.line.done = true; r.line.batch = out.batchId; r.line.paidCnt = r.cnt; r.line.paidC = r.finalC;
      });
      saveDraft();
      recomputeBatch();
      downloadBankFile(out.paid.map(bankLineOf), out.batchId, out.payKey);
      S.batch.alert = { kind: 'ok', html: 'Paid ' + esc(out.batchId) + ': ' + plural(out.paid.length, 'line') + ', ' + plural(out.trx, 'transaction') + ', ' +
        E.fmtC(out.total) + ' EGP. The bank file was downloaded. <button class="btn link" data-action="bank-again" data-batch="' + esc(out.batchId) + '">Download it again</button>' };
      refreshRail();
      renderView();
    });
  });
}

/* ------------------------------------------------------------------ */
/*  Search                                                              */
/* ------------------------------------------------------------------ */
function viewSearch() {
  var q = S.search;
  var h = head('Search', 'TID, TRX ID, card digits, auth ID, MID, amount, date (dd/mm/yyyy) or payout date. Every word must match.');
  h += '<div class="panel"><div class="row"><input type="search" class="big grow" id="q" placeholder="Search RAW data" value="' + esc(q.q) + '" autocomplete="off" spellcheck="false">' +
    '<div class="seg" role="group" aria-label="Filter">' + [['all', 'All'], ['unpaid', 'Unpaid'], ['paid', 'Paid']].map(function (f) {
      return '<button data-action="search-filter" data-f="' + f[0] + '" aria-pressed="' + (q.filter === f[0]) + '">' + f[1] + '</button>';
    }).join('') + '</div></div></div><div id="search-results">' + searchResults() + '</div>';
  return h;
}

function searchResults() {
  var q = S.search;
  if (!q.q.trim()) return '<div class="panel empty">Type to search ' + S.raw.recs.length.toLocaleString('en-US') + ' transactions.</div>';
  var r = E.search(S.raw.recs, q.q, q.filter, 300);
  if (!r.total) return '<div class="panel empty">No transaction matches <b>' + esc(q.q) + '</b>.</div>';
  return '<div class="row" style="margin-bottom:8px"><span class="grow"><b>' + plural(r.total, 'match', 'matches') + '</b>, settlement total ' + E.fmtC(r.totC) + ' EGP' +
    (r.total > r.rows.length ? ' <span class="muted">(showing ' + r.rows.length + ')</span>' : '') + '</span>' +
    '<button class="btn" data-action="search-export">Download results</button></div>' +
    '<div class="tablewrap"><table class="t"><thead><tr><th>Row</th><th>Date</th><th>TID</th><th>TRX ID</th><th>Type</th><th>Card</th><th>Auth</th>' +
    '<th class="num">Amount</th><th class="num">Settlement</th><th>Settleted</th></tr></thead><tbody>' +
    r.rows.map(function (x) {
      return '<tr class="click' + (x.paid || x.dupOf ? ' paid' : '') + '" data-action="open-tid" data-tid="' + esc(x.tid) + '" data-dk="' + (x.dateKey || '') + '">' +
        '<td class="muted">' + x.row + '</td><td class="nowrap">' + dateCell(x) + '</td><td class="id">' + esc(x.tid) + '</td><td class="id">' + esc(x.trx) + '</td>' +
        '<td>' + esc(x.type) + '</td><td class="id">' + esc(x.card) + '</td><td class="id">' + esc(x.auth) + '</td>' +
        '<td class="num">' + (x.amount === null ? '' : E.fmtC(Math.round(x.amount * 100))) + '</td><td>' + money(x.amtC) + '</td><td>' + trxStatus(x) + '</td></tr>';
    }).join('') + '</tbody></table></div>';
}

/* ------------------------------------------------------------------ */
/*  Unpaid                                                              */
/* ------------------------------------------------------------------ */
function unpaidTable(rows) {
  return '<div class="tablewrap"><table class="t"><thead><tr><th>TID</th><th>MID</th><th class="num">Unpaid trx</th><th class="num">Unpaid amount</th>' +
    '<th>First day</th><th>Last day</th><th>Last paid</th><th>Problems</th></tr></thead><tbody>' +
    rows.map(function (t) {
      return '<tr class="click" data-action="open-tid" data-tid="' + esc(t.tid) + '"><td class="id">' + esc(t.tid) + '</td><td>' + esc(t.mid) + '</td>' +
        '<td class="num">' + t.unpaidN + '</td><td>' + money(t.unpaidC) + '</td><td class="nowrap">' + esc(E.keyLabel(t.firstUnpaid)) + '</td>' +
        '<td class="nowrap">' + esc(E.keyLabel(t.lastUnpaid)) + '</td><td>' + (t.lastPaidLabel ? '<span class="stamp sm">' + esc(t.lastPaidLabel) + '</span>' : '<span class="muted">Never</span>') + '</td>' +
        '<td class="small">' + (t.badN ? '<span class="neg">' + t.badN + ' without a usable date</span>' : '') + (t.negN ? (t.badN ? '<br>' : '') + t.negN + ' refund/deduction (' + E.fmtC(t.negC) + ')' : '') + '</td></tr>';
    }).join('') + '</tbody></table></div>';
}

function viewUnpaid() {
  var ov = E.unpaidOverview(S.raw.recs, S.today);
  var h = head('Unpaid', 'Every transaction whose Settleted is still "0", grouped by TID. Click a TID to settle it.',
    ov.rows.length ? '<button class="btn" data-action="unpaid-export">Download unpaid list</button>' : '');
  h += '<div class="panel"><div class="figures"><div class="fig due"><div class="v">' + E.fmtC(ov.totC) + '<small>EGP</small></div><div class="l">Unpaid</div></div>' +
    '<div class="fig"><div class="v">' + ov.totN.toLocaleString('en-US') + '</div><div class="l">Transactions</div></div>' +
    '<div class="fig"><div class="v">' + ov.tids + '</div><div class="l">TIDs</div></div></div></div>';
  if (!ov.rows.length) return h + '<div class="panel empty"><b>Nothing unpaid.</b></div>';
  return h + unpaidTable(ov.rows);
}

/* ------------------------------------------------------------------ */
/*  Payouts (log)                                                       */
/* ------------------------------------------------------------------ */
function batches() {
  var map = {}, order = [];
  S.log.payouts.forEach(function (p) {
    var b = map[p.batch];
    if (!b) { b = map[p.batch] = { id: p.batch, payKey: p.payKey, lines: [], by: p.by, at: p.at, row: p.row }; order.push(b); }
    b.lines.push(p);
    if (p.row > b.row) b.row = p.row;
  });
  order.forEach(function (b) {
    var st = {}, total = 0, trx = 0;
    b.lines.forEach(function (p) { st[p.status] = (st[p.status] || 0) + 1; if (p.status !== 'REVERSED') { total += p.finalC; trx += p.cnt; } });
    b.total = total; b.trx = trx;
    var keys = Object.keys(st);
    b.status = keys.length === 1 ? keys[0] : (st.STAMPING || st.CHECK ? 'CHECK' : 'PARTLY REVERSED');
  });
  return order.sort(function (a, b) { return b.row - a.row; });
}

function viewPayouts() {
  var list = batches(), open = S.payouts.open;
  var h = head('Payouts', 'Every payout made with this tool, newest first. Open one to download its bank file or breakdown, or to undo a returned transfer.',
    '<a class="btn" target="_blank" rel="noopener" href="' + esc(sheetUrl(S.cfg.logId)) + '">Open the Payout Log sheet</a>');
  if (!list.length) return h + '<div class="panel empty"><b>No payouts yet.</b> Payouts appear here after Mark paid.</div>';
  h += '<div class="tablewrap" style="max-height:none"><table class="t"><thead><tr><th>Batch</th><th>Payout date</th><th class="num">Lines</th>' +
    '<th class="num">Trx</th><th class="num">Total</th><th>By</th><th>Status</th></tr></thead><tbody>';
  list.forEach(function (b) {
    h += '<tr class="click" data-action="payout-open" data-batch="' + esc(b.id) + '"><td class="id">' + esc(b.id) + '</td>' +
      '<td><span class="stamp sm">' + esc(E.payLabel(b.payKey)) + '</span></td><td class="num">' + b.lines.length + '</td><td class="num">' + b.trx + '</td>' +
      '<td>' + money(b.total) + '</td><td class="small">' + esc(b.by) + '<br><span class="muted">' + esc(String(b.at)) + '</span></td><td>' + chip(b.status.replace(' ', '_'), STATUS_TEXT[b.status]) + '</td></tr>';
    if (open === b.id) h += '<tr><td colspan="7" style="background:var(--sheet-2)">' + payoutDetail(b) + '</td></tr>';
  });
  return h + '</tbody></table></div>';
}

function payoutDetail(b) {
  var picked = S.payouts.picked;
  var h = '<div class="row" style="margin:6px 0 10px"><button class="btn" data-action="bank-again" data-batch="' + esc(b.id) + '">Download bank file</button>' +
    '<button class="btn" data-action="payout-breakdown" data-batch="' + esc(b.id) + '">Download breakdown</button>' +
    '<span class="grow"></span><button class="btn danger" data-action="payout-undo" data-batch="' + esc(b.id) + '">Undo selected lines</button></div>' +
    '<table class="t"><thead><tr><th><input type="checkbox" data-action="pick-all" data-batch="' + esc(b.id) + '" aria-label="Select all lines"></th><th>#</th><th>Brand</th><th>TID</th><th>Dates</th>' +
    '<th>Bank</th><th>Account</th><th class="num">Trx</th><th class="num">Paid</th><th>Status</th></tr></thead><tbody>';
  b.lines.forEach(function (p) {
    var can = p.status !== 'REVERSED', key = b.id + '|' + p.row;
    h += '<tr class="' + (can ? '' : 'off') + '"><td>' + (can ? '<input type="checkbox" data-action="pick" data-key="' + esc(key) + '"' + (picked[key] ? ' checked' : '') + ' aria-label="Select line ' + p.line + '">' : '') + '</td>' +
      '<td>' + p.line + '</td><td dir="auto">' + esc(p.brand) + '<div class="small muted" dir="auto">' + esc(p.holder) + '</div></td><td class="id">' + esc(p.tid) + '</td>' +
      '<td class="nowrap">' + esc(E.keyLabel(p.from)) + '<br>' + esc(E.keyLabel(p.to)) + '</td><td>' + esc(p.bankCode) + '</td><td class="id">' + esc(p.account) + '</td>' +
      '<td class="num">' + p.cnt + '</td><td>' + money(p.finalC) + (p.adjC ? '<div class="small muted">adj ' + E.fmtC(p.adjC) + ' ' + esc(p.adjReason) + '</div>' : '') + '</td>' +
      '<td>' + chip(p.status) + (p.status === 'REVERSED' ? '<div class="small muted">' + esc(p.rreason) + '<br>' + esc(p.rby) + '</div>' : '') + '</td></tr>';
  });
  return h + '</tbody></table><p class="small muted">Source: ' + esc(b.lines[0].source) + '</p>';
}

function payoutUndo(batchId) {
  var picked = Object.keys(S.payouts.picked).filter(function (k) { return S.payouts.picked[k] && k.indexOf(batchId + '|') === 0; });
  var b = batches().filter(function (x) { return x.id === batchId; })[0];
  var lines = b.lines.filter(function (p) { return p.status !== 'REVERSED' && (!picked.length || picked.indexOf(batchId + '|' + p.row) >= 0); });
  if (!lines.length) { toast('Nothing to undo in ' + batchId + '.', true); return; }
  if (!sessionOk()) return;
  var reason = '';
  modal({
    title: 'Undo ' + plural(lines.length, 'line') + ' of ' + batchId + '?',
    html: '<p>Their transactions go back to unpaid ("0" in Settleted), so they can be paid again later.</p>' +
      '<ul class="small">' + lines.map(function (p) { return '<li>' + esc((p.brand || '') + ' TID ' + p.tid + ': ' + E.fmtC(p.finalC)) + '</li>'; }).join('') + '</ul>' +
      '<label class="field"><span>Reason (required)</span><input type="text" id="undo-reason" placeholder="e.g. Transfer returned by the bank"></label>',
    ok: 'Undo payout', okClass: 'danger',
    onOk: function (el) {
      reason = el.querySelector('#undo-reason').value.trim();
      if (!reason) { el.querySelector('#undo-reason').focus(); return false; }
      return true;
    }
  }).then(function (yes) {
    if (!yes) return;
    busy('Starting');
    var tids = picked.length ? lines.map(function (p) { return p.tid; }) : null;
    S.store.reverse(batchId, tids, reason, busyStep).then(function (rv) {
      S.payouts.picked = {};
      busyStep('Reading the sheets again');
      return Promise.all([S.store.loadRaw(busyStep), S.store.loadLog()]).then(function (x) {
        setData(x[0], x[1]);
        done();
        refreshRail();
        renderView();
        var msg = 'Undone: ' + plural(rv.trx, 'transaction') + ' back to unpaid.';
        if (rv.skipped.length) {
          modal({ title: 'Some rows were left as they are', html: '<p>' + esc(msg) + '</p><ul class="small">' +
            rv.skipped.slice(0, 20).map(function (s) { return '<li>' + esc(s.why) + '</li>'; }).join('') + '</ul>', ok: 'OK', cancel: false });
        } else toast(msg);
      });
    }).catch(function (e) { done(); modal({ title: 'Nothing was undone', html: '<div class="alert err">' + esc(e.message) + '</div>', ok: 'OK', cancel: false }); });
  });
}

/* ------------------------------------------------------------------ */
/*  Import                                                              */
/* ------------------------------------------------------------------ */
function viewImport() {
  var im = S.imp;
  var h = head('Import', 'Add the Kashier transactions export to RAW data. Dates are read the right way (day/month), ' +
    'transactions already in the sheet are skipped, and new rows start unpaid ("0").');
  if (im.result) h += '<div class="alert ok">' + im.result + '</div>';
  h += '<div class="panel"><div class="drop"><p><b>Open the Kashier export</b> (.xlsx or .csv, with its header row)</p>' +
    '<label class="btn primary">Choose file<input type="file" accept=".xlsx,.xls,.csv" data-action="import-file" hidden></label></div>';
  if (im.error) h += '<div class="alert err" style="margin-top:12px;white-space:pre-line">' + esc(im.error) + '</div>';
  if (im.plan) {
    var p = im.plan, have = {};
    S.raw.recs.forEach(function (r) { have[r.trx] = 1; });
    var fresh = p.rows.filter(function (x) { return !have[x.trx]; });
    var minK = 0, maxK = 0, tids = {};
    fresh.forEach(function (x) { if (!minK || x.dk < minK) minK = x.dk; if (x.dk > maxK) maxK = x.dk; tids[x.tid] = 1; });
    h += '<h2 style="margin-top:16px">' + esc(im.name) + '</h2><dl class="small" style="display:grid;grid-template-columns:auto 1fr;gap:4px 16px">' +
      '<dt>New transactions</dt><dd><b>' + fresh.length + '</b>' + (fresh.length ? ', ' + esc(E.keyLabel(minK)) + ' to ' + esc(E.keyLabel(maxK)) + ', ' + plural(Object.keys(tids).length, 'TID') : '') + '</dd>' +
      '<dt>Already in RAW data</dt><dd>' + (p.rows.length - fresh.length) + ' (skipped)</dd>' +
      (p.dupInside ? '<dt>Repeated inside the file</dt><dd>' + p.dupInside + ' (skipped)</dd>' : '') +
      '<dt>Dates read as</dt><dd>' + (p.order === 'DMY' ? 'day/month/year' : 'month/day/year') + (p.ambiguous ? ' <b class="neg">(the file does not prove it: check the dates above)</b>' : '') + '</dd>' +
      (p.unmatched.length ? '<dt>Columns not in RAW data</dt><dd>' + esc(p.unmatched.join(', ')) + ' (ignored)</dd>' : '') + '</dl>' +
      '<div class="row" style="margin-top:12px"><button class="btn primary" data-action="import-go"' + (fresh.length ? '' : ' disabled') + '>Add ' +
      plural(fresh.length, 'transaction') + ' to RAW data</button></div>';
  }
  return h + '</div>';
}

function importGo() {
  var p = S.imp.plan;
  if (!p || !sessionOk()) return;
  busy('Starting');
  S.store.importRows(p, busyStep).then(function (out) {
    busyStep('Reading the sheet again');
    return S.store.loadRaw(busyStep).then(function (raw) {
      setData(raw, S.log);
      done();
      S.imp.plan = null;
      S.imp.result = out.added ? 'Added ' + plural(out.added, 'transaction') + ' to RAW data (rows ' + out.start + ' to ' + out.end + ').' +
        (out.skipped ? ' ' + out.skipped + ' were already there.' : '') : 'Nothing added: all of them are already in RAW data.';
      refreshRail();
      renderView();
    });
  }).catch(function (e) { done(); modal({ title: 'Nothing was added', html: '<div class="alert err">' + esc(e.message) + '</div>', ok: 'OK', cancel: false }); });
}

/* ------------------------------------------------------------------ */
/*  Data check                                                          */
/* ------------------------------------------------------------------ */
var ISSUE_TEXT = { FIXED: 'Day and month swapped in the sheet', ODD: 'Date does not fit', NO_DATE: 'No date', FUTURE: 'Future date',
  STATUS: 'Settlement Status disagrees',
  DUP_PAID: 'Duplicate of a paid row', DUP: 'Duplicate row', AMOUNT: 'Amount not a number', NO_TID: 'No TID' };

function viewCheck() {
  if (!S.issues) S.issues = E.issues(S.raw.recs, S.today);
  var list = S.issues, by = {};
  list.forEach(function (x) { by[x.kind] = (by[x.kind] || 0) + 1; });
  var fixable = list.filter(function (x) { return x.kind === 'FIXED'; });
  var h = head('Data check', 'Rows in RAW data that could make a payout wrong. The tool already handles them as described; fix the sheet when you can.',
    list.length ? '<button class="btn" data-action="check-export">Download list</button>' : '');
  if (!list.length) return h + '<div class="panel empty"><b>No problems found</b> in the unpaid rows.</div>';
  h += '<div class="panel"><div class="figures">' + Object.keys(by).map(function (k) {
    return '<div class="fig"><div class="v">' + by[k] + '</div><div class="l">' + esc(ISSUE_TEXT[k] || k) + '</div></div>';
  }).join('') + '</div>' +
    (fixable.length ? '<p class="small" style="margin:12px 0 0">The tool reads these dates from the transaction order (TX numbers grow with time). ' +
      '<button class="btn" data-action="fix-dates">Write the ' + fixable.length + ' corrected dates into RAW data</button></p>' : '') + '</div>';
  h += '<div class="tablewrap"><table class="t"><thead><tr><th>Row</th><th>TID</th><th>TRX ID</th><th>Date used</th><th class="num">Settlement</th><th>Problem</th></tr></thead><tbody>' +
    list.map(function (x) {
      return '<tr class="click" data-action="open-tid" data-tid="' + esc(x.r.tid) + '" data-dk="' + (x.r.dateKey || '') + '"><td class="muted">' + x.r.row + '</td><td class="id">' + esc(x.r.tid) + '</td>' +
        '<td class="id">' + esc(x.r.trx) + '</td><td class="nowrap">' + dateCell(x.r) + '</td><td>' + money(x.r.amtC) + '</td>' +
        '<td class="small"><b>' + esc(ISSUE_TEXT[x.kind] || x.kind) + '.</b> ' + esc(x.text) + '</td></tr>';
    }).join('') + '</tbody></table></div>';
  return h;
}

function fixDates() {
  var items = (S.issues || []).filter(function (x) { return x.kind === 'FIXED'; }).map(function (x) {
    return { row: x.r.row, trx: x.r.trx, stored: x.r.dateStored, fixed: x.r.dateKey };
  });
  if (!items.length || !sessionOk()) return;
  modal({
    title: 'Write ' + plural(items.length, 'corrected date') + '?',
    html: '<p>Each row gets its real date in the Date column, shown as dd/mm/yyyy. Only these unpaid rows change; nothing else in RAW data is touched.</p>',
    ok: 'Write dates'
  }).then(function (yes) {
    if (!yes) return;
    busy('Starting');
    S.store.fixDates(items, busyStep).then(function (out) {
      return S.store.loadRaw(busyStep).then(function (raw) {
        setData(raw, S.log); done(); refreshRail(); renderView();
        toast('Wrote ' + plural(out.fixed, 'date') + (out.skipped ? '. ' + out.skipped + ' rows had changed and were left as they are.' : '.'));
      });
    }).catch(function (e) { done(); modal({ title: 'No date was written', html: '<div class="alert err">' + esc(e.message) + '</div>', ok: 'OK', cancel: false }); });
  });
}

/* ------------------------------------------------------------------ */
/*  Settings                                                            */
/* ------------------------------------------------------------------ */
function teamLink() {
  var c = S.cfg;
  return location.origin + location.pathname + '#c=' + encodeURIComponent(c.clientId || '') + '&s=' + encodeURIComponent(c.sheetId) +
    '&l=' + encodeURIComponent(c.logId) + (c.hd ? '&h=' + encodeURIComponent(c.hd) : '');
}
function viewSettings() {
  var c = S.cfg;
  var h = head('Settings', '');
  h += '<div class="panel"><h2>Sheets</h2><p><a target="_blank" rel="noopener" href="' + esc(sheetUrl(c.sheetId)) + '">' + esc(S.raw.title || 'Event settlement') + '</a>: tab "' + esc(c.rawTab) +
    '". The tool writes only the Settleted column there (plus new rows from Import and corrected dates from Data check).</p>' +
    '<p><a target="_blank" rel="noopener" href="' + esc(sheetUrl(c.logId)) + '">Payout Log</a>: tabs Payouts, Transactions, Banks, Locks.</p>' +
    (S.demo ? '' : '<p class="small muted">Signed in as ' + esc(S.auth.email) + '. Teammates need edit access to both sheets.</p>' +
      '<div class="row"><button class="btn" data-action="copy-link">Copy the team link</button><button class="btn" data-action="signout">Sign out</button>' +
      '<button class="btn link" data-action="goto-settings-reset">Change sheet links</button></div>') + '</div>';
  h += '<div class="panel"><h2>Bank codes</h2><p class="sub">Bank names as Sales writes them, and the code used in the bank file. Add new ones in the Banks tab of the Payout Log, or when a Sales line is blocked.</p>' +
    '<div class="tablewrap" style="max-height:340px"><table class="t"><thead><tr><th>Bank name</th><th>Code</th></tr></thead><tbody>' +
    Object.keys(S.log.bankState.bankMap).sort().map(function (k) { return '<tr><td dir="auto">' + esc(k) + '</td><td>' + esc(S.log.bankState.bankMap[k]) + '</td></tr>'; }).join('') +
    '</tbody></table></div></div>';
  return h;
}

/* ------------------------------------------------------------------ */
/*  Excel files (SheetJS, loaded when first needed)                     */
/* ------------------------------------------------------------------ */
var xlsxPromise = null;
function loadXLSX() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (!xlsxPromise) {
    xlsxPromise = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'vendor/xlsx.full.min.js?v=0.18.5';
      s.onload = function () { resolve(window.XLSX); };
      s.onerror = function () { xlsxPromise = null; reject(new Error('Could not load the Excel library. Reload the page.')); };
      document.head.appendChild(s);
    });
  }
  return xlsxPromise;
}

/** First sheet of a file -> rows of cell values. typed: real date cells become {dateSerial}. */
function readGrid(file, typed) {
  return loadXLSX().then(function (X) {
    return file.arrayBuffer().then(function (buf) {
      var csv = /\.csv$/i.test(file.name);
      var wb = csv ? X.read(new TextDecoder('utf-8').decode(buf), { type: 'string', raw: true }) : X.read(buf, { type: 'array', cellDates: false });
      var ws = wb.Sheets[wb.SheetNames[0]];
      if (!ws || !ws['!ref']) return [];
      var range = X.utils.decode_range(ws['!ref']), grid = [];
      for (var r = range.s.r; r <= range.e.r; r++) {
        var row = [];
        for (var c = range.s.c; c <= range.e.c; c++) {
          var cell = ws[X.utils.encode_cell({ r: r, c: c })];
          if (!cell || cell.v === undefined || cell.v === null) { row.push(''); continue; }
          if (typed && cell.t === 'n' && cell.z && X.SSF.is_date(cell.z)) row.push({ dateSerial: cell.v });
          else row.push(cell.v);
        }
        grid.push(row);
      }
      return grid;
    });
  });
}

function saveXlsx(name, sheets) {
  return loadXLSX().then(function (X) {
    var wb = X.utils.book_new();
    sheets.forEach(function (s) {
      var ws = X.utils.aoa_to_sheet(s.rows);
      if (s.cols) ws['!cols'] = s.cols.map(function (w) { return { wch: w }; });
      if (s.fmt) s.fmt(ws, X);
      X.utils.book_append_sheet(wb, ws, s.name.slice(0, 31));
    });
    X.writeFile(wb, name.replace(/[\\/:*?"<>|]+/g, '_') + '.xlsx');
  }).catch(function (e) { toast(e.message, true); });
}

function setFmt(ws, X, col, fromRow, toRow, z, asText) {
  for (var r = fromRow; r <= toRow; r++) {
    var cell = ws[X.utils.encode_cell({ r: r, c: col })];
    if (!cell) continue;
    if (asText && cell.t !== 's') { cell.t = 's'; cell.v = String(cell.v); }
    cell.z = z;
  }
}

/** The bank bulk file in the same layout as Event_01_Batch_23_Nov_2026.xlsx. */
function downloadBankFile(lines, batchId, payKey) {
  var rows = E.bankRows(lines);
  rows.forEach(function (r) { r[9] = Number(r[9]); });
  var seq = Number(String(batchId).split('-').pop()) || 1;
  return saveXlsx(E.bankFileName(S.cfg.prefix || 'Event', batchId, payKey), [{
    name: 'Batch ' + seq, rows: [E.BANK_HEADERS].concat(rows), cols: [12, 11, 10, 31, 31, 12, 18, 17, 17, 13, 6, 19],
    fmt: function (ws, X) {
      setFmt(ws, X, 3, 1, rows.length, '@', true);
      setFmt(ws, X, 4, 1, rows.length, '@', true);
      setFmt(ws, X, 5, 1, rows.length, '@', true);
      setFmt(ws, X, 7, 1, rows.length, '#,##0.00');
      setFmt(ws, X, 9, 1, rows.length, '@');
    }
  }]);
}

function bankAgain(batchId) {
  var lines = S.log.payouts.filter(function (p) { return p.batch === batchId && p.status !== 'REVERSED' && p.bankCode && p.account; });
  if (!lines.length) { toast('No bank lines in ' + batchId + ' (paid without bank details, or undone).', true); return; }
  downloadBankFile(lines.map(function (p) { return { holder: p.holder, account: p.account, bankCode: p.bankCode, finalC: p.finalC, tid: p.tid }; }),
    batchId, lines[0].payKey);
}

var TRX_HEAD = ['Row', 'Date', 'Date in sheet', 'Time', 'TRX ID', 'Type', 'Status', 'Card Type', 'Card Num', 'Auth ID', 'Amount', 'Settlement Amount', 'Settleted'];
function trxRow(r) {
  return [r.row, E.keyLabel(r.dateKey), r.dateFixed ? E.keyLabel(r.dateStored) : '', E.timeLabel(r.time), r.trx, r.type, r.status, r.cardType, r.card, r.auth,
    r.amount === null ? '' : r.amount, r.amtC / 100, r.dupOf ? 'Duplicate of row ' + r.dupOf : (r.paid ? r.paidLabel : '0')];
}
function stamp() { return E.keyLabel(S.today) + ' by ' + (S.auth.email || ''); }

function tidBreakdown() {
  var t = S.tid, res = E.computeLines([tidLine()], S.raw.recs, ctx())[0], list = tidTrxList();
  var days = E.tidDays(S.raw.recs, t.tid).filter(function (d) { return t.from && d.dk >= t.from && d.dk <= t.to; });
  saveXlsx('TID_' + t.tid + '_' + E.keyLabel(t.from) + '_to_' + E.keyLabel(t.to), [
    { name: 'Summary', cols: [22, 40], rows: [['TID', t.tid], ['MID', res.mid], ['From', E.keyLabel(t.from)], ['To', E.keyLabel(t.to)],
      ['Unpaid transactions', res.cnt], ['Unpaid amount', res.amtC / 100], ['Adjustment', res.line.adjC / 100], ['Adjustment reason', res.line.adjReason],
      ['To pay', res.finalC / 100], ['Check', STATUS_TEXT[res.status]], ['Notes', res.notes.map(function (n) { return n.t; }).join(' | ')], ['Downloaded', stamp()]] },
    { name: 'Transactions', cols: [8, 12, 12, 9, 18, 10, 12, 10, 18, 9, 11, 14, 14], rows: [TRX_HEAD].concat(list.map(trxRow)) },
    { name: 'By day', cols: [13, 12, 14, 10, 14, 30], rows: [['Date', 'Unpaid trx', 'Unpaid amount', 'Paid trx', 'Paid amount', 'Paid on']].concat(days.map(function (d) {
      return [E.keyLabel(d.dk), d.unpaidN, d.unpaidC / 100, d.paidN, d.paidC / 100, Object.keys(d.labels).join(', ')];
    })) }
  ]);
}

function batchBreakdown() {
  var res = S.batch.results || [];
  var lineRows = res.map(function (r) {
    var L = r.line;
    return [L.row, L.brand, L.tid, L.daysText, E.keyLabel(L.from), E.keyLabel(L.to), L.bankName, L.bankCode, L.account, L.holder, r.cnt, r.amtC / 100,
      L.adjC / 100, L.adjReason, r.finalC / 100, L.salesAmtC === null || L.salesAmtC === undefined ? '' : L.salesAmtC / 100, STATUS_TEXT[r.status] || r.status,
      r.notes.map(function (n) { return n.t; }).join(' | ')];
  });
  var trx = [];
  res.forEach(function (r) {
    r.recs.forEach(function (x) { trx.push([r.line.row, r.line.brand, r.line.tid].concat(trxRow(x))); });
  });
  saveXlsx('Sales_request_breakdown_' + E.keyLabel(S.today), [
    { name: 'Lines', cols: [5, 20, 13, 22, 12, 12, 16, 8, 30, 26, 7, 12, 11, 18, 12, 12, 16, 60],
      rows: [['#', 'Brand', 'TID', 'Days to settle', 'From', 'To', 'Bank name', 'Bank code', 'Account', 'Holder', 'Trx', 'Amount', 'Adjustment',
        'Adjustment reason', 'To pay', 'Sales amount', 'Check', 'Notes']].concat(lineRows) },
    { name: 'Transactions', rows: [['#', 'Brand', 'TID'].concat(TRX_HEAD)].concat(trx) }
  ]);
}

function payoutBreakdown(batchId) {
  var lines = S.log.payouts.filter(function (p) { return p.batch === batchId; });
  busy('Reading the payout log');
  S.store.payoutTransactions(lines).then(function (list) {
    done();
    var lineRows = lines.map(function (p) {
      return [p.line, p.brand, p.tid, p.mid, E.keyLabel(p.from), E.keyLabel(p.to), p.cnt, p.amtC / 100, p.adjC / 100, p.adjReason, p.finalC / 100,
        p.holder, p.account, p.bankName, p.bankCode, p.status, p.by, String(p.at), p.rreason];
    });
    var trx = list.map(function (x) {
      var r = S.byRow[x.row];
      var same = r && r.trx === x.trx;
      return [x.line, x.tid, x.trx, x.row, E.keyLabel(x.dateKey), same ? E.timeLabel(r.time) : '', same ? r.card : '', same ? r.auth : '',
        same && r.amount !== null ? r.amount : '', x.amtC / 100, x.label, x.status];
    });
    saveXlsx(batchId + '_breakdown', [
      { name: 'Lines', rows: [['#', 'Brand', 'TID', 'MID', 'From', 'To', 'Trx', 'Amount', 'Adjustment', 'Adjustment reason', 'Paid', 'Holder', 'Account',
        'Bank name', 'Bank code', 'Status', 'Paid by', 'Paid at', 'Undo reason']].concat(lineRows) },
      { name: 'Transactions', rows: [['#', 'TID', 'TRX ID', 'RAW row', 'Date', 'Time', 'Card', 'Auth ID', 'Amount', 'Settlement Amount', 'Payout label', 'Status']].concat(trx) }
    ]);
  }).catch(function (e) { done(); toast(e.message, true); });
}

function unpaidExport() {
  var ov = E.unpaidOverview(S.raw.recs, S.today);
  var rows = S.raw.recs.filter(function (r) { return !r.paid && !r.dupOf; }).sort(function (a, b) { return a.tid < b.tid ? -1 : a.tid > b.tid ? 1 : (a.dateKey || 0) - (b.dateKey || 0); });
  saveXlsx('Unpaid_' + E.keyLabel(S.today), [
    { name: 'By TID', rows: [['TID', 'MID', 'Unpaid trx', 'Unpaid amount', 'First day', 'Last day', 'Last paid', 'Without usable date']].concat(ov.rows.map(function (t) {
      return [t.tid, t.mid, t.unpaidN, t.unpaidC / 100, E.keyLabel(t.firstUnpaid), E.keyLabel(t.lastUnpaid), t.lastPaidLabel, t.badN];
    })) },
    { name: 'Transactions', rows: [['TID', 'MID'].concat(TRX_HEAD)].concat(rows.map(function (r) { return [r.tid, r.mid].concat(trxRow(r)); })) }
  ]);
}

function searchExport() {
  var r = E.search(S.raw.recs, S.search.q, S.search.filter, 100000);
  saveXlsx('Search_' + S.search.q.replace(/\s+/g, '_').slice(0, 30), [{ name: 'Results', rows: [['TID', 'MID'].concat(TRX_HEAD)].concat(r.rows.map(function (x) { return [x.tid, x.mid].concat(trxRow(x)); })) }]);
}

function checkExport() {
  saveXlsx('Data_check_' + E.keyLabel(S.today), [{ name: 'Problems', rows: [['Row', 'TID', 'TRX ID', 'Problem', 'Details', 'Date in sheet', 'Date used', 'Settlement Amount']].concat(
    (S.issues || []).map(function (x) {
      return [x.r.row, x.r.tid, x.r.trx, ISSUE_TEXT[x.kind] || x.kind, x.text, x.r.dateFixed ? E.keyLabel(x.r.dateStored) : E.keyLabel(x.r.dateKey), E.keyLabel(x.r.dateKey), x.r.amtC / 100];
    })) }]);
}

/* ------------------------------------------------------------------ */
/*  events                                                              */
/* ------------------------------------------------------------------ */
root.addEventListener('click', function (e) {
  var el = e.target.closest('[data-action]');
  if (!el || el.tagName === 'INPUT' && el.type === 'file') return;
  var a = el.getAttribute('data-action');
  if (el.tagName === 'A' && a) e.preventDefault();
  switch (a) {
    case 'signin': doSignIn(false); break;
    case 'signin-other': doSignIn(true); break;
    case 'retry': loadAll(); break;
    case 'save-connect':
      S.cfg = S.cfg || {};
      S.cfg.clientId = $('#cf-c').value.trim(); S.cfg.sheetId = idFrom($('#cf-s').value); S.cfg.logId = idFrom($('#cf-l').value);
      if (!S.cfg.clientId || !S.cfg.sheetId || !S.cfg.logId) { renderConnect('Fill all three.'); break; }
      lsSet('es.cfg', { clientId: S.cfg.clientId, sheetId: S.cfg.sheetId, logId: S.cfg.logId, hd: S.cfg.hd || '' });
      boot(); break;
    case 'goto-settings-reset': lsDel('es.cfg'); S.cfg = readConfig(); renderConnect(); break;
    case 'reload': loadAll(true); break;
    case 'signout': S.auth.signOut(); renderSignIn(); break;
    case 'go': go(el.getAttribute('data-view')); break;
    case 'tid-clear': S.tid = freshTid(''); renderView(); break;
    case 'open-tid': {
      var dk = Number(el.getAttribute('data-dk')) || 0, info = S.idx[el.getAttribute('data-tid')];
      if (!info) break;
      selectTid(el.getAttribute('data-tid'), dk && !info.firstUnpaid ? dk : null, dk && !info.firstUnpaid ? dk : null);
      go('tid'); break;
    }
    case 'day': {
      var k = Number(el.getAttribute('data-dk')), t = S.tid;
      if (!k) break;
      if (!t.pick || !t.from) { t.from = k; t.to = k; t.pick = true; }
      else { if (k < t.from) { t.to = t.from; t.from = k; } else t.to = k; t.pick = false; }
      t.alert = null;
      renderView(); break;
    }
    case 'tid-all-unpaid': {
      var inf = S.idx[S.tid.tid];
      if (inf && inf.firstUnpaid) { S.tid.from = inf.firstUnpaid; S.tid.to = inf.lastUnpaid; S.tid.pick = false; renderView(); }
      break;
    }
    case 'tid-pay': tidPay(); break;
    case 'tid-breakdown': if (S.tid.from && S.tid.to) tidBreakdown(); else toast('Pick the dates first.', true); break;
    case 'tid-to-batch': {
      var L = tidLine();
      L.row = (S.batch.lines.reduce(function (m, l) { return Math.max(m, l.row || 0); }, 0)) + 1;
      L.daysText = E.keyLabel(L.from) + ' to ' + E.keyLabel(L.to); L.manualDates = false; L.adjText = S.tid.adjText; L.bankName = L.bankCode;
      L.salesAmtC = null; delete L.noBank;
      S.batch.lines.push(L); S.batch.source = S.batch.source || 'Lines added from Settle a TID';
      recomputeBatch(); saveDraft(); toast('Added TID ' + L.tid + ' to the Sales request.'); go('batch'); break;
    }
    case 'sales-sample': loadSalesGrid(S.demoSales, 'Sample Sales request (demo)'); break;
    case 'sales-paste': {
      var txt = ($('#paste') || {}).value || '';
      var grid = txt.split(/\r?\n/).filter(function (l) { return l.trim(); }).map(function (l) { return l.split('\t'); });
      if (!grid.length) { toast('Paste the lines first.', true); break; }
      loadSalesGrid(grid, 'Pasted lines'); break;
    }
    case 'batch-clear':
      modal({ title: 'Clear the Sales request?', html: '<p>The lines leave this page. Payouts already made stay in the Payout Log.</p>', ok: 'Clear', okClass: 'danger' })
        .then(function (y) { if (!y) return; S.batch.lines = []; S.batch.results = null; S.batch.source = ''; S.batch.alert = null; saveDraft(); refreshRail(); renderView(); });
      break;
    case 'batch-pay': batchPay(); break;
    case 'batch-breakdown': batchBreakdown(); break;
    case 'bank-again': bankAgain(el.getAttribute('data-batch')); break;
    case 'line-remove': {
      var li = S.batch.lines[Number(el.getAttribute('data-i'))];
      if (li) { li.removed = true; recomputeBatch(); saveDraft(); refreshRail(); renderView(); }
      break;
    }
    case 'line-open': {
      var lo = S.batch.lines[Number(el.getAttribute('data-i'))];
      if (!lo) break;
      selectTid(lo.tid, lo.from, lo.to);
      S.tid.brand = lo.brand || ''; S.tid.account = lo.account || ''; S.tid.holder = lo.holder || ''; S.tid.bankCode = lo.bankCode || ''; S.tid.prefill = null;
      go('tid'); break;
    }
    case 'search-filter': S.search.filter = el.getAttribute('data-f'); renderView(); break;
    case 'search-export': searchExport(); break;
    case 'unpaid-export': unpaidExport(); break;
    case 'payout-open': S.payouts.open = S.payouts.open === el.getAttribute('data-batch') ? null : el.getAttribute('data-batch'); renderView(); break;
    case 'pick': S.payouts.picked[el.getAttribute('data-key')] = el.checked; return;
    case 'pick-all': {
      var bid = el.getAttribute('data-batch'), on = el.checked;
      S.log.payouts.forEach(function (p) { if (p.batch === bid && p.status !== 'REVERSED') S.payouts.picked[bid + '|' + p.row] = on; });
      renderView(); return;
    }
    case 'payout-undo': payoutUndo(el.getAttribute('data-batch')); break;
    case 'payout-breakdown': payoutBreakdown(el.getAttribute('data-batch')); break;
    case 'import-go': importGo(); break;
    case 'fix-dates': fixDates(); break;
    case 'check-export': checkExport(); break;
    case 'copy-link':
      if (navigator.clipboard) navigator.clipboard.writeText(teamLink()).then(function () { toast('Team link copied.'); }, function () { toast(teamLink()); });
      else toast(teamLink());
      break;
  }
});

root.addEventListener('change', function (e) {
  var el = e.target;
  var a = el.getAttribute('data-action');
  if (a === 'sales-file' || a === 'import-file') {
    var f = el.files && el.files[0];
    if (!f) return;
    el.value = '';
    if (a === 'sales-file') {
      readGrid(f, false).then(function (grid) { loadSalesGrid(grid, f.name); }, function (err) { toast('Could not read ' + f.name + ': ' + err.message, true); });
    } else {
      S.imp = { name: f.name, plan: null, error: '', result: null };
      readGrid(f, true).then(function (grid) {
        if (!grid.length) { S.imp.error = 'The file is empty.'; renderView(); return; }
        var plan = E.planImport(grid, S.raw.header.map(E.normText), S.today, 'DMY');
        if (plan.fatal) S.imp.error = plan.fatal; else S.imp.plan = plan;
        renderView();
      }, function (err) { S.imp.error = 'Could not read ' + f.name + ': ' + err.message; renderView(); });
    }
    return;
  }
  var bind = el.getAttribute('data-bind');
  if (!bind) {
    if (el.id === 'tid-input') {
      S.tid.input = el.value.trim();
      var tid = E.normTid(el.value);
      if (tid && S.idx[tid]) selectTid(tid); else { S.tid = freshTid(''); S.tid.input = el.value.trim(); }
      renderView();
    }
    return;
  }
  var p = bind.split('.'), v = el.value, dk = null;
  if (el.getAttribute('data-date')) {
    dk = parseDateInput(v);
    if (dk === false) { toast('Write the date as dd/mm/yyyy, for example 19/11/2026.', true); el.focus(); return; }
  }
  if (p[0] === 'tid') {
    if (p[1] === 'from' || p[1] === 'to' || p[1] === 'payKey') S.tid[p[1]] = dk;
    else S.tid[p[1]] = v;
    if (S.tid.from && S.tid.to && S.tid.from > S.tid.to) { var x = S.tid.from; S.tid.from = S.tid.to; S.tid.to = x; }
    S.tid.pick = false; S.tid.alert = null;
    if (!S.tid.payKey) S.tid.payKey = S.today;
    var calc = $('#tid-calc');
    if (p[1] === 'from' || p[1] === 'to' || p[1] === 'payKey') renderView();
    else if (calc) calc.innerHTML = tidCalcHtml();
  } else if (p[0] === 'batch') {
    S.batch.payKey = dk || S.today; renderView();
  } else if (p[0] === 'line') {
    var L = S.batch.lines[Number(p[2])];
    if (!L) return;
    if (p[1] === 'from' || p[1] === 'to') {
      L[p[1]] = dk;
      if (L.from && L.to) { L.dateError = null; L.parsedDates = false; L.manualDates = true; }
    } else if (p[1] === 'adj') { L.adjText = v; var adj = parseAdj(v); L.adjC = adj.c; L.adjInvalid = adj.bad; }
    else if (p[1] === 'reason') L.adjReason = v.trim();
    else if (p[1] === 'bankCode' && v) {
      L.bankCode = v;
      if (L.bankName && !S.demo) {
        modal({ title: 'Remember this bank?', html: '<p>Use code <b>' + esc(v) + '</b> every time Sales writes "<span dir="auto">' + esc(L.bankName) + '</span>"? It is saved in the Banks tab of the Payout Log.</p>', ok: 'Remember' })
          .then(function (y) {
            if (!y) return;
            S.store.addBank(L.bankName, v).then(function () { return S.store.loadLog(); })
              .then(function (log) { S.log = log; toast('Saved: ' + L.bankName + ' = ' + v); }, function (err) { toast(err.message, true); });
          });
      }
    }
    recomputeBatch(); saveDraft(); renderView();
  }
});

var searchTimer = null;
root.addEventListener('input', function (e) {
  if (e.target.id === 'q') {
    S.search.q = e.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () { var box = $('#search-results'); if (box) box.innerHTML = searchResults(); }, 160);
  }
});

root.addEventListener('keydown', function (e) {
  if (e.key === 'Enter' && e.target.id === 'tid-input') e.target.blur();
});

root.addEventListener('dragover', function (e) { if (S.view === 'batch' && $('#drop')) { e.preventDefault(); $('#drop').classList.add('over'); } });
root.addEventListener('dragleave', function () { var d = $('#drop'); if (d) d.classList.remove('over'); });
root.addEventListener('drop', function (e) {
  var d = $('#drop');
  if (!d || S.view !== 'batch') return;
  e.preventDefault(); d.classList.remove('over');
  var f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) readGrid(f, false).then(function (grid) { loadSalesGrid(grid, f.name); }, function (err) { toast(err.message, true); });
});

window.ESApp = { state: S, go: go, selectTid: selectTid };
boot();
})();
