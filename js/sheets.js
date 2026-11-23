/*!
 * Event Settlement - Google sign-in, Google Sheets API client and the write workflows.
 * Every write to RAW data goes through: lock -> fresh read -> same numbers? -> write -> read back.
 */
(function (root) {
'use strict';
var E = root.ESEngine || (typeof require === 'function' ? require('./engine.js') : null);

var SCOPES = 'https://www.googleapis.com/auth/spreadsheets openid email profile';
var LOCK_TTL_MS = 3 * 60 * 1000;

var LOG_HEADERS = {
  Payouts: ['Batch ID', 'Payout date', 'Line', 'Brand name', 'TID', 'MID', 'From', 'To', 'Trx count', 'Amount',
    'Adjustment', 'Adjustment reason', 'Final amount', 'Account number', 'Account holder', 'Bank name', 'Bank code',
    'Source', 'Paid by', 'Paid at', 'Status', 'Trx log rows', 'Reversed by', 'Reversed at', 'Reverse reason'],
  Transactions: ['Batch ID', 'Line', 'TID', 'TRX ID', 'RAW row', 'Trx date', 'Settlement Amount', 'Payout label', 'Status'],
  Banks: ['Bank name (as Sales writes it)', 'Bank code'],
  Locks: ['Lock ID', 'User', 'Started at (ms)', 'Purpose', 'State']
};
var P = { BATCH: 0, PDATE: 1, LINE: 2, BRAND: 3, TID: 4, MID: 5, FROM: 6, TO: 7, CNT: 8, AMT: 9, ADJ: 10, ADJR: 11,
  FINAL: 12, ACC: 13, HOLDER: 14, BANK: 15, CODE: 16, SRC: 17, BY: 18, AT: 19, STATUS: 20, TRXROWS: 21, RBY: 22,
  RAT: 23, RREASON: 24 };
var TX = { BATCH: 0, LINE: 1, TID: 2, TRX: 3, ROW: 4, DATE: 5, AMT: 6, LABEL: 7, STATUS: 8 };

function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function quoteTab(t) { return /^[A-Za-z0-9_]+$/.test(t) ? t : "'" + String(t).replace(/'/g, "''") + "'"; }
function firstRowOf(a1) { var m = /![A-Z]+(\d+)/.exec(String(a1 || '')); return m ? Number(m[1]) : 0; }
/** Cairo wall-clock time as text, e.g. "23-Nov-2026 21:30". The log keeps dates as text so they read the same everywhere. */
function nowLabel() {
  var d = new Date(), parts = {};
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d)
      .forEach(function (p) { parts[p.type] = p.value; });
    return E.keyLabel(E.key(+parts.year, +parts.month, +parts.day)) + ' ' + ('0' + (+parts.hour % 24)).slice(-2) + ':' + parts.minute;
  } catch (e) {
    return E.keyLabel(E.key(d.getFullYear(), d.getMonth() + 1, d.getDate())) + ' ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }
}
function randomId() {
  var a = new Uint8Array(8);
  (root.crypto || require('crypto').webcrypto).getRandomValues(a);
  return Array.prototype.map.call(a, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
}

/* ------------------------------------------------------------------ */
/*  Google sign-in (Google Identity Services, token model)              */
/* ------------------------------------------------------------------ */
function GoogleAuth(clientId, hostedDomain) {
  this.clientId = clientId; this.hd = hostedDomain || '';
  this.token = null; this.expiresAt = 0; this.email = ''; this.name = '';
  this._tc = null; this._pending = null;
}
GoogleAuth.prototype.ready = function () {
  return !!(root.google && root.google.accounts && root.google.accounts.oauth2);
};
GoogleAuth.prototype._client = function () {
  var self = this;
  if (!this._tc) {
    var opts = {
      client_id: this.clientId, scope: SCOPES,
      callback: function (resp) {
        var p = self._pending; self._pending = null;
        if (!p) return;
        if (resp.error) { p.reject(new Error(resp.error_description || resp.error)); return; }
        self.token = resp.access_token;
        self.expiresAt = Date.now() + (Number(resp.expires_in) || 3600) * 1000;
        p.resolve(self.token);
      },
      error_callback: function (err) {
        var p = self._pending; self._pending = null;
        if (!p) return;
        p.reject(new Error(err && err.type === 'popup_closed' ? 'The sign-in window was closed before finishing.'
          : err && err.type === 'popup_failed_to_open' ? 'The browser blocked the sign-in window. Allow pop-ups for this site.'
          : (err && err.message) || 'Sign-in failed.'));
      }
    };
    if (this.hd) opts.hd = this.hd;
    this._tc = root.google.accounts.oauth2.initTokenClient(opts);
  }
  return this._tc;
};
/** Must run inside a click handler (it opens Google's window). */
GoogleAuth.prototype.signIn = function (chooseAccount) {
  var self = this;
  return new Promise(function (resolve, reject) {
    if (!self.ready()) { reject(new Error('Google sign-in did not load. Check the connection and reload the page.')); return; }
    self._pending = { resolve: resolve, reject: reject };
    self._client().requestAccessToken({ prompt: chooseAccount ? 'select_account' : '' });
  }).then(function (t) { return self.loadProfile().then(function () { return t; }); });
};
GoogleAuth.prototype.loadProfile = function () {
  var self = this;
  return root.fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: 'Bearer ' + this.token } })
    .then(function (r) { return r.ok ? r.json() : {}; })
    .then(function (j) { self.email = j.email || self.email; self.name = j.name || self.name; })
    .catch(function () { /* the profile is only used for "Paid by" */ });
};
GoogleAuth.prototype.validFor = function (ms) { return !!this.token && Date.now() + (ms || 0) < this.expiresAt; };
GoogleAuth.prototype.signOut = function () {
  if (this.token && this.ready()) { try { root.google.accounts.oauth2.revoke(this.token, function () {}); } catch (e) { /* ignore */ } }
  this.token = null; this.expiresAt = 0;
};

/** Demo / test stand-in for GoogleAuth. */
function DemoAuth(email) { this.token = 'demo-token'; this.expiresAt = Infinity; this.email = email || 'you@example.com'; this.name = 'Demo user'; }
DemoAuth.prototype.ready = function () { return true; };
DemoAuth.prototype.signIn = function () { return Promise.resolve(this.token); };
DemoAuth.prototype.validFor = function () { return true; };
DemoAuth.prototype.signOut = function () {};

/* ------------------------------------------------------------------ */
/*  Sheets REST client                                                  */
/* ------------------------------------------------------------------ */
function SheetsError(status, message, detail) {
  var e = new Error(message); e.status = status; e.detail = detail || ''; return e;
}
function friendly(status, msg) {
  if (status === 401) return 'Your Google session ended. Sign in again.';
  if (status === 403) return 'Your Google account cannot open or edit this spreadsheet. Ask the owner to share it with you as Editor.';
  if (status === 404) return 'Spreadsheet not found. Check the sheet links in Settings.';
  if (status === 429) return 'Google is limiting requests right now. Wait a minute and try again.';
  return 'Google Sheets error (' + status + '): ' + msg;
}

function SheetsClient(opts) {
  this.fetch = opts.fetch || root.fetch.bind(root);
  this.getToken = opts.getToken;
  this.base = 'https://sheets.googleapis.com/v4/spreadsheets/';
}
SheetsClient.prototype.call = function (method, path, query, body, attempt) {
  var self = this;
  attempt = attempt || 0;
  var qs = [];
  Object.keys(query || {}).forEach(function (k) {
    var v = query[k];
    (Array.isArray(v) ? v : [v]).forEach(function (x) { qs.push(encodeURIComponent(k) + '=' + encodeURIComponent(x)); });
  });
  var url = this.base + path + (qs.length ? '?' + qs.join('&') : '');
  var headers = { Authorization: 'Bearer ' + this.getToken() };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  var isRead = method === 'GET';
  return this.fetch(url, { method: method, headers: headers, body: body === undefined ? undefined : JSON.stringify(body) })
    .then(function (res) {
      if (res.ok) return res.json();
      return res.text().then(function (txt) {
        var msg = txt;
        try { var j = JSON.parse(txt); msg = (j.error && j.error.message) || txt; } catch (e) { /* not JSON */ }
        // Retry reads on 429/5xx. Writes only on 429 (Google did not apply them).
        if ((res.status === 429 || (isRead && res.status >= 500)) && attempt < 3) {
          return wait(800 * Math.pow(2, attempt)).then(function () { return self.call(method, path, query, body, attempt + 1); });
        }
        throw SheetsError(res.status, friendly(res.status, msg), msg);
      });
    }, function (netErr) {
      if (isRead && attempt < 2) return wait(1200).then(function () { return self.call(method, path, query, body, attempt + 1); });
      throw SheetsError(0, isRead ? 'No connection to Google. Check the internet and try again.'
        : 'The connection dropped while writing. Reload and check the Payouts page before trying again.', String(netErr));
    });
};
SheetsClient.prototype.meta = function (id) {
  return this.call('GET', encodeURIComponent(id), {
    fields: 'spreadsheetId,properties.title,sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))'
  });
};
SheetsClient.prototype.batchGet = function (id, ranges, o) {
  o = o || {};
  return this.call('GET', encodeURIComponent(id) + '/values:batchGet', {
    ranges: ranges, majorDimension: o.major || 'ROWS', valueRenderOption: o.render || 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'SERIAL_NUMBER'
  }).then(function (j) { return j.valueRanges || []; });
};
SheetsClient.prototype.update = function (id, data, input) {
  return this.call('POST', encodeURIComponent(id) + '/values:batchUpdate', null, { valueInputOption: input || 'RAW', data: data });
};
SheetsClient.prototype.append = function (id, range, values, input) {
  return this.call('POST', encodeURIComponent(id) + '/values/' + encodeURIComponent(range) + ':append',
    { valueInputOption: input || 'RAW', insertDataOption: 'INSERT_ROWS' }, { values: values });
};
SheetsClient.prototype.batchUpdate = function (id, requests) {
  return this.call('POST', encodeURIComponent(id) + ':batchUpdate', null, { requests: requests });
};

/* ------------------------------------------------------------------ */
/*  Store: RAW data + Payout Log                                        */
/* ------------------------------------------------------------------ */
function Store(client, cfg, userFn) {
  this.client = client;
  this.cfg = cfg;           // {sheetId, logId, rawTab}
  this.user = userFn || function () { return 'unknown'; };
}

/** Reads the RAW data columns the tool needs (one request) and builds the records. */
Store.prototype.loadRaw = function (onStep) {
  var self = this, c = this.cfg, step = onStep || function () {};
  var tab = c.rawTab || 'RAW data', meta, hdr, hm;
  step('Opening the sheet');
  return this.client.meta(c.sheetId).then(function (m) {
    meta = m;
    var sh = (m.sheets || []).filter(function (s) { return s.properties.title === tab; })[0];
    if (!sh) throw new Error('Tab "' + tab + '" was not found in the spreadsheet.');
    meta.tab = sh.properties;
    return self.client.batchGet(c.sheetId, [quoteTab(tab) + '!1:1']);
  }).then(function (vr) {
    hdr = (vr[0] && vr[0].values && vr[0].values[0]) || [];
    hm = E.headerMap(hdr);
    if (hm.missing.length) throw new Error('RAW data is missing these columns: ' + hm.missing.join(', ') + '. Check the header row.');
    var last = meta.tab.gridProperties.rowCount;
    var fields = E.RAW_FIELDS.filter(function (f) { return hm[f]; });
    step('Reading ' + (last - 1).toLocaleString('en-US') + ' rows');
    return self.client.batchGet(c.sheetId, fields.map(function (f) {
      var L = E.colLetter(hm[f]);
      return quoteTab(tab) + '!' + L + '2:' + L + last;
    }), { major: 'COLUMNS' }).then(function (vrs) {
      var cols = {}, n = 0;
      fields.forEach(function (f, i) {
        var arr = (vrs[i] && vrs[i].values && vrs[i].values[0]) || [];
        cols[f] = arr;
        if (arr.length > n) n = arr.length;
      });
      step('Checking ' + n.toLocaleString('en-US') + ' transactions');
      var today = E.todayKey();
      var built = E.recsFromColumns(cols, n, today);
      return {
        recs: built.recs, lastDataKey: built.lastDataKey, dupTrx: built.dupTrx, dupRows: built.dupRows,
        datesFixed: built.datesFixed, datesOdd: built.datesOdd, hm: hm, header: hdr, gid: meta.tab.sheetId,
        rowCount: meta.tab.gridProperties.rowCount, colCount: meta.tab.gridProperties.columnCount,
        lastRow: n + 1, title: meta.properties && meta.properties.title, todayKey: today, loadedAt: Date.now()
      };
    });
  });
};

function cellNum(v) { var n = E.num(v); return isNaN(n) ? 0 : n; }
function serialKey(v) { return typeof v === 'number' && v > 20000 && v < 80000 ? E.serialToKey(v) : E.cellKey(v); }

/** Payout Log: Payouts + Banks tabs. */
Store.prototype.loadLog = function () {
  var self = this;
  return this.client.batchGet(this.cfg.logId, ['Payouts!A2:Y', 'Banks!A2:B']).then(function (vrs) {
    var payouts = ((vrs[0] && vrs[0].values) || []).map(function (v, i) {
      var g = function (k) { var x = v[k]; return x === undefined || x === null ? '' : x; };
      var tr = String(g(P.TRXROWS)).split(':');
      return {
        row: i + 2, batch: String(g(P.BATCH)).trim(), payKey: serialKey(g(P.PDATE)), line: Number(g(P.LINE)) || 0,
        brand: String(g(P.BRAND)), tid: E.normTid(g(P.TID)), mid: String(g(P.MID)), from: serialKey(g(P.FROM)),
        to: serialKey(g(P.TO)), cnt: Number(g(P.CNT)) || 0, amtC: Math.round(cellNum(g(P.AMT)) * 100),
        adjC: Math.round(cellNum(g(P.ADJ)) * 100), adjReason: String(g(P.ADJR)), finalC: Math.round(cellNum(g(P.FINAL)) * 100),
        account: String(g(P.ACC)), holder: String(g(P.HOLDER)), bankName: String(g(P.BANK)), bankCode: String(g(P.CODE)),
        source: String(g(P.SRC)), by: String(g(P.BY)), at: g(P.AT), status: String(g(P.STATUS)).trim().toUpperCase(),
        trxFrom: Number(tr[0]) || 0, trxTo: Number(tr[1]) || 0, rby: String(g(P.RBY)), rat: g(P.RAT), rreason: String(g(P.RREASON))
      };
    }).filter(function (p) { return p.batch; });
    var banks = ((vrs[1] && vrs[1].values) || []).map(function (v) { return [v[0], v[1]]; });
    return { payouts: payouts, banks: banks, bankState: E.bankState(E.BANK_SEED.concat(banks)), loadedAt: Date.now() };
  });
};

/** Checks the Payout Log has its four tabs and headers; creates what is missing. */
Store.prototype.ensureLog = function () {
  var self = this, id = this.cfg.logId;
  return this.client.meta(id).then(function (m) {
    var have = {};
    (m.sheets || []).forEach(function (s) { have[s.properties.title] = s.properties.sheetId; });
    var add = Object.keys(LOG_HEADERS).filter(function (t) { return have[t] === undefined; });
    var p = add.length ? self.client.batchUpdate(id, add.map(function (t) { return { addSheet: { properties: { title: t } } }; })) : Promise.resolve();
    return p.then(function () {
      return self.client.batchGet(id, Object.keys(LOG_HEADERS).map(function (t) { return t + '!1:1'; }));
    }).then(function (vrs) {
      var data = [];
      Object.keys(LOG_HEADERS).forEach(function (t, i) {
        var row = (vrs[i] && vrs[i].values && vrs[i].values[0]) || [];
        if (!row.length) data.push({ range: t + '!A1', values: [LOG_HEADERS[t]] });
      });
      return data.length ? self.client.update(id, data, 'RAW') : null;
    });
  });
};

/* ---------- lock (Locks tab of the Payout Log) ---------- */
Store.prototype.acquireLock = function (purpose) {
  var self = this, id = this.cfg.logId, lockId = randomId(), now = Date.now(), myRow = 0;
  return this.client.append(id, 'Locks!A1', [[lockId, this.user(), now, purpose, 'WAITING']]).then(function (res) {
    myRow = firstRowOf(res.updates && res.updates.updatedRange);
    return self.client.batchGet(id, ['Locks!A2:E']);
  }).then(function (vrs) {
    var rows = (vrs[0] && vrs[0].values) || [], first = null;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i], st = String(r[4] || ''), started = Number(r[2]) || 0;
      if ((st === 'WAITING' || st === 'HELD') && Date.now() - started < LOCK_TTL_MS) { first = { id: String(r[0]), who: String(r[1] || ''), what: String(r[3] || '') }; break; }
    }
    if (!first || first.id !== lockId) {
      return self.client.update(id, [{ range: 'Locks!E' + myRow, values: [['SKIPPED']] }]).then(function () {
        var e = new Error((first ? first.who : 'A teammate') + ' is writing to the sheet right now' +
          (first && first.what ? ' (' + first.what + ')' : '') + '. Nothing was written. Try again in a minute.');
        e.code = 'LOCKED';
        throw e;
      });
    }
    return self.client.update(id, [{ range: 'Locks!E' + myRow, values: [['HELD']] }]).then(function () { return { row: myRow, id: lockId }; });
  });
};
Store.prototype.releaseLock = function (lock) {
  if (!lock || !lock.row) return Promise.resolve();
  return this.client.update(this.cfg.logId, [{ range: 'Locks!E' + lock.row, values: [['DONE']] }]).catch(function () { /* expires by itself */ });
};
Store.prototype.withLock = function (purpose, fn) {
  var self = this;
  return this.acquireLock(purpose).then(function (lock) {
    return Promise.resolve().then(fn).then(function (v) {
      return self.releaseLock(lock).then(function () { return v; });
    }, function (err) {
      return self.releaseLock(lock).then(function () { throw err; });
    });
  });
};

