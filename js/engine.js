/*!
 * Event Settlement - engine
 * Pure settlement logic: no DOM, no network. Runs in the browser and in Node tests.
 * Kashier Financial Operations
 *
 * RULES
 *  - A transaction counts on its own calendar date (no midnight cut-off).
 *  - A row whose "Settleted" cell is anything other than "0" / empty is PAID and is never counted again.
 *  - The same TRX ID (TX-...) on more than one row is counted once.
 *  - Payout date written in "Settleted" as text "dd-Mon yyyy", e.g. "23-Nov 2026" (the team's format).
 */
(function (root) {
// == PURE START ==
var ES_EPOCH = Date.UTC(1899, 11, 30);
var ES_MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
var ES_MON_IDX = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
var ES_AR_MONTHS = [['يناير', 1], ['فبراير', 2], ['مارس', 3], ['ابريل', 4], ['مايو', 5], ['يونيو', 6],
  ['يوليو', 7], ['اغسطس', 8], ['سبتمبر', 9], ['اكتوبر', 10], ['نوفمبر', 11], ['ديسمبر', 12]];
// Seeded from the Event_01_Batch_23_Nov_2026 bank file. The Banks tab of the Payout Log adds more.
var ES_BANK_SEED = [
  ['NBE', 'NBE'], ['CIB', 'CIB'], ['Banque Misr', 'MISR'], ['bank masr', 'MISR'], ['MISR', 'MISR'],
  ['HSBC', 'HSBC'], ['vodafone cash', 'MIDG'], ['MIDG', 'MIDG'],
  ['البنك العربي الافريقي الدولي', 'AAIB'], ['البنك العربي الافريقي', 'AAIB'], ['AAIB', 'AAIB'],
  ['مصرف ابو ظبي الاسلامي', 'ADIB'], ['ADIB', 'ADIB'], ['Al Baraka Bank', 'ABRK'], ['ABRK', 'ABRK'],
  ['NBK', 'NBK'], ['فيصل الاسلامي', 'FAIB'], ['FAIB', 'FAIB']
];
var ES_BANK_HEADERS = ['InstructionID', 'EndtoEndId', 'NationalID', 'CreditorName', 'CreditorAccountNumber',
  'CreditorBank', 'CreditorBankBranch', 'TransactionAmount', 'TransactionPurpose', 'Comments', 'Email', 'bank masr'];

function esIsDate_(v) { return Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime()); }
function esKey_(y, m, d) { return y * 10000 + m * 100 + d; }
function esKeyParts_(k) { return { y: Math.floor(k / 10000), m: Math.floor(k / 100) % 100, d: k % 100 }; }
function esValidYMD_(y, m, d) {
  if (!(y >= 2000 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}
function esSerialToKey_(serial) {
  var dt = new Date(ES_EPOCH + Math.floor(serial) * 86400000);
  return esKey_(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}
function esKeyToSerial_(k) {
  var p = esKeyParts_(k);
  return Math.round((Date.UTC(p.y, p.m - 1, p.d) - ES_EPOCH) / 86400000);
}
function esAddDays_(k, n) { return esSerialToKey_(esKeyToSerial_(k) + n); }
function esKeyLabel_(k) {
  if (!k) return '';
  var p = esKeyParts_(k);
  return ('0' + p.d).slice(-2) + '-' + ES_MON[p.m - 1] + '-' + p.y;
}
/** Payout label written in the Settleted column, in the team's format: "23-Nov 2026". */
function esPayLabel_(k) {
  var p = esKeyParts_(k);
  return ('0' + p.d).slice(-2) + '-' + ES_MON[p.m - 1] + ' ' + p.y;
}
/** dd/mm/yyyy, the way the Kashier export shows dates. */
function esKeyDMY_(k) {
  if (!k) return '';
  var p = esKeyParts_(k);
  return ('0' + p.d).slice(-2) + '/' + ('0' + p.m).slice(-2) + '/' + p.y;
}
/** yyyy-mm-dd for <input type="date">. */
function esKeyISO_(k) {
  if (!k) return '';
  var p = esKeyParts_(k);
  return p.y + '-' + ('0' + p.m).slice(-2) + '-' + ('0' + p.d).slice(-2);
}
function esISOToKey_(s) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  return m && esValidYMD_(+m[1], +m[2], +m[3]) ? esKey_(+m[1], +m[2], +m[3]) : null;
}
function esFmtC_(c) {
  var neg = c < 0;
  c = Math.abs(Math.round(c));
  var s = String(Math.floor(c / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + s + '.' + ('0' + (c % 100)).slice(-2);
}
function esArDigits_(s) {
  return String(s)
    .replace(/[\u0660-\u0669]/g, function (c) { return String(c.charCodeAt(0) - 0x0660); })
    .replace(/[\u06F0-\u06F9]/g, function (c) { return String(c.charCodeAt(0) - 0x06F0); });
}
function esNormText_(s) {
  return esArDigits_(s === null || s === undefined ? '' : s)
    .replace(/[\u00A0\u2007\u202F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, ' ')
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}
function esNormTid_(v) {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'number') return isFinite(v) ? String(Math.round(v)) : '';
  return esArDigits_(v).replace(/\D/g, '');
}
function esNum_(v) {
  if (typeof v === 'number') return isFinite(v) ? v : NaN;
  var s = esArDigits_(v === null || v === undefined ? '' : v).replace(/[,\s\u00A0]/g, '');
  if (s === '') return 0;
  var n = Number(s);
  return isFinite(n) ? n : NaN;
}

/** Text date -> yyyymmdd key. order: 'DMY' (Kashier export) or 'MDY'. */
function esParseTextDate_(s, order) {
  s = esArDigits_(s === null || s === undefined ? '' : s).replace(/\u00A0/g, ' ').trim();
  if (!s) return null;
  var m = /^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4}|\d{2})(?:[\sT].*)?$/.exec(s);
  if (m) {
    var a = +m[1], b = +m[2], y = +m[3];
    if (y < 100) y += 2000;
    var d = order === 'MDY' ? b : a, mo = order === 'MDY' ? a : b;
    return esValidYMD_(y, mo, d) ? esKey_(y, mo, d) : null;
  }
  m = /^(\d{4})[\/.\-](\d{1,2})[\/.\-](\d{1,2})(?:[\sT].*)?$/.exec(s);
  if (m) return esValidYMD_(+m[1], +m[2], +m[3]) ? esKey_(+m[1], +m[2], +m[3]) : null;
  m = /^(\d{1,2})[\s\-.]*([A-Za-z]{3})[A-Za-z]*[\s\-.,]*(\d{4})/.exec(s);
  if (m) {
    var mo2 = ES_MON_IDX[m[2].toLowerCase()];
    return mo2 && esValidYMD_(+m[3], mo2, +m[1]) ? esKey_(+m[3], mo2, +m[1]) : null;
  }
  return null;
}

/** "h:mm:ss" (optionally AM/PM) -> day fraction, or null. */
function esParseTime_(v) {
  if (typeof v === 'number') return v >= 0 && v < 1 ? v : null;
  var m = /^\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?\s*$/i.exec(String(v));
  if (!m) return null;
  var h = +m[1], mi = +m[2], s = m[3] ? +m[3] : 0, ap = m[4] ? m[4].toLowerCase() : '';
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (h > 23 || mi > 59 || s > 59) return null;
  return (h * 3600 + mi * 60 + s) / 86400;
}
function esTimeLabel_(v) {
  var f = esParseTime_(v);
  if (f === null) return v === null || v === undefined ? '' : String(v);
  var t = Math.round(f * 86400), h = Math.floor(t / 3600), mi = Math.floor(t / 60) % 60, s = t % 60;
  return ('0' + h).slice(-2) + ':' + ('0' + mi).slice(-2) + ':' + ('0' + s).slice(-2);
}

/**
 * Sales "Days to settle" text -> {from, to} keys, or {error}.
 * Handles: "19-20-21-22 Novamber", "19-20 Nov", "from 13 till 21 november",
 * "19/11 - 22/11", "من 13 لحد 21 نوفمبر", "28 November till 2 December".
 * Non-consecutive day lists are rejected (one line per date range).
 */
function esParseDays_(text, todayKey) {
  var raw = String(text === null || text === undefined ? '' : text).trim();
  var s = esNormText_(raw);
  var fail = function (why) { return { error: why + ' in "' + raw + '": fill From and To' }; };
  if (!s) return { error: 'Days to settle is empty: fill From and To' };
  var m;

  // A) numeric day/month tokens: 19/11, 19/11/2026, 19.11
  var tok = [], re = /(\d{1,2})\s*[\/.]\s*(\d{1,2})(?:\s*[\/.]\s*(\d{4}|\d{2}))?/g;
  while ((m = re.exec(s)) !== null) {
    var yy = m[3] ? +m[3] : null;
    if (yy !== null && yy < 100) yy += 2000;
    tok.push({ d: +m[1], m: +m[2], y: yy, start: m.index, end: m.index + m[0].length });
  }
  if (tok.length) {
    var rest = s;
    for (var i = tok.length - 1; i >= 0; i--) rest = rest.slice(0, tok[i].start) + ' ' + rest.slice(tok[i].end);
    if (/\d/.test(rest)) return fail('Mixed day formats');
    return esDaysResult_(tok, tok.length === 2, raw, todayKey);
  }

  // B) month names (English, any spelling that starts right, or Arabic)
  var months = [], enRe = /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*/g;
  while ((m = enRe.exec(s)) !== null) {
    if (m.index > 0 && /[a-z]/.test(s.charAt(m.index - 1))) continue;
    months.push({ pos: m.index, end: m.index + m[0].length, m: ES_MON_IDX[m[1]] });
  }
  ES_AR_MONTHS.forEach(function (p) {
    var at = s.indexOf(p[0]);
    while (at >= 0) { months.push({ pos: at, end: at + p[0].length, m: p[1] }); at = s.indexOf(p[0], at + 1); }
  });
  if (!months.length) return fail('No month');
  months.sort(function (a, b) { return a.pos - b.pos; });

  var year = null, ym = /(^|\D)(20\d{2})(?!\d)/.exec(s);
  if (ym) year = +ym[2];
  var s2 = s.replace(/(^|\D)(20\d{2})(?!\d)/g, function (all, pre) { return pre + '    '; });
  var days = [], dRe = /\d+/g;
  while ((m = dRe.exec(s2)) !== null) {
    var dn = +m[0];
    if (m[0].length > 2 || dn < 1 || dn > 31) return fail('Unexpected number');
    days.push({ d: dn, start: m.index, end: m.index + m[0].length });
  }
  if (!days.length) return fail('No day numbers');
  // each day takes the closest month name ("19 Nov", "Nov 19"); on a tie, the one after it
  days.forEach(function (x) {
    var best = null, bestDist = Infinity;
    months.forEach(function (mo) {
      var dist = mo.pos >= x.end ? mo.pos - x.end : (mo.end <= x.start ? x.start - mo.end + 0.5 : 0);
      if (dist < bestDist) { bestDist = dist; best = mo; }
    });
    x.m = best.m;
    x.y = year;
  });
  var isRange = /(^|[^a-z])(from|till|til|until|to|thru|through)([^a-z]|$)|حتي|لحد|الي/.test(s);
  if (!isRange && days.length === 2 && /[-\u2013\u2014]/.test(s.slice(days[0].end, days[1].start))) isRange = true;
  return esDaysResult_(days, isRange, raw, todayKey);
}

function esDaysResult_(items, isRange, raw, todayKey) {
  var fail = function (why) { return { error: why + ' in "' + raw + '": fill From and To' }; };
  var ty = Math.floor(todayKey / 10000);
  var hasYear = items.some(function (it) { return !!it.y; });
  var build = function (baseYear) {
    var keys = [], yr = baseYear, prevM = 0;
    for (var i = 0; i < items.length; i++) {
      var it = items[i], y = it.y || yr;
      if (!it.y && prevM && it.m < prevM) { y = y + 1; yr = y; } // crossed year end (Dec -> Jan)
      if (!esValidYMD_(y, it.m, it.d)) return null;
      keys.push(esKey_(y, it.m, it.d));
      prevM = it.m;
    }
    return keys;
  };
  var keys = build(ty);
  if (!keys) return fail('Invalid date');
  if (!hasYear && keys[0] > todayKey) {
    var prev = build(ty - 1);
    if (prev) keys = prev;
  }
  var from, to;
  if (keys.length === 1) {
    from = to = keys[0];
  } else if (isRange && keys.length === 2) {
    from = keys[0]; to = keys[1];
  } else {
    var sorted = keys.slice().sort(function (a, b) { return a - b; });
    for (var j = 1; j < sorted.length; j++) {
      if (sorted[j] !== sorted[j - 1] && sorted[j] !== esAddDays_(sorted[j - 1], 1)) {
        return { error: 'Days are not consecutive in "' + raw + '": use one line per date range' };
      }
    }
    from = sorted[0]; to = sorted[sorted.length - 1];
  }
  if (from > to) return fail('From is after To');
  return { from: from, to: to };
}

/** Bank name -> code lookup state from [name, code] pairs. */
function esBankState_(pairs) {
  var st = { bankMap: {}, codes: {}, list: [] };
  (pairs || []).forEach(function (p) {
    var name = String(p[0] === null || p[0] === undefined ? '' : p[0]).trim();
    var code = String(p[1] === null || p[1] === undefined ? '' : p[1]).trim().toUpperCase();
    if (!name || !code) return;
    st.bankMap[esNormText_(name)] = code;
    if (!st.codes[code]) st.list.push(code);
    st.codes[code] = 1;
  });
  st.list.sort();
  return st;
}

function esBankCode_(name, st) {
  var n = esNormText_(name);
  if (!n) return '';
  if (st.bankMap[n]) return st.bankMap[n];
  var up = String(name).trim().toUpperCase();
  return st.codes[up] ? up : '';
}

/**
 * lines: [{row, tid, from, to, done, dateError, manualDates, parsedDates, adjC, adjInvalid,
 *          adjReason, bankCode, bankName, account, accountIsNumber, holder, noBank}]
 * recs:  [{row, tid, mid, status, dateKey, dateObj, amtC, paid, paidLabel, batch, dupOf, dupRecs}]
 * ctx:   {todayKey, lastDataKey, paidAdj: {tid: [{batch, adjC}]} from the Payout Log}
 */
function esComputeLines_(lines, recs, ctx) {
  var byTid = {};
  for (var i = 0; i < recs.length; i++) {
    var r = recs[i];
    if (r.tid) (byTid[r.tid] = byTid[r.tid] || []).push(r);
  }
  var groups = {}, overlap = {}, sibling = {};
  lines.forEach(function (L) {
    if (!L.done && L.tid && L.from && L.to) (groups[L.tid] = groups[L.tid] || []).push(L);
  });
  Object.keys(groups).forEach(function (t) {
    var g = groups[t];
    for (var a = 0; a < g.length; a++) {
      for (var b = a + 1; b < g.length; b++) {
        var A = g[a], B = g[b], bag = (A.from <= B.to && B.from <= A.to) ? overlap : sibling;
        (bag[A.row] = bag[A.row] || []).push(B.row);
        (bag[B.row] = bag[B.row] || []).push(A.row);
      }
    }
  });
  return lines.map(function (L) {
    return esComputeLine_(L, byTid[L.tid] || [], overlap[L.row], sibling[L.row], ctx);
  });
}

function esComputeLine_(L, list, overlapRows, siblingRows, ctx) {
  var res = { row: L.row, line: L, status: 'OK', cnt: 0, amtC: 0, finalC: 0, mid: '', rowsToStamp: [], recs: [],
    notesText: '', notes: [] };
  if (L.done) { res.status = 'DONE'; return res; }
  var B = [], W = [], I = [];
  if (!L.tid) B.push('TID missing');
  if (L.dateError) B.push(L.dateError);
  if (L.from && L.to && L.from > L.to) B.push('From is after To');
  if (L.to && L.to > ctx.todayKey) B.push('To date is in the future');
  if (overlapRows) B.push('Same TID with overlapping dates on line ' + overlapRows.join(', '));
  if (L.tid && !list.length) B.push('TID not found in RAW data');
  if (L.adjInvalid) B.push('Adjustment is not a number');
  else if (L.adjC !== 0 && !L.adjReason) B.push('Adjustment needs a reason');
  if (!L.adjInvalid && L.adjC !== 0 && ctx.paidAdj && ctx.paidAdj[L.tid]) {
    var same = ctx.paidAdj[L.tid].filter(function (a) { return a.adjC === L.adjC; });
    if (same.length) W.push('The same adjustment (' + esFmtC_(L.adjC) + ') for this TID was already paid in ' +
      same.map(function (a) { return a.batch; }).join(', ') + '. Make sure it is not a repeat');
  }
  if (L.manualDates) W.push('"Days to settle" not readable: using the From/To typed in the line');
  if (L.parsedDates) I.push('Dates read from "Days to settle"');

  var mids = {};
  list.forEach(function (r) { if (r.mid) mids[r.mid] = 1; });
  res.mid = Object.keys(mids).join(' / ');
  if (Object.keys(mids).length > 1) W.push('TID appears under more than one MID');

  if (L.from && L.to && list.length) {
    var paid = {}, paidOrder = [], exN = 0, exC = 0, swN = 0, swC = 0, sw = {}, dupN = 0, outN = 0, outC = 0, outD = {};
    list.forEach(function (r) {
      var inside = r.dateKey && r.dateKey >= L.from && r.dateKey <= L.to;
      if (r.dupOf) { if (inside) dupN++; return; }
      if (inside) {
        if (r.paid) {
          var g = r.paidLabel + (r.batch ? ' [' + r.batch + ']' : '');
          if (!paid[g]) { paid[g] = { n: 0, c: 0 }; paidOrder.push(g); }
          paid[g].n++; paid[g].c += r.amtC;
        } else if (!/^approved/i.test(r.status)) {
          exN++; exC += r.amtC;
        } else {
          res.cnt++; res.amtC += r.amtC; res.rowsToStamp.push(r.row); res.recs.push(r);
          if (r.dupRecs) r.dupRecs.forEach(function (d) { if (!d.paid) res.rowsToStamp.push(d.row); });
        }
      } else if (!r.paid) {
        if (r.dateKey && r.dateKey <= ctx.todayKey && /^approved/i.test(r.status)) {
          outN++; outC += r.amtC; outD[r.dateKey] = 1;
        }
        if (r.dateObj && r.dateKey && !r.dateVerified && !r.dateFixed) {
          var p = esKeyParts_(r.dateKey);
          if (p.d <= 12 && p.d !== p.m) {
            var sk = esKey_(p.y, p.d, p.m);
            if (sk >= L.from && sk <= L.to) { swN++; swC += r.amtC; sw[esKeyLabel_(r.dateKey)] = 1; }
          }
        }
      }
    });
    paidOrder.forEach(function (g) {
      I.push('Already paid before: ' + paid[g].n + ' trx (' + esFmtC_(paid[g].c) + ') on ' + g);
    });
    if (exN) W.push(exN + ' non-approved trx skipped (' + esFmtC_(exC) + ')');
    if (dupN) W.push(dupN + ' duplicate row(s) with the same TRX ID as another row: counted once');
    if (swN) W.push(swN + ' unpaid trx (' + esFmtC_(swC) + ') dated ' + Object.keys(sw).join(', ') +
      ' look like day/month swapped into these dates. Fix the date in RAW data, then check again');
    if (!res.cnt) I.push(paidOrder.length ? 'Everything in these dates is already paid' : 'No transactions for this TID in these dates');
    if (ctx.lastDataKey && L.to > ctx.lastDataKey) {
      W.push('RAW data ends on ' + esKeyLabel_(ctx.lastDataKey) + '. Import the missing days first');
    } else if (L.to === ctx.todayKey) {
      W.push('Includes today. Data may be incomplete');
    }
    if (outN) {
      var od = Object.keys(outD).map(Number).sort(function (a, b) { return a - b; });
      I.push('Also unpaid outside these dates: ' + outN + ' trx (' + esFmtC_(outC) + ') from ' +
        esKeyLabel_(od[0]) + (od.length > 1 ? ' to ' + esKeyLabel_(od[od.length - 1]) : ''));
    }
  }
  var badN = 0, badC = 0;
  list.forEach(function (r) {
    if (!r.paid && !r.dupOf && (!r.dateKey || r.dateKey > ctx.todayKey)) { badN++; badC += r.amtC; }
  });
  if (badN) W.push(badN + ' unpaid trx of this TID have a missing or future date (' + esFmtC_(badC) + ')');
  if (siblingRows) I.push('Same TID also on line ' + siblingRows.join(', ') + ' (other dates)');

  res.finalC = res.amtC + (L.adjInvalid ? 0 : L.adjC);
  if (!B.length && res.finalC > 0 && !L.noBank) {
    if (!L.bankCode) B.push('Bank "' + L.bankName + '" has no code. Pick the code or add it in the Banks tab');
    if (!L.account) B.push('Account number missing');
    if (!L.holder) B.push('Account holder name missing');
    if (L.accountIsNumber) W.push('Account number is stored as a number. Leading zeros may be lost');
  }
  if (res.finalC < 0) W.push('Final amount is negative: vendor owes ' + esFmtC_(-res.finalC) + '. Nothing will be marked');
  res.status = B.length ? 'BLOCK' : (res.finalC <= 0 ? 'ZERO' : (W.length ? 'WARN' : 'OK'));
  res.notes = B.map(function (x) { return { k: 'B', t: x }; })
    .concat(W.map(function (x) { return { k: 'W', t: x }; }), I.map(function (x) { return { k: 'I', t: x }; }));
  res.notesText = B.map(function (x) { return '\u26D4 ' + x; })
    .concat(W.map(function (x) { return '\u26A0 ' + x; }), I.map(function (x) { return '\u2139 ' + x; }))
    .join(' | ');
  return res;
}

function esEligible_(r) { return (r.status === 'OK' || r.status === 'WARN') && r.finalC > 0; }

function esSummary_(results) {
  var s = { OK: 0, WARN: 0, BLOCK: 0, ZERO: 0, DONE: 0, payN: 0, payC: 0, trx: 0 };
  results.forEach(function (r) {
    s[r.status]++;
    if (esEligible_(r)) { s.payN++; s.payC += r.finalC; s.trx += r.cnt; }
  });
  return s;
}

function esFingerprint_(arr) {
  return arr.map(function (r) { return r.row + ':' + r.finalC + ':' + r.cnt + ':' + r.rowsToStamp.join(','); }).join('|');
}

function esA1Runs_(col, rows) {
  var r = rows.slice().sort(function (a, b) { return a - b; }), out = [], s = null, p = null;
  for (var i = 0; i < r.length; i++) {
    if (s === null) { s = p = r[i]; } else if (r[i] === p + 1) { p = r[i]; } else if (r[i] !== p) {
      out.push(col + s + ':' + col + p); s = p = r[i];
    }
  }
  if (s !== null) out.push(col + s + ':' + col + p);
  return out;
}

/** Same as esA1Runs_ but as {start, end} row pairs. */
function esRowRuns_(rows) {
  var r = rows.slice().sort(function (a, b) { return a - b; }), out = [], s = null, p = null;
  for (var i = 0; i < r.length; i++) {
    if (s === null) { s = p = r[i]; } else if (r[i] === p + 1) { p = r[i]; } else if (r[i] !== p) {
      out.push({ start: s, end: p }); s = p = r[i];
    }
  }
  if (s !== null) out.push({ start: s, end: p });
  return out;
}

function esColLetter_(c) {
  var s = '';
  while (c > 0) { var m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); }
  return s;
}

function esEsc_(s) {
  return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

/** One imported cell -> value written to RAW data. Strings come back with a leading ' (forced text). */
function esImportCell_(v, order) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object' && !esIsDate_(v) && 'dateSerial' in v) return v.dateSerial;
  if (typeof v !== 'string') return v;
  var s = v.replace(/\u00A0/g, ' ').trim();
  if (s === '') return '';
  if (/^\d{1,2}[\/.\-]\d{1,2}[\/.\-](\d{4}|\d{2})(\s.*)?$/.test(s)) {
    var k = esParseTextDate_(s, order);
    return k ? esKeyToSerial_(k) : "'" + s;
  }
  var num = s.replace(/,/g, '');
  if (/^-?\d+(\.\d+)?$/.test(num) && !/^-?0\d/.test(num) && num.replace(/\D/g, '').length <= 15) return Number(num);
  return "'" + s; // force text: no auto dates, booleans or formulas
}

/**
 * Plans an import of a Kashier export grid (first row = header). Pure: no writes.
 * Cells are strings/numbers; a real date cell from an .xlsx file comes as {dateSerial: n}.
 */
function esPlanImport_(all, rhdr, todayKey, ambiguousOrder) {
  var ihdr = all[0].map(esNormText_);
  var skip = { 'settleted': 1, 'settled': 1, 'settlement status': 1, 'batch id': 1, 'paid to': 1 };
  var map = {}, unmatched = [];
  ihdr.forEach(function (h, j) {
    if (!h) return;
    var k = rhdr.indexOf(h);
    if (k < 0) { unmatched.push(String(all[0][j]).trim()); return; }
    if (skip[h] || map[k] !== undefined) return;
    map[k] = j;
  });
  var kTrx = rhdr.indexOf('trx id'), kDate = rhdr.indexOf('date'), kTid = rhdr.indexOf('tid'),
    kAmt = rhdr.indexOf('settlement amount'), kTime = rhdr.indexOf('time'), kAA = rhdr.indexOf('settleted');
  var miss = [];
  [['TRX ID', kTrx], ['Date', kDate], ['TID', kTid], ['Settlement Amount', kAmt]].forEach(function (p) {
    if (p[1] < 0 || map[p[1]] === undefined) miss.push(p[0]);
  });
  if (miss.length) {
    return { fatal: 'These columns are missing in the file header: ' + miss.join(', ') +
      '.\nUse the Kashier export WITH its header row.' };
  }
  var data = [];
  for (var i = 1; i < all.length; i++) {
    if (all[i].some(function (c) { return c !== '' && c !== null && c !== undefined; })) data.push({ r: all[i], line: i + 1 });
  }
  if (!data.length) return { fatal: 'No transaction rows under the header.' };
  if (data.some(function (d) { return d.r.some(esIsDate_); })) {
    return { fatal: 'Google Sheets turned some cells into dates while pasting, so day and month may be swapped.\n\n' +
      '1) Delete everything in the Import tab\n2) Paste again with Ctrl+Shift+V (values only)' };
  }
  var jd = map[kDate], dmy = false, mdy = false, re = /^\s*(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4}|\d{2})/;
  var isText = function (v) { return typeof v === 'string'; };
  data.forEach(function (d) {
    if (!isText(d.r[jd])) return;
    var m = re.exec(d.r[jd]);
    if (m) { if (+m[1] > 12) dmy = true; if (+m[2] > 12) mdy = true; }
  });
  if (dmy && mdy) return { fatal: 'The Date column mixes day/month and month/day formats. Check the export.' };
  var order = dmy ? 'DMY' : (mdy ? 'MDY' : null), ambiguous = false;
  if (!order) {
    var fD = 0, fM = 0, anyText = false;
    data.forEach(function (d) {
      if (!isText(d.r[jd])) return;
      anyText = true;
      var s = d.r[jd], a = esParseTextDate_(s, 'DMY'), b = esParseTextDate_(s, 'MDY');
      if (a && a > todayKey) fD++;
      if (b && b > todayKey) fM++;
    });
    if (fD && !fM) order = 'MDY';
    else if (fM && !fD) order = 'DMY';
    else { order = ambiguousOrder || 'DMY'; ambiguous = anyText; }
  }
  var cellKey = function (v) {
    if (v && typeof v === 'object' && 'dateSerial' in v) return v.dateSerial > 20000 && v.dateSerial < 80000 ? esSerialToKey_(v.dateSerial) : null;
    if (typeof v === 'number') return v > 20000 && v < 80000 ? esSerialToKey_(v) : null;
    return esParseTextDate_(v, order);
  };
  var errs = [], seen = {}, rows = [], dupInside = 0, width = rhdr.length;
  data.forEach(function (d) {
    var trx = String(d.r[map[kTrx]] === undefined || d.r[map[kTrx]] === null ? '' : d.r[map[kTrx]]).trim();
    if (!trx) { errs.push('Row ' + d.line + ': TRX ID is empty'); return; }
    if (seen[trx]) { dupInside++; return; }
    var dk = cellKey(d.r[jd]);
    if (!dk) { errs.push('Row ' + d.line + ': date not readable "' + (typeof d.r[jd] === 'object' ? JSON.stringify(d.r[jd]) : d.r[jd]) + '"'); return; }
    if (dk > todayKey) { errs.push('Row ' + d.line + ': date in the future ' + esKeyLabel_(dk)); return; }
    if (!esNormTid_(d.r[map[kTid]])) { errs.push('Row ' + d.line + ': TID is empty'); return; }
    seen[trx] = 1;
    var vals = [];
    for (var c = 0; c < width; c++) vals.push('');
    Object.keys(map).forEach(function (ks) {
      var k = +ks, v = d.r[map[k]];
      if (k === kDate) vals[k] = esKeyToSerial_(dk);
      else if (k === kTime) {
        var tv = v && typeof v === 'object' && 'dateSerial' in v ? v.dateSerial % 1 : v;
        var t = esParseTime_(tv);
        vals[k] = t === null ? esImportCell_(v, order) : t;
      }
      else vals[k] = esImportCell_(v, order);
    });
    if (kAA >= 0) vals[kAA] = '0';
    rows.push({ trx: trx, dk: dk, tid: esNormTid_(d.r[map[kTid]]), values: vals });
  });
  if (errs.length) {
    return { fatal: errs.slice(0, 12).join('\n') + (errs.length > 12 ? '\n... and ' + (errs.length - 12) + ' more' : '') };
  }
  return { rows: rows, order: order, ambiguous: ambiguous, dupInside: dupInside, unmatched: unmatched,
    mappedCols: map, kDate: kDate, kTime: kTime, kAA: kAA };
}

/* ------------------------------------------------------------------ */
/*  Web tool additions                                                  */
/* ------------------------------------------------------------------ */

/** Column names (normalized header text) the tool reads from RAW data. */
var ES_RAW_FIELDS = ['mid', 'storename', 'status', 'trx id', 'type', 'date', 'time', 'amount', 'card type',
  'card num', 'auth id', 'settlement amount', 'settleted', 'settlement status', 'terminalid', 'tid'];
var ES_RAW_REQUIRED = ['mid', 'status', 'trx id', 'date', 'settlement amount', 'settleted', 'tid'];

/** Header row (array of cell values) -> {name: 1-based column index}. Missing required names -> {missing}. */
function esHeaderMap_(hdrRow) {
  var norm = hdrRow.map(esNormText_), out = {}, missing = [];
  ES_RAW_FIELDS.forEach(function (n) {
    var i = norm.indexOf(n);
    if (i < 0 && n === 'settleted') i = norm.indexOf('settled');
    if (i >= 0) out[n] = i + 1;
    else if (ES_RAW_REQUIRED.indexOf(n) >= 0) missing.push(n);
  });
  out.missing = missing;
  out.width = norm.length;
  return out;
}

/** "TX-3203627714348" -> 3203627714348 (number) or null. */
function esTrxSeq_(trx) {
  var m = /^TX-?(\d{6,16})$/i.exec(String(trx || '').trim());
  return m ? Number(m[1]) : null;
}

/**
 * RAW data columns (Sheets API: UNFORMATTED_VALUE + SERIAL_NUMBER) -> records.
 * cols: {fieldName: [values of rows 2..]}; n: number of rows read.
 */
function esRecsFromColumns_(cols, n, todayKey) {
  var col = function (name) { return cols[name] || []; };
  var A = {};
  ES_RAW_FIELDS.forEach(function (f) { A[f] = col(f); });
  var val = function (f, i) { var v = A[f][i]; return v === undefined || v === null ? '' : v; };
  var recs = [], lastDataKey = 0;
  for (var i = 0; i < n; i++) {
    var trx = String(val('trx id', i)).trim(), tidV = val('tid', i), dv = val('date', i),
      pv = val('settleted', i), av = val('settlement amount', i), midV = String(val('mid', i)).trim();
    if (trx === '' && tidV === '' && dv === '' && av === '' && midV === '') continue;
    var dk = null, dObj = false;
    if (typeof dv === 'number') { if (dv > 20000 && dv < 80000) { dk = esSerialToKey_(dv); dObj = true; } }
    else if (String(dv).trim() !== '') dk = esParseTextDate_(String(dv), 'DMY');
    var paid = !(pv === '' || pv === 0 || String(pv).trim() === '0');
    var plabel = '', pkey = null;
    if (paid) {
      if (typeof pv === 'number') {
        pkey = pv > 20000 && pv < 80000 ? esSerialToKey_(pv) : null;
        plabel = pkey ? esPayLabel_(pkey) : String(pv);
      } else { plabel = String(pv).trim(); pkey = esParseTextDate_(plabel, 'DMY'); }
    }
    var a = esNum_(av), amt = esNum_(val('amount', i));
    var r = {
      row: i + 2, tid: esNormTid_(tidV), mid: midV, status: String(val('status', i)).trim(), trx: trx,
      type: String(val('type', i)).trim(), dateKey: dk, dateObj: dObj, dateRaw: dv, time: val('time', i),
      amount: isNaN(amt) ? null : amt, amtC: isNaN(a) ? 0 : Math.round(a * 100), amtBad: isNaN(a),
      paid: paid, paidLabel: plabel, paidKey: pkey, batch: '',
      store: String(val('storename', i)).trim(), cardType: String(val('card type', i)).trim(),
      card: String(val('card num', i)).trim(), auth: String(val('auth id', i)).trim(),
      termId: String(val('terminalid', i)).trim(), stLabel: String(val('settlement status', i)).trim().toUpperCase()
    };
    recs.push(r);
  }
  var dups = esMarkDuplicates_(recs);
  var fixes = esApplyDateFixes_(recs, todayKey);
  recs.forEach(function (r) { if (r.dateKey && r.dateKey <= todayKey && r.dateKey > lastDataKey) lastDataKey = r.dateKey; });
  return { recs: recs, lastDataKey: lastDataKey, dupTrx: dups.trx, dupRows: dups.rows, datesFixed: fixes.fixed, datesOdd: fixes.odd };
}

/** Same TRX ID (TX-...) on more than one row: the paid copy (or the first) counts, the others get dupOf. */
function esMarkDuplicates_(recs) {
  var groups = {}, out = { trx: 0, rows: 0 };
  for (var i = 0; i < recs.length; i++) {
    var r = recs[i];
    if (esTrxSeq_(r.trx) === null) continue;
    var k = r.trx.toUpperCase();
    (groups[k] = groups[k] || []).push(r);
  }
  Object.keys(groups).forEach(function (k) {
    var g = groups[k];
    if (g.length < 2) return;
    var canon = g.filter(function (r) { return r.paid; })[0] || g[0];
    canon.dupRecs = [];
    g.forEach(function (r) { if (r !== canon) { r.dupOf = canon.row; canon.dupRecs.push(r); } });
    out.trx++; out.rows += g.length - 1;
  });
  return out;
}

/** Per-TID summary for pickers and the Unpaid view. */
function esTidIndex_(recs, todayKey) {
  var idx = {};
  recs.forEach(function (r) {
    if (!r.tid) return;
    var t = idx[r.tid] || (idx[r.tid] = { tid: r.tid, mids: {}, stores: {}, n: 0, unpaidN: 0, unpaidC: 0, paidN: 0, paidC: 0,
      first: 0, last: 0, firstUnpaid: 0, lastUnpaid: 0, lastPaidKey: 0, lastPaidLabel: '', badN: 0, badC: 0, dupN: 0, negN: 0, negC: 0 });
    if (r.mid) t.mids[r.mid] = 1;
    if (r.dupOf) { t.dupN++; return; }
    t.n++;
    if (r.dateKey) { if (!t.first || r.dateKey < t.first) t.first = r.dateKey; if (r.dateKey > t.last) t.last = r.dateKey; }
    if (r.paid) {
      t.paidN++; t.paidC += r.amtC;
      if (r.paidKey && r.paidKey > t.lastPaidKey) { t.lastPaidKey = r.paidKey; t.lastPaidLabel = r.paidLabel; }
      else if (!t.lastPaidLabel) t.lastPaidLabel = r.paidLabel;
      return;
    }
    t.unpaidN++; t.unpaidC += r.amtC;
    if (r.amtC < 0) { t.negN++; t.negC += r.amtC; }
    if (!r.dateKey || r.dateKey > todayKey) { t.badN++; t.badC += r.amtC; return; }
    if (!t.firstUnpaid || r.dateKey < t.firstUnpaid) t.firstUnpaid = r.dateKey;
    if (r.dateKey > t.lastUnpaid) t.lastUnpaid = r.dateKey;
  });
  Object.keys(idx).forEach(function (k) {
    var t = idx[k];
    t.mid = Object.keys(t.mids).join(' / ');
    delete t.stores;
  });
  return idx;
}

/** One TID, grouped by transaction date: what is paid (and when) and what is not. */
function esTidDays_(recs, tid) {
  var by = {};
  recs.forEach(function (r) {
    if (r.tid !== tid || r.dupOf) return;
    var k = r.dateKey || 0;
    var d = by[k] || (by[k] = { dk: k, n: 0, c: 0, paidN: 0, paidC: 0, unpaidN: 0, unpaidC: 0, labels: {}, otherN: 0, fixed: 0 });
    d.n++; d.c += r.amtC;
    if (r.dateFixed) d.fixed++;
    if (r.paid) { d.paidN++; d.paidC += r.amtC; d.labels[r.paidLabel] = (d.labels[r.paidLabel] || 0) + 1; }
    else if (!/^approved/i.test(r.status)) d.otherN++;
    else { d.unpaidN++; d.unpaidC += r.amtC; }
  });
  return Object.keys(by).map(function (k) { return by[k]; }).sort(function (a, b) { return a.dk - b.dk; });
}

/** Unpaid money per TID (the Unpaid view). */
function esUnpaidOverview_(recs, todayKey) {
  var idx = esTidIndex_(recs, todayKey), rows = [], totN = 0, totC = 0;
  Object.keys(idx).forEach(function (k) {
    var t = idx[k];
    if (!t.unpaidN) return;
    rows.push(t); totN += t.unpaidN; totC += t.unpaidC;
  });
  rows.sort(function (a, b) { return b.unpaidC - a.unpaidC; });
  return { rows: rows, totN: totN, totC: totC, tids: rows.length };
}

/**
 * Real dates (not text) whose day is 1-12 may have been swapped when the export was pasted
 * into the en_US sheet ("08/11/2026" became 11-Aug). Kashier TX numbers grow with time inside
 * a MID, so each such date is checked against the nearest unambiguous dates before and after it:
 *   ok    - the stored date fits between them
 *   swap  - only the swapped date fits (suggest = the swapped date)
 *   odd   - neither fits
 * The newest rows have no later neighbour: today is their upper limit. The oldest rows (no earlier
 * neighbour) are judged on the upper limit only. Rows without a TX number are not classified.
 */
function esCheckDates_(recs, todayKey) {
  var byMid = {};
  recs.forEach(function (r) {
    var seq = esTrxSeq_(r.trx);
    if (seq === null || !r.dateKey) return;
    (byMid[r.mid] = byMid[r.mid] || []).push({ r: r, seq: seq });
  });
  var out = [];
  Object.keys(byMid).forEach(function (mid) {
    var arr = byMid[mid].sort(function (a, b) { return a.seq - b.seq; });
    var anchor = arr.map(function (x) {
      var k = x.r.dateStored || x.r.dateKey;
      if (!x.r.dateObj) return k;
      var p = esKeyParts_(k);
      return p.d > 12 || p.d === p.m ? k : 0;
    });
    var prev = [], next = [], last = 0;
    for (var i = 0; i < arr.length; i++) { prev.push(last); if (anchor[i]) last = anchor[i]; }
    last = 0;
    for (var j = arr.length - 1; j >= 0; j--) { next[j] = last; if (anchor[j]) last = anchor[j]; }
    for (var k = 0; k < arr.length; k++) {
      if (anchor[k]) continue;
      var r = arr[k].r, stored = r.dateStored || r.dateKey;
      var lo = prev[k], hi = next[k] || todayKey || 0;
      if (!hi) continue;
      var p2 = esKeyParts_(stored), sk = esKey_(p2.y, p2.d, p2.m);
      var fitsA = stored <= hi && (!lo || stored >= lo);
      var fitsB = esValidYMD_(p2.y, p2.d, p2.m) && sk <= hi && (!lo || sk >= lo);
      if (fitsA && fitsB && !lo) continue; // the oldest rows: only an upper limit, both dates possible
      out.push({ r: r, kind: fitsA ? 'ok' : (fitsB ? 'swap' : 'odd'), stored: stored, suggest: fitsB && !fitsA ? sk : 0, lo: lo, hi: hi });
    }
  });
  return out.sort(function (a, b) { return a.r.row - b.r.row; });
}

/** Swapped dates only (kept for the Data check list). */
function esSwapSuspects_(recs, onlyUnpaid, todayKey) {
  return esCheckDates_(recs, todayKey).filter(function (x) { return x.kind === 'swap' && !(onlyUnpaid && x.r.paid); });
}

/**
 * Uses the transaction order to correct swapped dates in memory (the sheet is not changed):
 * r.dateKey becomes the real date, r.dateStored keeps what the sheet says, r.dateFixed = true.
 * Dates confirmed by their neighbours get r.dateVerified = true.
 */
function esApplyDateFixes_(recs, todayKey) {
  var n = 0, odd = 0;
  esCheckDates_(recs, todayKey).forEach(function (x) {
    if (x.kind === 'swap') { x.r.dateStored = x.stored; x.r.dateKey = x.suggest; x.r.dateFixed = true; n++; }
    else if (x.kind === 'ok') x.r.dateVerified = true;
    else { x.r.dateOdd = true; odd++; }
  });
  return { fixed: n, odd: odd };
}

/** Problems that can make a payout wrong, for the Data check list (unpaid rows only). */
function esIssues_(recs, todayKey) {
  var out = [], byRow = {};
  recs.forEach(function (r) { byRow[r.row] = r; });
  recs.forEach(function (r) {
    if (r.dupOf) {
      var c = byRow[r.dupOf];
      if (!r.paid) {
        out.push({ r: r, kind: c && c.paid ? 'DUP_PAID' : 'DUP',
          text: c && c.paid ? 'Same TRX ID as row ' + r.dupOf + ', which is already paid (' + c.paidLabel + '). Not counted. Delete this row.'
            : 'Same TRX ID as row ' + r.dupOf + '. Counted once.' });
      }
      return;
    }
    if (r.stLabel && (r.stLabel === 'SETTLED') !== r.paid && (r.stLabel === 'SETTLED' || r.stLabel === 'NOTSETTLED')) {
      out.push({ r: r, kind: 'STATUS', text: 'Settlement Status says ' + r.stLabel + ' but Settleted is "' + (r.paid ? r.paidLabel : '0') +
        '". The tool goes by Settleted' });
    }
    if (r.paid) return;
    if (!r.dateKey) out.push({ r: r, kind: 'NO_DATE', text: 'Date missing or not readable: "' + r.dateRaw + '"' });
    else if (r.dateKey > todayKey) out.push({ r: r, kind: 'FUTURE', text: 'Date ' + esKeyLabel_(r.dateKey) + ' is in the future' });
    if (r.dateFixed) out.push({ r: r, kind: 'FIXED', suggest: r.dateKey,
      text: 'The sheet says ' + esKeyLabel_(r.dateStored) + ' (day and month swapped). The tool uses ' + esKeyLabel_(r.dateKey) + ', from the transaction order' });
    else if (r.dateOdd) out.push({ r: r, kind: 'ODD', text: 'Date ' + esKeyLabel_(r.dateKey) + ' does not fit the transactions around it. Check it' });
    if (r.amtBad) out.push({ r: r, kind: 'AMOUNT', text: 'Settlement Amount is not a number' });
    if (!r.tid) out.push({ r: r, kind: 'NO_TID', text: 'TID missing' });
  });
  return out.sort(function (a, b) { return a.r.row - b.r.row; });
}

/** Lower-case text used by Search. */
function esSearchText_(r) {
  return [r.trx, r.tid, r.card, r.auth, r.mid, r.store, r.termId, r.type, r.status,
    r.amount === null ? '' : String(r.amount), (r.amtC / 100).toFixed(2), esKeyDMY_(r.dateKey), esKeyLabel_(r.dateKey),
    r.dateFixed ? esKeyDMY_(r.dateStored) + ' ' + esKeyLabel_(r.dateStored) : '',
    r.paid ? r.paidLabel : 'unpaid', 'row' + r.row].join(' ').toLowerCase();
}

/** Every word of the query must appear. filter: 'all' | 'unpaid' | 'paid'. */
function esSearch_(recs, q, filter, limit) {
  var words = esArDigits_(String(q || '')).toLowerCase().split(/\s+/).filter(Boolean);
  var out = [], total = 0, totC = 0;
  if (!words.length) return { rows: out, total: 0, totC: 0 };
  for (var i = 0; i < recs.length; i++) {
    var r = recs[i];
    if (filter === 'unpaid' && (r.paid || r.dupOf)) continue;
    if (filter === 'paid' && !r.paid) continue;
    var s = r._s || (r._s = esSearchText_(r)), ok = true;
    for (var w = 0; w < words.length; w++) { if (s.indexOf(words[w]) < 0) { ok = false; break; } }
    if (!ok) continue;
    total++;
    if (!r.dupOf) totC += r.amtC;
    if (out.length < (limit || 500)) out.push(r);
  }
  out.sort(function (a, b) { return (b.dateKey || 0) - (a.dateKey || 0) || b.row - a.row; });
  return { rows: out, total: total, totC: totC };
}

/** Next batch id for a payout date: EVT-20261123-01, -02 ... */
function esNextBatchId_(ids, payKey) {
  var prefix = 'EVT-' + payKey + '-', max = 0;
  (ids || []).forEach(function (s) {
    s = String(s || '');
    if (s.indexOf(prefix) === 0) { var n = parseInt(s.slice(prefix.length), 10); if (n > max) max = n; }
  });
  return prefix + ('0' + (max + 1)).slice(-2);
}

/** Bank bulk file name, e.g. Event_01_Batch_23_Nov_2026. */
function esBankFileName_(prefix, batchId, payKey) {
  var seq = String(batchId).split('-').pop(), p = esKeyParts_(payKey);
  return (prefix || 'Event') + '_' + seq + '_Batch_' + ('0' + p.d).slice(-2) + '_' + ES_MON[p.m - 1] + '_' + p.y;
}

/** Bank file rows (without header) for paid lines: [holder, account, code, amount, tid]. */
function esBankRows_(lines) {
  return lines.map(function (x) {
    return ['', '', '', x.holder, String(x.account), x.bankCode, '', Math.round(x.finalC) / 100, '', x.tid, '', ''];
  });
}

/** Payout Log adjustments already paid, per TID, to flag a repeated manual adjustment. */
function esPaidAdj_(logRows) {
  var out = {};
  (logRows || []).forEach(function (x) {
    if ((x.status === 'PAID' || x.status === 'STAMPING') && x.adjC) {
      (out[x.tid] = out[x.tid] || []).push({ batch: x.batch, adjC: x.adjC });
    }
  });
  return out;
}

/**
 * Sales request grid (first sheet of the Sales file) -> lines.
 * Finds the header row by the "TID" cell; without a header uses the first 6 columns
 * (Brand, TID, Account, Holder, Bank, Days).
 */
function esParseSalesGrid_(grid, bankSt, todayKey) {
  var hdrAt = -1, cols = null;
  for (var i = 0; i < Math.min(grid.length, 10); i++) {
    var row = (grid[i] || []).map(esNormText_);
    if (row.some(function (c) { return /(^|\s)tid$|^tid|terminal id/.test(c); })) { hdrAt = i; cols = row; break; }
  }
  var idx = { brand: 0, tid: 1, acc: 2, holder: 3, bank: 4, days: 5, mid: -1, amount: -1, from: -1, to: -1 };
  if (cols) {
    var find = function (test) { for (var j = 0; j < cols.length; j++) if (test(cols[j])) return j; return -1; };
    idx = {
      brand: find(function (c) { return /brand|merchant name|store/.test(c); }),
      tid: find(function (c) { return /(^|\s)tid$|^tid|terminal id/.test(c); }),
      acc: find(function (c) { return /account (number|no)|iban|acc(oun)?t? ?(no|num)/.test(c) || c === 'account'; }),
      holder: find(function (c) { return /holder|beneficiary|creditor name/.test(c); }),
      bank: find(function (c) { return /^bank( name)?$|bank name/.test(c); }),
      days: find(function (c) { return /day/.test(c); }),
      mid: find(function (c) { return /^mid$/.test(c); }),
      amount: find(function (c) { return /amount/.test(c); }),
      from: find(function (c) { return /^from/.test(c); }),
      to: find(function (c) { return /^to$|^to date/.test(c); })
    };
  }
  var lines = [], start = hdrAt + 1;
  for (var r = start; r < grid.length; r++) {
    var v = grid[r] || [];
    var cell = function (j) { return j >= 0 && v[j] !== undefined && v[j] !== null ? v[j] : ''; };
    var tid = esNormTid_(cell(idx.tid)), brand = String(cell(idx.brand)).replace(/[\s\u00A0]+/g, ' ').trim();
    if (!tid && !brand) continue;
    if (!tid && /tid/i.test(String(cell(idx.tid)))) continue;
    var L = { row: lines.length + 1, srcRow: r + 1, brand: brand, tid: tid, daysText: String(cell(idx.days)).trim() };
    var pr = esParseDays_(cell(idx.days), todayKey);
    var fk = esCellKey_(cell(idx.from)), tk = esCellKey_(cell(idx.to));
    if (!pr.error) { L.from = pr.from; L.to = pr.to; L.parsedDates = true; }
    else if (fk && tk) { L.from = fk; L.to = tk; L.manualDates = true; }
    else { L.dateError = pr.error; L.from = null; L.to = null; }
    L.adjC = 0; L.adjInvalid = false; L.adjReason = '';
    L.bankName = String(cell(idx.bank)).replace(/[\s\u00A0]+/g, ' ').trim();
    L.bankCode = esBankCode_(L.bankName, bankSt);
    var acc = cell(idx.acc);
    L.accountIsNumber = typeof acc === 'number';
    L.account = typeof acc === 'number' ? esNumToPlain_(acc) : String(acc).replace(/[\s\u00A0]/g, '');
    L.holder = String(cell(idx.holder)).replace(/[\s\u00A0]+/g, ' ').trim();
    L.salesMid = String(cell(idx.mid)).trim();
    var sa = idx.amount >= 0 && cell(idx.amount) !== '' ? esNum_(cell(idx.amount)) : NaN;
    L.salesAmtC = isNaN(sa) ? null : Math.round(sa * 100);
    lines.push(L);
  }
  return { lines: lines, headerRow: hdrAt + 1, mapped: idx };
}

/** Number -> plain digits without exponent (account numbers stored as numbers). */
function esNumToPlain_(n) {
  if (!isFinite(n)) return '';
  var s = String(n);
  if (!/e/i.test(s)) return s.replace(/\.0+$/, '');
  return Number(n).toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 0 });
}

