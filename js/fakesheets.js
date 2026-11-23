/*!
 * Event Settlement - in-memory stand-in for the Google Sheets REST API.
 * Used by the demo mode (?demo=1) and by the tests. Implements only what the tool calls.
 */
(function (root) {
'use strict';

function colNum(s) { var n = 0; for (var i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64); return n; }
function colLetter(c) { var s = ''; while (c > 0) { var m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); } return s; }
function quote(t) { return /^[A-Za-z0-9_]+$/.test(t) ? t : "'" + t.replace(/'/g, "''") + "'"; }

function FakeSheets(opts) {
  opts = opts || {};
  this.books = {};
  this.calls = [];
  this.latency = opts.latency || 0;
  this.failNext = [];        // [{match: RegExp on "METHOD url", status, once}]
  this.user = opts.user || 'you@example.com';
  this.fetch = this.fetch.bind(this);
}

/** book: {title, sheets: [{title, gid, rowCount, colCount, rows: [[...]], formulas: {"r,c": "=..."}}]} */
FakeSheets.prototype.addBook = function (id, book) {
  var b = { title: book.title || id, sheets: [] };
  (book.sheets || []).forEach(function (s, i) {
    var sh = { title: s.title, gid: s.gid !== undefined ? s.gid : i, rowCount: s.rowCount || Math.max(1000, (s.rows || []).length + 50),
      colCount: s.colCount || 26, cells: [], formats: {} };
    (s.rows || []).forEach(function (row, r) {
      sh.cells[r] = row.map(function (v) { return v === '' || v === null || v === undefined ? undefined : { v: v }; });
    });
    Object.keys(s.formulas || {}).forEach(function (k) {
      var p = k.split(','), r = +p[0], c = +p[1];
      sh.cells[r] = sh.cells[r] || [];
      sh.cells[r][c] = { v: '', f: s.formulas[k] };
    });
    b.sheets.push(sh);
  });
  this.books[id] = b;
  return b;
};

FakeSheets.prototype.sheetByTitle = function (book, title) {
  for (var i = 0; i < book.sheets.length; i++) if (book.sheets[i].title === title) return book.sheets[i];
  return null;
};
FakeSheets.prototype.sheetByGid = function (book, gid) {
  for (var i = 0; i < book.sheets.length; i++) if (book.sheets[i].gid === gid) return book.sheets[i];
  return null;
};

/** "'RAW data'!AA2:AA100", "Payouts!A1", "Locks!A:E", "'RAW data'!1:1" -> {sheet, r0, r1, c0, c1} (0-based, inclusive) */
FakeSheets.prototype.parseA1 = function (book, a1) {
  var i = a1.lastIndexOf('!'), name = a1.slice(0, i), ref = a1.slice(i + 1);
  if (name.charAt(0) === "'") name = name.slice(1, -1).replace(/''/g, "'");
  var sh = this.sheetByTitle(book, name);
  if (!sh) throw this.err(400, 'Unable to parse range: ' + a1);
  var parts = ref.split(':');
  var one = function (p) {
    var m = /^([A-Z]*)(\d*)$/.exec(p);
    if (!m) throw new Error('bad ref ' + p);
    return { c: m[1] ? colNum(m[1]) - 1 : null, r: m[2] ? +m[2] - 1 : null };
  };
  var a = one(parts[0]), b = parts[1] ? one(parts[1]) : a;
  return {
    sheet: sh,
    r0: a.r === null ? 0 : a.r, r1: b.r === null ? sh.rowCount - 1 : b.r,
    c0: a.c === null ? 0 : a.c, c1: b.c === null ? sh.colCount - 1 : b.c,
    single: !parts[1] && a.r !== null && a.c !== null
  };
};

FakeSheets.prototype.err = function (status, message) { var e = new Error(message); e.status = status; return e; };

FakeSheets.prototype.read = function (rng, render) {
  var sh = rng.sheet, out = [];
  var r1 = Math.min(rng.r1, sh.rowCount - 1), c1 = Math.min(rng.c1, sh.colCount - 1);
  for (var r = rng.r0; r <= r1; r++) {
    var row = [];
    for (var c = rng.c0; c <= c1; c++) {
      var cell = sh.cells[r] && sh.cells[r][c];
      var v = '';
      if (cell) {
        if (render === 'FORMULA' && cell.f) v = cell.f;
        else if (cell.f) v = this.evalFormula(sh, cell.f, r);
        else v = render === 'FORMATTED_VALUE' ? String(cell.v) : cell.v;
      }
      row.push(v);
    }
    out.push(row);
  }
  return out;
};

/** Only the formula the RAW data sheet uses: =IF(AA2="0","NOTSETTLED","SETTLED") */
FakeSheets.prototype.evalFormula = function (sh, f, r) {
  var m = /^=IF\(([A-Z]+)(\d+)="0","([A-Z]+)","([A-Z]+)"\)$/.exec(f);
  if (!m) return '';
  var cell = sh.cells[+m[2] - 1] && sh.cells[+m[2] - 1][colNum(m[1]) - 1];
  var v = cell ? cell.v : '';
  return String(v) === '0' ? m[3] : m[4];
};

function trimRows(rows) {
  var out = rows.map(function (row) {
    var n = row.length; while (n > 0 && row[n - 1] === '') n--; return row.slice(0, n);
  });
  var m = out.length; while (m > 0 && out[m - 1].length === 0) m--;
  return out.slice(0, m);
}
function transpose(rows) {
  var w = 0; rows.forEach(function (r) { if (r.length > w) w = r.length; });
  var cols = [];
  for (var c = 0; c < w; c++) cols.push(rows.map(function (r) { return r[c] === undefined ? '' : r[c]; }));
  return cols;
}

FakeSheets.prototype.write = function (sh, r0, c0, values, input) {
  for (var i = 0; i < values.length; i++) {
    var r = r0 + i;
    if (r >= sh.rowCount) throw this.err(400, 'Range exceeds grid limits');
    sh.cells[r] = sh.cells[r] || [];
    for (var j = 0; j < values[i].length; j++) {
      var v = values[i][j];
      if (v === null || v === undefined) continue;
      var c = c0 + j;
      if (c >= sh.colCount) sh.colCount = c + 1;
      if (v === '') { sh.cells[r][c] = undefined; continue; }
      if (input === 'USER_ENTERED' && typeof v === 'string') {
        if (v.charAt(0) === '=') { sh.cells[r][c] = { v: '', f: v }; continue; }
        if (/^-?\d+(\.\d+)?$/.test(v)) { sh.cells[r][c] = { v: Number(v) }; continue; }
      }
      sh.cells[r][c] = { v: v };
    }
  }
};

FakeSheets.prototype.lastRowWithData = function (sh, c0, c1) {
  for (var r = Math.min(sh.cells.length, sh.rowCount) - 1; r >= 0; r--) {
    var row = sh.cells[r];
    if (!row) continue;
    for (var c = c0; c <= c1; c++) if (row[c] && (row[c].v !== '' || row[c].f)) return r;
  }
  return -1;
};

function resp(status, obj) {
  var body = JSON.stringify(obj);
  return { ok: status >= 200 && status < 300, status: status, json: function () { return Promise.resolve(JSON.parse(body)); }, text: function () { return Promise.resolve(body); } };
}

FakeSheets.prototype.fetch = function (url, opts) {
  var self = this;
  opts = opts || {};
  var method = (opts.method || 'GET').toUpperCase();
  var key = method + ' ' + url;
  this.calls.push({ method: method, url: url, body: opts.body ? JSON.parse(opts.body) : null });
  return new Promise(function (resolve) { setTimeout(resolve, self.latency); }).then(function () {
    for (var i = 0; i < self.failNext.length; i++) {
      var f = self.failNext[i];
      if (f.match.test(key)) {
        self.failNext.splice(i, 1);
        if (f.network) return Promise.reject(new TypeError('Failed to fetch'));
        return resp(f.status, { error: { code: f.status, message: f.message || 'Simulated error' } });
      }
    }
    try { return resp(200, self.route(method, url, opts.body ? JSON.parse(opts.body) : null)); }
    catch (e) { return resp(e.status || 500, { error: { code: e.status || 500, message: e.message } }); }
  });
};

FakeSheets.prototype.route = function (method, url, body) {
  var self = this;
  if (/oauth2\/v3\/userinfo/.test(url)) return { email: this.user, name: 'Demo user' };
  var u = new URL(url), path = decodeURIComponent(u.pathname.replace(/^\/v4\/spreadsheets\//, '')), q = u.searchParams;
  var m = /^([^/:]+)(.*)$/.exec(path), id = m[1], rest = m[2];
  var book = this.books[id];
  if (!book) throw this.err(404, 'Requested entity was not found.');
  if (method === 'GET' && rest === '') {
    return { spreadsheetId: id, properties: { title: book.title }, sheets: book.sheets.map(function (s) {
      return { properties: { sheetId: s.gid, title: s.title, gridProperties: { rowCount: s.rowCount, columnCount: s.colCount } } };
    }) };
  }
  if (method === 'GET' && rest === '/values:batchGet') {
    var major = q.get('majorDimension') || 'ROWS', render = q.get('valueRenderOption') || 'FORMATTED_VALUE';
    return { spreadsheetId: id, valueRanges: q.getAll('ranges').map(function (a1) {
      var rng = self.parseA1(book, a1), rows = self.read(rng, render);
      var vals = major === 'COLUMNS' ? trimRows(transpose(rows)) : trimRows(rows);
      var out = { range: quote(rng.sheet.title) + '!' + colLetter(rng.c0 + 1) + (rng.r0 + 1) + ':' + colLetter(Math.min(rng.c1, rng.sheet.colCount - 1) + 1) + (Math.min(rng.r1, rng.sheet.rowCount - 1) + 1), majorDimension: major };
      if (vals.length) out.values = vals;
      return out;
    }) };
  }
  if (method === 'POST' && rest === '/values:batchUpdate') {
    (body.data || []).forEach(function (d) {
      var rng = self.parseA1(book, d.range);
      var vals = (d.majorDimension === 'COLUMNS') ? transpose(d.values) : d.values;
      self.write(rng.sheet, rng.r0, rng.c0, vals, body.valueInputOption);
    });
    return { spreadsheetId: id, totalUpdatedCells: 0 };
  }
  var ap = /^\/values\/(.+):append$/.exec(rest);
  if (method === 'POST' && ap) {
    var rng = this.parseA1(book, ap[1]), sh = rng.sheet, vals = body.values || [];
    var width = 0; vals.forEach(function (r) { if (r.length > width) width = r.length; });
    var last = this.lastRowWithData(sh, rng.c0, Math.max(rng.c0, rng.c0 + width - 1));
    var r0 = last + 1;
    if (r0 + vals.length > sh.rowCount) sh.rowCount = r0 + vals.length;
    this.write(sh, r0, rng.c0, vals, q.get('valueInputOption'));
    return { spreadsheetId: id, updates: { updatedRange: quote(sh.title) + '!' + colLetter(rng.c0 + 1) + (r0 + 1) + ':' + colLetter(rng.c0 + width) + (r0 + vals.length), updatedRows: vals.length } };
  }
  if (method === 'POST' && rest === ':batchUpdate') {
    var replies = [];
    (body.requests || []).forEach(function (req) {
      if (req.updateCells) {
        var uc = req.updateCells, s1 = self.sheetByGid(book, uc.start.sheetId);
        uc.rows.forEach(function (row, i) {
          var r = uc.start.rowIndex + i;
          if (r >= s1.rowCount) throw self.err(400, 'Range exceeds grid limits');
          s1.cells[r] = s1.cells[r] || [];
          (row.values || []).forEach(function (cd, j) {
            var c = uc.start.columnIndex + j, uv = cd.userEnteredValue;
            if (!uv) { s1.cells[r][c] = undefined; return; }
            if ('formulaValue' in uv) s1.cells[r][c] = { v: '', f: uv.formulaValue };
            else if ('numberValue' in uv) s1.cells[r][c] = { v: uv.numberValue };
            else if ('boolValue' in uv) s1.cells[r][c] = { v: uv.boolValue };
            else s1.cells[r][c] = { v: uv.stringValue };
          });
        });
      } else if (req.repeatCell) {
        var rc = req.repeatCell, s2 = self.sheetByGid(book, rc.range.sheetId);
        s2.formats[rc.range.startColumnIndex + ':' + rc.range.startRowIndex + '-' + rc.range.endRowIndex] = rc.cell.userEnteredFormat;
      } else if (req.appendDimension) {
        var s3 = self.sheetByGid(book, req.appendDimension.sheetId);
        if (req.appendDimension.dimension === 'ROWS') s3.rowCount += req.appendDimension.length;
        else s3.colCount += req.appendDimension.length;
      } else if (req.copyPaste) {
        var cp = req.copyPaste, s4 = self.sheetByGid(book, cp.source.sheetId);
        var src = s4.cells[cp.source.startRowIndex] && s4.cells[cp.source.startRowIndex][cp.source.startColumnIndex];
        for (var r = cp.destination.startRowIndex; r < cp.destination.endRowIndex; r++) {
          var delta = r - cp.source.startRowIndex;
          s4.cells[r] = s4.cells[r] || [];
          s4.cells[r][cp.destination.startColumnIndex] = src && src.f
            ? { v: '', f: src.f.replace(/(\$?)([A-Z]{1,3})(\$?)(\d+)/g, function (all, d1, col, d2, row) { return d1 + col + d2 + (d2 ? row : +row + delta); }) }
            : undefined;
        }
      } else if (req.addSheet) {
        var gid = 1000 + book.sheets.length;
        book.sheets.push({ title: req.addSheet.properties.title, gid: gid, rowCount: 1000, colCount: 26, cells: [], formats: {} });
        replies.push({ addSheet: { properties: { sheetId: gid, title: req.addSheet.properties.title } } });
        return;
      } else {
        throw self.err(400, 'Unsupported request in fake: ' + Object.keys(req)[0]);
      }
      replies.push({});
    });
    return { spreadsheetId: id, replies: replies };
  }
  throw this.err(400, 'Unsupported call in fake: ' + method + ' ' + rest);
};

/* ------------------------------------------------------------------ */
/*  Demo data: two MIDs, ~24 vendors, six weeks of transactions           */
/* ------------------------------------------------------------------ */
var RAW_HEADER = ['MID', 'StoreName', 'merchantType', 'Credentials bank', 'Credentials Merchant Name', 'MCC', 'Status', 'TRX ID',
  'Type', 'Date', 'Time', 'currency', 'amount', 'Captured Method', 'Card Type', 'Card Num', 'Auth ID', 'Transaction amount',
  'Original Amount', 'Rate %', 'Rate EGP', 'Processing', 'VAT', 'BIR', 'Settlement Amount', 'Settlement Date', 'Settleted',
  'Settlement Status', 'Vlook up', 'Email Address', 'Channel', 'terminalId', 'TID'];

var DEMO_VENDORS = [
  ['Sunbird Studio', 'NBE'], ['Cairo Crafts', 'CIB'], ['Olive and Thyme', 'مصرف ابو ظبي الاسلامي'], ['Nile Threads', 'NBE'],
  ['Amber Lane', 'فيصل الاسلامي'], ['Palm Leaf Optics', 'ADIB'], ['Lotus Jewels', 'HSBC'], ['Desert Rose Boutique', 'NBE'],
  ['Pixel Toys', 'CIB'], ['Urban Kicks', 'bank masr'], ['Bloom Bakery', 'Banque Misr'], ['Atelier Sara', 'NBK'],
  ['Green Leaf', 'CIB'], ['Blue Dune', 'Al Baraka Bank'], ['Copper Pot', 'vodafone cash'], ['Jasmine Corner', 'NBE'],
  ['Delta Shoes', 'البنك العربي الافريقي الدولي'], ['Saffron House', 'QNB'], ['Marina Bags', 'CIB'], ['Fayrouz Gifts', 'NBE'],
  ['Golden Wheat', 'CIB'], ['Orchid Beauty', 'NBE'], ['Star Optics', 'HSBC'], ['Cedar Home', 'CIB']
];

function lcg(seed) { var s = seed >>> 0; return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

function demoBooks(E, todayKey, opts) {
  opts = opts || {};
  var rnd = lcg(opts.seed || 7);
  var today = E.keyToSerial(todayKey);
  var mids = [{ mid: 'MID-90001-101', pre: '90001101', seq: 52000 }, { mid: 'MID-90002-202', pre: '90002202', seq: 31000 }];
  var tids = DEMO_VENDORS.map(function (v, i) {
    var m = mids[i % 5 === 4 ? 1 : 0], acc = '';
    for (var k = 0; k < 12 + (i % 3) * 2; k++) acc += String(Math.floor(rnd() * 10));
    return { tid: m.pre + String(100 + i * 3 + (i % 2 ? 1 : 0)), mid: m, name: v[0], bank: v[1], acc: '9' + acc };
  });
  var rows = [], formulas = {};
  var payLabelFor = function (serial) {
    // payouts happen on Sundays and Wednesdays for days up to 2 days before
    for (var s = serial + 2; s < today; s++) {
      var wd = new Date(E.EPOCH + s * 86400000).getUTCDay();
      if (wd === 0 || wd === 3) return E.payLabel(E.serialToKey(s));
    }
    return null;
  };
  var days = 42;
  for (var d = today - days; d < today; d++) {
    var key = E.serialToKey(d), p = E.keyParts(key);
    var label = payLabelFor(d);
    tids.forEach(function (t, ti) {
      if (rnd() < 0.35) return;
      var n = 1 + Math.floor(rnd() * 6);
      for (var k = 0; k < n; k++) {
        t.mid.seq++;
        var amt = Math.round((50 + rnd() * 1500) * 100) / 100;
        var vat = Math.round(amt * 0.0021 * 100) / 100, fee = Math.round(amt * 0.015 * 100) / 100;
        var settle = Math.round((amt - fee - vat) * 100) / 100;
        var paid = label && !(ti === 6 && d > today - 12) ? label : '0';
        // The paste problem: days 1-12 often arrive as swapped real dates, days 13-31 as text dd/mm/yyyy.
        var dateCell;
        if (p.d <= 12 && p.d !== p.m && rnd() < 0.85) dateCell = E.keyToSerial(E.key(p.y, p.d, p.m));
        else if (p.d <= 12) dateCell = d;
        else dateCell = E.keyDMY(key);
        var row = [t.mid.mid, 'Demo event', 'Fashion', 'demo', 1000000001, 5999, 'Approved', 'TX-' + t.mid.pre + t.mid.seq,
          'PAYMENT', dateCell, Math.round(rnd() * 86000) / 86400, 'EGP', amt, 'card', rnd() < 0.7 ? 'Visa' : 'MasterCard',
          (rnd() < 0.7 ? '4' : '5') + String(1000000 + Math.floor(rnd() * 8999999)) + '****' + String(1000 + Math.floor(rnd() * 8999)),
          100000 + Math.floor(rnd() * 899999), amt, amt, 1.5, '', '', vat, '', settle, '', paid, '', '', '', 'POS',
          70000000 + ti, Number(t.tid)];
        formulas[(rows.length + 1) + ',27'] = '=IF(AA' + (rows.length + 2) + '="0","NOTSETTLED","SETTLED")';
        rows.push(row);
      }
    });
  }
  // a refund and a duplicated row (same TX pasted twice)
  var r0 = rows[rows.length - 5].slice();
  r0[7] = 'TX-' + mids[0].pre + (++mids[0].seq); r0[8] = 'REFUND'; r0[12] = 250; r0[24] = -250; r0[26] = '0';
  formulas[(rows.length + 1) + ',27'] = '=IF(AA' + (rows.length + 2) + '="0","NOTSETTLED","SETTLED")';
  rows.push(r0);
  var dup = rows[rows.length - 9].slice();
  formulas[(rows.length + 1) + ',27'] = '=IF(AA' + (rows.length + 2) + '="0","NOTSETTLED","SETTLED")';
  rows.push(dup);
  var raw = { title: 'Event settlement (demo)', sheets: [
    { title: 'RAW data', gid: 0, rowCount: rows.length + 300, colCount: 33, rows: [RAW_HEADER].concat(rows), formulas: formulas }
  ] };
  var log = { title: 'Event Settlement - Payout Log (demo)', sheets: [
    { title: 'Payouts', gid: 0, colCount: 25, rows: [['Batch ID', 'Payout date', 'Line', 'Brand name', 'TID', 'MID', 'From', 'To', 'Trx count', 'Amount',
      'Adjustment', 'Adjustment reason', 'Final amount', 'Account number', 'Account holder', 'Bank name', 'Bank code',
      'Source', 'Paid by', 'Paid at', 'Status', 'Trx log rows', 'Reversed by', 'Reversed at', 'Reverse reason']] },
    { title: 'Transactions', gid: 1, colCount: 9, rows: [['Batch ID', 'Line', 'TID', 'TRX ID', 'RAW row', 'Trx date', 'Settlement Amount', 'Payout label', 'Status']] },
    { title: 'Banks', gid: 2, colCount: 2, rows: [['Bank name (as Sales writes it)', 'Bank code']] },
    { title: 'Locks', gid: 3, colCount: 5, rows: [['Lock ID', 'User', 'Started at (ms)', 'Purpose', 'State']] }
  ] };
  // Sales request for the last 4 complete days, like the real file
  var sales = [['Brand name', 'Kashier TID', 'account number', 'bank account holder name', 'Bank name', 'Days to settle', 'MID', 'Amount']];
  var k4 = [today - 4, today - 3, today - 2, today - 1].map(function (s) { return E.keyParts(E.serialToKey(s)); });
  var monthName = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][k4[3].m - 1];
  var daysText = k4[0].m === k4[3].m ? k4.map(function (x) { return x.d; }).join('-') + ' ' + monthName
    : E.keyDMY(E.serialToKey(today - 4)).slice(0, 5) + ' - ' + E.keyDMY(E.serialToKey(today - 1)).slice(0, 5);
  tids.slice(0, 14).forEach(function (t, i) {
    sales.push([t.name, Number(t.tid), t.acc, 'Owner of ' + t.name, t.bank, daysText, t.mid.mid, '']);
  });
  return { raw: raw, log: log, sales: sales, tids: tids };
}

var api = { FakeSheets: FakeSheets, demoBooks: demoBooks, RAW_HEADER: RAW_HEADER };
if (typeof module === 'object' && module.exports) module.exports = api;
else root.ESFake = api;
})(typeof self !== 'undefined' ? self : this);