/* ---------- Mark paid ---------- */
/**
 * req: {lines, expected (results the user saw), payKey, source, onStep}
 * Recomputes on a fresh read; if anything differs nothing is written (err.code = 'CHANGED').
 */
Store.prototype.settle = function (req) {
  var self = this, c = this.cfg, step = req.onStep || function () {};
  return this.withLock('Mark paid', function () {
    var raw, log, fresh, elig, batchId, label, tStart = 0, pStart = 0, allRows = [];
    return self.loadRaw(step).then(function (r) {
      raw = r;
      step('Reading the payout log');
      return self.loadLog();
    }).then(function (l) {
      log = l;
      var ctx = { todayKey: raw.todayKey, lastDataKey: raw.lastDataKey, paidAdj: E.paidAdj(log.payouts) };
      fresh = E.computeLines(req.lines, raw.recs, ctx);
      elig = fresh.filter(E.eligible);
      var seen = req.expected.filter(E.eligible);
      if (E.fingerprint(seen) !== E.fingerprint(elig)) {
        var e = new Error('The sheet changed while you were reviewing (new rows, or a teammate marked something paid). ' +
          'Nothing was written. The numbers are updated: review them and mark paid again.');
        e.code = 'CHANGED'; e.fresh = fresh; e.raw = raw; e.log = log;
        throw e;
      }
      if (!elig.length) throw new Error('Nothing is ready to pay.');
      batchId = E.nextBatchId(log.payouts.map(function (p) { return p.batch; }), req.payKey);
      label = E.payLabel(req.payKey);
      var byRow = {};
      raw.recs.forEach(function (x) { byRow[x.row] = x; });
      var trxRows = [], spans = [];
      elig.forEach(function (res, i) {
        var s = trxRows.length;
        res.rowsToStamp.forEach(function (row) {
          var x = byRow[row];
          allRows.push(row);
          trxRows.push([batchId, i + 1, res.line.tid, x ? x.trx : '', row, x && x.dateKey ? E.keyLabel(x.dateKey) : '',
            x ? x.amtC / 100 : 0, label, 'PAID']);
        });
        spans.push([s, trxRows.length - 1]);
      });
      step('Writing the payout log');
      return self.client.append(c.logId, 'Transactions!A1', trxRows).then(function (res) {
        tStart = firstRowOf(res.updates && res.updates.updatedRange);
        var who = self.user(), at = nowLabel();
        var payRows = elig.map(function (res2, i) {
          var L = res2.line;
          return [batchId, E.keyLabel(req.payKey), i + 1, L.brand || '', L.tid, res2.mid, E.keyLabel(L.from),
            E.keyLabel(L.to), res2.cnt, res2.amtC / 100, (L.adjInvalid ? 0 : L.adjC) / 100, L.adjReason || '',
            res2.finalC / 100, L.account || '', L.holder || '', L.bankName || '', L.bankCode || '', req.source || '',
            who, at, 'STAMPING', (tStart + spans[i][0]) + ':' + (tStart + spans[i][1]), '', '', ''];
        });
        return self.client.append(c.logId, 'Payouts!A1', payRows).then(function (res3) {
          pStart = firstRowOf(res3.updates && res3.updates.updatedRange);
          return payRows.length;
        });
      });
    }).then(function (nLines) {
      step('Marking ' + allRows.length + ' transactions as paid in RAW data');
      var col = E.colLetter(raw.hm.settleted), tab = quoteTab(c.rawTab || 'RAW data');
      var data = E.rowRuns(allRows).map(function (run) {
        var vals = [];
        for (var i = run.start; i <= run.end; i++) vals.push([label]);
        return { range: tab + '!' + col + run.start + ':' + col + run.end, values: vals };
      });
      return self.client.update(c.sheetId, data, 'RAW').then(function () {
        step('Reading it back');
        return self.client.batchGet(c.sheetId, data.map(function (d) { return d.range; }), { major: 'COLUMNS' });
      }).then(function (vrs) {
        var bad = 0;
        vrs.forEach(function (vr, i) {
          var got = (vr.values && vr.values[0]) || [], want = data[i].values.length;
          for (var j = 0; j < want; j++) if (String(got[j] === undefined ? '' : got[j]).trim() !== label) bad++;
        });
        return self.client.update(c.logId, [{ range: 'Payouts!U' + pStart + ':U' + (pStart + nLines - 1),
          values: elig.map(function () { return [bad ? 'CHECK' : 'PAID']; }) }]).then(function () { return bad; });
      });
    }).then(function (bad) {
      var total = 0, trx = 0;
      elig.forEach(function (r) { total += r.finalC; trx += r.cnt; });
      return { batchId: batchId, label: label, payKey: req.payKey, results: fresh, paid: elig, total: total, trx: trx,
        stamped: allRows.length, notConfirmed: bad, logRow: pStart, raw: raw };
    });
  });
};