/** A cell that should hold a date: serial number, {dateSerial}, dd/mm/yyyy text or yyyy-mm-dd. */
function esCellKey_(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'object' && !esIsDate_(v) && 'dateSerial' in v) return v.dateSerial > 20000 && v.dateSerial < 80000 ? esSerialToKey_(v.dateSerial) : null;
  if (typeof v === 'number') return v > 20000 && v < 80000 ? esSerialToKey_(v) : null;
  return esParseTextDate_(String(v), 'DMY');
}

/** Today in Cairo as yyyymmdd. */
function esTodayKey_(now) {
  var d = now || new Date();
  try {
    var s = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
    var k = esISOToKey_(s);
    if (k) return k;
  } catch (e) { /* fall back to the device date */ }
  return esKey_(d.getFullYear(), d.getMonth() + 1, d.getDate());
}
// == PURE END ==

var api = {
  EPOCH: ES_EPOCH, MON: ES_MON, BANK_SEED: ES_BANK_SEED, BANK_HEADERS: ES_BANK_HEADERS,
  RAW_FIELDS: ES_RAW_FIELDS, RAW_REQUIRED: ES_RAW_REQUIRED,
  isDate: esIsDate_, key: esKey_, keyParts: esKeyParts_, validYMD: esValidYMD_, serialToKey: esSerialToKey_,
  keyToSerial: esKeyToSerial_, addDays: esAddDays_, keyLabel: esKeyLabel_, payLabel: esPayLabel_, keyDMY: esKeyDMY_,
  keyISO: esKeyISO_, isoToKey: esISOToKey_, fmtC: esFmtC_, normText: esNormText_, normTid: esNormTid_, num: esNum_,
  parseTextDate: esParseTextDate_, parseTime: esParseTime_, timeLabel: esTimeLabel_, parseDays: esParseDays_,
  bankState: esBankState_, bankCode: esBankCode_, computeLines: esComputeLines_, eligible: esEligible_,
  summary: esSummary_, fingerprint: esFingerprint_, a1Runs: esA1Runs_, rowRuns: esRowRuns_, colLetter: esColLetter_,
  esc: esEsc_, importCell: esImportCell_, planImport: esPlanImport_, headerMap: esHeaderMap_, trxSeq: esTrxSeq_,
  recsFromColumns: esRecsFromColumns_, markDuplicates: esMarkDuplicates_, tidIndex: esTidIndex_, tidDays: esTidDays_,
  unpaidOverview: esUnpaidOverview_, swapSuspects: esSwapSuspects_, checkDates: esCheckDates_, applyDateFixes: esApplyDateFixes_,
  issues: esIssues_, search: esSearch_, searchText: esSearchText_,
  nextBatchId: esNextBatchId_, bankFileName: esBankFileName_, bankRows: esBankRows_, paidAdj: esPaidAdj_,
  parseSalesGrid: esParseSalesGrid_, numToPlain: esNumToPlain_, cellKey: esCellKey_, todayKey: esTodayKey_
};
if (typeof module === 'object' && module.exports) module.exports = api;
else root.ESEngine = api;
})(typeof self !== 'undefined' ? self : this);