/* ---------- Undo a payout (transfer came back) ---------- */
Store.prototype.reverse = function (batchId, tids, reason, onStep) {
  var self = this, c = this.cfg, step = onStep || function () {};
  return this.withLock('Undo payout', function () {
    var lines, items = [], hm, tab = quoteTab(c.rawTab || 'RAW data');
    step('Reading the payout log');
    return self.loadLog().then(function (log) {
      lines = log.payouts.filter(function (p) {
        return p.batch === batchId && (p.status === 'PAID' || p.status === 'STAMPING' || p.status === 'CHECK') &&
          (!tids || tids.indexOf(p.tid) >= 0);
      });
      if (!lines.length) throw new Error('Nothing to undo in ' + batchId + '.');
      return self.client.batchGet(c.logId, lines.map(function (p) { return 'Transactions!A' + p.trxFrom + ':I' + p.trxTo; }));
    }).then(function (vrs) {
      vrs.forEach(function (vr, i) {
        ((vr && vr.values) || []).forEach(function (v, j) {
          if (String(v[TX.BATCH]) !== batchId || String(v[TX.STATUS]) === 'REVERSED') return;
          items.push({ logRow: lines[i].trxFrom + j, trx: String(v[TX.TRX]), row: Number(v[TX.ROW]), tid: E.normTid(v[TX.TID]),
            label: String(v[TX.LABEL]).trim() });
        });
      });
      return self.client.batchGet(c.sheetId, [tab + '!1:1']);
    }).then(function (vr) {
      hm = E.headerMap((vr[0] && vr[0].values && vr[0].values[0]) || []);
      if (hm.missing.length) throw new Error('RAW data is missing these columns: ' + hm.missing.join(', '));
      step('Checking ' + items.length + ' transactions in RAW data');
      var runs = E.rowRuns(items.map(function (x) { return x.row; }));
      var ranges = [];
      runs.forEach(function (run) {
        ['trx id', 'tid', 'settleted'].forEach(function (f) {
          var L = E.colLetter(hm[f]);
          ranges.push(tab + '!' + L + run.start + ':' + L + run.end);
        });
      });
      return self.client.batchGet(c.sheetId, ranges, { major: 'COLUMNS' }).then(function (vrs) {
        var at = {};
        runs.forEach(function (run, i) {
          var t = (vrs[i * 3].values || [[]])[0] || [], d = (vrs[i * 3 + 1].values || [[]])[0] || [], a = (vrs[i * 3 + 2].values || [[]])[0] || [];
          for (var r = run.start; r <= run.end; r++) {
            var k = r - run.start;
            at[r] = { trx: String(t[k] === undefined ? '' : t[k]).trim(), tid: E.normTid(d[k]), aa: String(a[k] === undefined ? '' : a[k]).trim() };
          }
        });
        return at;
      });
    }).then(function (at) {
      var ok = [], skipped = [];
      items.forEach(function (x) {
        var cur = at[x.row];
        if (!cur || cur.trx !== x.trx || cur.tid !== x.tid) skipped.push({ item: x, why: 'Row ' + x.row + ' no longer holds ' + x.trx + ' (rows moved?)' });
        else if (cur.aa !== x.label) skipped.push({ item: x, why: 'Row ' + x.row + ' Settleted is "' + cur.aa + '", not "' + x.label + '"' });
        else ok.push(x);
      });
      step('Setting ' + ok.length + ' transactions back to unpaid');
      var col = E.colLetter(hm.settleted);
      var data = E.rowRuns(ok.map(function (x) { return x.row; })).map(function (run) {
        var vals = [];
        for (var i = run.start; i <= run.end; i++) vals.push(['0']);
        return { range: tab + '!' + col + run.start + ':' + col + run.end, values: vals };
      });
      var p1 = data.length ? self.client.update(c.sheetId, data, 'RAW') : Promise.resolve();
      return p1.then(function () {
        var who = self.user(), when = nowLabel(), logData = [];
        E.rowRuns(ok.map(function (x) { return x.logRow; })).forEach(function (run) {
          var vals = [];
          for (var i = run.start; i <= run.end; i++) vals.push(['REVERSED']);
          logData.push({ range: 'Transactions!I' + run.start + ':I' + run.end, values: vals });
        });
        lines.forEach(function (p) {
          var n = ok.filter(function (x) { return x.logRow >= p.trxFrom && x.logRow <= p.trxTo; }).length;
          logData.push({ range: 'Payouts!U' + p.row, values: [['REVERSED']] });
          logData.push({ range: 'Payouts!W' + p.row + ':Y' + p.row, values: [[who, when, reason + ' (' + n + ' trx back to unpaid)']] });
        });
        return self.client.update(c.logId, logData, 'RAW');
      }).then(function () {
        return { lines: lines.length, trx: ok.length, skipped: skipped };
      });
    });
  });
};

/* ---------- Import a Kashier export into RAW data ---------- */
function cellData(v) {
  if (v === '' || v === null || v === undefined) return {};
  if (typeof v === 'number') return { userEnteredValue: { numberValue: v } };
  if (typeof v === 'boolean') return { userEnteredValue: { boolValue: v } };
  var s = String(v);
  if (s.charAt(0) === "'") s = s.slice(1);
  return { userEnteredValue: { stringValue: s } };
}
function grid(gid, r1, r2, c0) { return { sheetId: gid, startRowIndex: r1 - 1, endRowIndex: r2, startColumnIndex: c0, endColumnIndex: c0 + 1 }; }

Store.prototype.importRows = function (plan, onStep) {
  var self = this, c = this.cfg, step = onStep || function () {}, tab = c.rawTab || 'RAW data';
  return this.withLock('Import', function () {
    var raw, rows, start, end, lastCol;
    return self.loadRaw(step).then(function (r) {
      raw = r;
      var have = {};
      raw.recs.forEach(function (x) { if (x.trx) have[x.trx] = 1; });
      rows = plan.rows.filter(function (x) { return !have[x.trx]; });
      if (!rows.length) return null;
      start = raw.lastRow + 1; end = start + rows.length - 1;
      lastCol = E.colLetter(raw.header.length);
      var grow = end > raw.rowCount ? self.client.batchUpdate(c.sheetId, [{ appendDimension: { sheetId: raw.gid, dimension: 'ROWS', length: end - raw.rowCount + 100 } }]) : Promise.resolve();
      return grow.then(function () {
        return self.client.batchGet(c.sheetId, [quoteTab(tab) + '!A' + start + ':' + lastCol + end,
          quoteTab(tab) + '!A' + raw.lastRow + ':' + lastCol + raw.lastRow], {}).then(function (vrs) {
          var target = (vrs[0] && vrs[0].values) || [];
          if (target.some(function (row) { return row.some(function (v) { return v !== '' && v !== null; }); })) {
            throw new Error('Rows ' + start + ' to ' + end + ' of RAW data are not empty. Someone may be pasting right now. Nothing was added.');
          }
          var from = Math.max(2, raw.lastRow - 19);
          return self.client.batchGet(c.sheetId, [quoteTab(tab) + '!A' + from + ':' + lastCol + raw.lastRow], { render: 'FORMULA' })
            .then(function (fv) { return { from: from, rows: (fv[0] && fv[0].values) || [] }; });
        });
      }).then(function (fr) {
        // formula columns: the newest of the last 20 rows that has a formula in that column
        var srcRow = {};
        fr.rows.forEach(function (row, i) {
          row.forEach(function (v, col) { if (typeof v === 'string' && v.charAt(0) === '=') srcRow[col] = fr.from + i; });
        });
        var requests = [{ updateCells: {
          start: { sheetId: raw.gid, rowIndex: start - 1, columnIndex: 0 },
          rows: rows.map(function (x) { return { values: x.values.slice(0, raw.header.length).map(cellData) }; }),
          fields: 'userEnteredValue'
        } }];
        var fmt = function (col, nf) {
          if (col < 0) return;
          requests.push({ repeatCell: { range: { sheetId: raw.gid, startRowIndex: start - 1, endRowIndex: end, startColumnIndex: col, endColumnIndex: col + 1 },
            cell: { userEnteredFormat: { numberFormat: nf } }, fields: 'userEnteredFormat.numberFormat' } });
        };
        fmt(plan.kDate, { type: 'DATE', pattern: 'dd/mm/yyyy' });
        fmt(plan.kTime, { type: 'TIME', pattern: 'h:mm:ss' });
        fmt(plan.kAA, { type: 'TEXT' });
        var copied = [];
        Object.keys(srcRow).forEach(function (k) {
          var col = +k;
          if (plan.mappedCols[col] !== undefined || col === plan.kAA) return;
          copied.push(col);
          requests.push({ copyPaste: { source: grid(raw.gid, srcRow[col], srcRow[col], col), destination: grid(raw.gid, start, end, col), pasteType: 'PASTE_FORMULA' } });
        });
        step('Adding ' + rows.length + ' transactions to RAW data');
        return self.client.batchUpdate(c.sheetId, requests).then(function () { return copied; });
      });
    }).then(function (copied) {
      if (copied === null) return { added: 0, skipped: plan.rows.length };
      return { added: rows.length, start: start, end: end, skipped: plan.rows.length - rows.length, formulaCols: copied };
    });
  });
};

/* ---------- Write corrected dates (Data check) ---------- */
/** items: [{row, trx, stored (key now in the sheet), fixed (real date key)}]. Each row is checked first. */
Store.prototype.fixDates = function (items, onStep) {
  var self = this, c = this.cfg, step = onStep || function () {}, tab = quoteTab(c.rawTab || 'RAW data');
  return this.withLock('Fix dates', function () {
    var hm, gid;
    return self.client.meta(c.sheetId).then(function (m) {
      var sh = (m.sheets || []).filter(function (s2) { return s2.properties.title === (c.rawTab || 'RAW data'); })[0];
      gid = sh.properties.sheetId;
      return self.client.batchGet(c.sheetId, [tab + '!1:1']);
    }).then(function (vr) {
      hm = E.headerMap((vr[0] && vr[0].values && vr[0].values[0]) || []);
      step('Checking ' + items.length + ' rows');
      var runs = E.rowRuns(items.map(function (x) { return x.row; })), ranges = [];
      runs.forEach(function (run) {
        ['trx id', 'date'].forEach(function (f) { var L = E.colLetter(hm[f]); ranges.push(tab + '!' + L + run.start + ':' + L + run.end); });
      });
      return self.client.batchGet(c.sheetId, ranges, { major: 'COLUMNS' }).then(function (vrs) {
        var at = {};
        runs.forEach(function (run, i) {
          var t = ((vrs[i * 2].values || [[]])[0]) || [], d = ((vrs[i * 2 + 1].values || [[]])[0]) || [];
          for (var r = run.start; r <= run.end; r++) at[r] = { trx: String(t[r - run.start] === undefined ? '' : t[r - run.start]).trim(), date: d[r - run.start] };
        });
        return at;
      });
    }).then(function (at) {
      var ok = items.filter(function (x) {
        var cur = at[x.row];
        return cur && cur.trx === x.trx && typeof cur.date === 'number' && E.serialToKey(cur.date) === x.stored;
      });
      var col = hm.date - 1, requests = ok.map(function (x) {
        return { updateCells: { start: { sheetId: gid, rowIndex: x.row - 1, columnIndex: col },
          rows: [{ values: [{ userEnteredValue: { numberValue: E.keyToSerial(x.fixed) }, userEnteredFormat: { numberFormat: { type: 'DATE', pattern: 'dd/mm/yyyy' } } }] }],
          fields: 'userEnteredValue,userEnteredFormat.numberFormat' } };
      });
      step('Writing ' + ok.length + ' dates');
      return (requests.length ? self.client.batchUpdate(c.sheetId, requests) : Promise.resolve()).then(function () {
        return { fixed: ok.length, skipped: items.length - ok.length };
      });
    });
  });
};

/* ---------- Banks tab ---------- */
Store.prototype.addBank = function (name, code) {
  return this.client.append(this.cfg.logId, 'Banks!A1', [[String(name).trim(), String(code).trim().toUpperCase()]]);
};

/* ---------- Transactions of a payout (for breakdowns) ---------- */
Store.prototype.payoutTransactions = function (lines) {
  var withRange = lines.filter(function (p) { return p.trxFrom && p.trxTo; });
  if (!withRange.length) return Promise.resolve([]);
  return this.client.batchGet(this.cfg.logId, withRange.map(function (p) { return 'Transactions!A' + p.trxFrom + ':I' + p.trxTo; }))
    .then(function (vrs) {
      var out = [];
      vrs.forEach(function (vr) {
        ((vr && vr.values) || []).forEach(function (v) {
          out.push({ batch: String(v[TX.BATCH]), line: Number(v[TX.LINE]), tid: E.normTid(v[TX.TID]), trx: String(v[TX.TRX]),
            row: Number(v[TX.ROW]), dateKey: serialKey(v[TX.DATE]), amtC: Math.round(cellNum(v[TX.AMT]) * 100),
            label: String(v[TX.LABEL]), status: String(v[TX.STATUS]) });
        });
      });
      return out;
    });
};

var api = { GoogleAuth: GoogleAuth, DemoAuth: DemoAuth, SheetsClient: SheetsClient, Store: Store, LOG_HEADERS: LOG_HEADERS,
  quoteTab: quoteTab, firstRowOf: firstRowOf, nowLabel: nowLabel };
if (typeof module === 'object' && module.exports) module.exports = api;
else root.ESSheets = api;
})(typeof self !== 'undefined' ? self : this);
