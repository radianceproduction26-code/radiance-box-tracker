// Phase 7 pure logic: stock take comparison (stockcount.js) and old-list comparison / readiness (reconcile.js).
// Usage: node tests/t_pure.mjs <repo root>
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const root = path.resolve(process.argv[2] || '.');
const L = (f) => import(pathToFileURL(path.join(root, 'web/js', f)).href);
const { buildResult, whyText, inScope, chunk, NOT_IN_REGISTER } = await L('stockcount.js');
const R = await L('reconcile.js');
let pass = 0, fail = 0;
const chk = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? `  [${extra}]` : '')); };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------- stock take
const box = (id, part, qty, status, extra = {}) => ({ box_id: id, part_no: part, part_name: 'N-' + part, qty, status, rack: null, slip_no: null, ...extra });
const fg = [box('B1', 'A', 100, 'FG-RECEIVED', { rack: 'R1-01' }), box('B2', 'A', 100, 'FG-RECEIVED', { rack: 'R1-02' }), box('B3', 'B', 50, 'FG-RECEIVED', { rack: 'R2-01' }), box('B4', 'B', 50, 'FG-RECEIVED', { rack: 'R2-02' })];
const others = [box('W1', 'A', 100, 'WIP-PACKED'), box('D1', 'B', 50, 'DISPATCHED', { slip_no: 'SL-1' }), box('V1', 'A', 100, 'VOID')];
const byId = (ids, rows) => new Map(ids.map((i) => [i, rows.find((r) => r.box_id === i) || null]));

let r = buildResult({ scanIds: ['B1', 'B2', 'B3', 'B4'], byId: byId(['B1', 'B2', 'B3', 'B4'], fg), fgRows: fg });
chk('perfect count is clean', r.totals.clean && r.totals.matched === 4 && r.totals.missing === 0 && r.totals.unexpected === 0 && r.totals.diff_qty === 0, JSON.stringify(r.totals));

let ids = ['B1', 'B3', 'W1', 'D1', 'V1', 'X9'];
r = buildResult({ scanIds: ids, byId: byId(ids, [...fg, ...others]), fgRows: fg });
chk('missing = in system FG, not scanned (B2, B4)', eq(r.missing.map((x) => x.box_id).sort(), ['B2', 'B4']) && r.totals.missing === 2 && r.totals.missing_qty === 150);
chk('unexpected = packed, dispatched, voided, unknown', eq(r.unexpected.map((x) => x.box_id), ['W1', 'D1', 'V1', 'X9']) && r.totals.unexpected === 4);
chk('only packed-not-received is receivable', eq(r.unexpected.map((x) => x.receivable), [true, false, false, false]));
chk('reasons are readable', eq(r.unexpected.map((x) => x.why), ['Label printed, but never received into FG', 'Dispatched on slip SL-1', 'Voided', 'Not in the register']), JSON.stringify(r.unexpected.map((x) => x.why)));
chk('matched = B1, B3', eq(r.matched.map((x) => x.box_id), ['B1', 'B3']) && r.totals.matched === 2);
const A = r.summary.find((p) => p.part_no === 'A'), Bp = r.summary.find((p) => p.part_no === 'B'), NR = r.summary.find((p) => p.part_no === NOT_IN_REGISTER);
chk('summary per part: A system 2 boxes/200, counted B1+W1+V1=3 boxes/300', A && A.sys_boxes === 2 && A.sys_qty === 200 && A.cnt_boxes === 3 && A.cnt_qty === 300 && A.diff_qty === 100, JSON.stringify(A));
chk('summary per part: B system 2/100, counted B3+D1=2/100', Bp && Bp.sys_boxes === 2 && Bp.cnt_boxes === 2 && Bp.diff_qty === 0, JSON.stringify(Bp));
chk('unknown box gets its own "(not in the register)" line, 1 box 0 NOS', NR && NR.cnt_boxes === 1 && NR.cnt_qty === 0 && NR.sys_boxes === 0);
chk('totals add up', r.totals.sys_boxes === 4 && r.totals.cnt_boxes === 6 && r.totals.sys_qty === 300 && r.totals.cnt_qty === 400 && r.totals.diff_boxes === 2 && r.totals.diff_qty === 100, JSON.stringify(r.totals));
chk('largest difference listed first', r.summary[0].part_no === 'A', r.summary.map((p) => p.part_no).join(','));
chk('a count with differences is not clean', r.totals.clean === false);

r = buildResult({ scanIds: ['B1', 'B2'], byId: byId(['B1', 'B2'], fg), fgRows: fg, rackStart: 'r1' });
chk('rack filter (case-insensitive): only R1 is judged, R2 boxes are NOT missing', r.totals.missing === 0 && r.totals.sys_boxes === 2 && r.totals.clean, JSON.stringify(r.totals));
r = buildResult({ scanIds: ['B1'], byId: byId(['B1'], fg), fgRows: fg, rackStart: 'R1' });
chk('rack filter: R1 box not scanned is missing', eq(r.missing.map((x) => x.box_id), ['B2']));
r = buildResult({ scanIds: [], byId: new Map(), fgRows: fg });
chk('nothing scanned: every FG box is missing', r.totals.missing === 4 && r.totals.cnt_boxes === 0 && r.totals.diff_qty === -300, JSON.stringify(r.totals));
r = buildResult({ scanIds: [], byId: new Map(), fgRows: [] });
chk('empty store, empty count: clean', r.totals.clean && r.summary.length === 0);
chk('inScope with no rack = everything, row without rack never matches a rack filter', inScope({ rack: null }, '') && !inScope({ rack: null }, 'R1') && inScope({ rack: 'r1-5' }, ' R1 '));
chk('whyText of an unknown status', whyText({ status: 'ODD' }) === 'Status ODD');
chk('chunk', eq(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]) && eq(chunk([], 60), []));

// ---------------------------------------------------------------- old list
const rows1 = [['Old stock register FG'], [], ['SR', 'Part Number', 'Part Description', 'Closing Stock', 'Std per box'], [1, '5015855', 'END PLATE', '1,200', 100], [2, ' 5017886. ', 'BRACKET', 300, 50], [3, '5015855', 'END PLATE', 100, 100], [4, '', '', '', ''], [5, 'X-1', 'JUNK', 'abc', 1], [6, 'Y-2', 'EMPTY', '', 1], ['', 'TOTAL', '', 1600, ''], [7, '', 'NO PART', 5, 1]];
let d = R.detectColumns(rows1);
chk('detects header on row 3 and the columns (closing stock beats std per box)', d && d.header === 2 && d.part === 1 && d.qty === 3 && d.name === 2, JSON.stringify(d));
let p = R.parseOldList(rows1, d);
chk('parse: 2 parts, same part added together (1,200 + 100), trailing dot removed', p.items.size === 2 && p.items.get('5015855').qty === 1300 && p.items.get('5017886').qty === 300 && p.merged === 1, JSON.stringify([...p.items]));
chk('parse: bad qty, empty qty, empty part are reported; TOTAL line is ignored', p.skipped.length === 3 && p.totalRows === 1 && p.skipped.some((s) => s.row === 8 && /abc/.test(s.why)) && p.skipped.some((s) => s.row === 9 && /empty/.test(s.why)) && p.skipped.some((s) => s.row === 11 && /Part no is empty/.test(s.why)), JSON.stringify(p.skipped));
chk('detect: no recognisable header -> null', R.detectColumns([['a', 'b'], [1, 2]]) === null);
chk('detect: "Item code" + "Qty" + "Stock" columns', eq(R.detectColumns([['Item Code', 'Qty per box', 'Stock NOS']]), { header: 0, part: 0, qty: 2, name: -1 }));
chk('detect: "Part No" + "QTY"', R.detectColumns([['PART NO', 'QTY']]).qty === 1);
const num = R.parseOldList([['Part no', 'Qty'], [5015855, 10], ['0012', 5]], { header: 0, part: 0, qty: 1, name: -1 });
chk('numeric part numbers become text; leading zeros kept', num.items.has('5015855') && num.items.has('0012'));

const app = [{ part_no: '5015855', part_name: 'END PLATE, PLASTIC', fg_qty: 1300, wip_qty: 0 }, { part_no: '5017886', part_name: 'BRACKET RH', fg_qty: 250, wip_qty: 50 }, { part_no: '5099999', part_name: 'ONLY HERE', fg_qty: 70, wip_qty: 0 }];
let c = R.compareStock(new Map([...p.items, ['4000000', { part_no: '4000000', name: 'ONLY OLD', qty: 40 }]]), app);
const st = (no) => c.rows.find((x) => x.part_no === no);
chk('match', st('5015855').status === R.STATUS.MATCH && st('5015855').diff === 0);
chk('app has less (250 vs 300)', st('5017886').status === R.STATUS.LESS && st('5017886').diff === -50);
chk('only in app', st('5099999').status === R.STATUS.ONLY_APP && st('5099999').diff === 70);
chk('only in old list', st('4000000').status === R.STATUS.ONLY_OLD && st('4000000').diff === -40 && st('4000000').part_name === 'ONLY OLD');
chk('name: app name wins, old name is the fallback', st('5017886').part_name === 'BRACKET RH');
chk('differences first (largest first), matches last', c.rows[0].part_no === '5099999' && c.rows[c.rows.length - 1].status === R.STATUS.MATCH, c.rows.map((x) => x.part_no).join(','));
chk('totals', c.totals.old === 1640 && c.totals.app === 1620 && c.totals.diff === -20 && c.totals.parts === 4 && c.totals.match === 1 && c.totals.differ === 3, JSON.stringify(c.totals));
c = R.compareStock(p.items, app, { includeWip: true });
chk('include packed-not-received: 5017886 now 300 = old 300', c.rows.find((x) => x.part_no === '5017886').status === R.STATUS.MATCH);
c = R.compareStock(new Map([['Z', { part_no: 'Z', name: '', qty: 0 }]]), [{ part_no: 'Z', part_name: '', fg_qty: 0, wip_qty: 0 }]);
chk('zero on both sides is not reported', c.rows.length === 0 && c.totals.parts === 0);
c = R.compareStock(new Map([['5015855', { part_no: '5015855', name: '', qty: 10 }]]), [{ part_no: '5015855 ', part_name: '', fg_qty: 10, wip_qty: 0 }]);
chk('app part numbers are cleaned the same way (trailing space) before comparing', c.rows.length === 1 && c.rows[0].status === R.STATUS.MATCH);
c = R.compareStock(new Map([['5015855', { part_no: '5015855', name: '', qty: 10 }]]), [{ part_no: '5015855', part_name: '', fg_qty: 0, wip_qty: 0 }]);
chk('app has 0, old has 10 -> "Only in old list"', c.rows[0].status === R.STATUS.ONLY_OLD);

// ---------------------------------------------------------------- readiness
const good = { parts: 40, packOpts: 60, roles: { admin: 1, assembly: 1, fg: 1 }, noRole: 0, openingDone: '2026-11-01 10:00', labelBoxes: 500, receivedBoxes: 480, slips: 12, packedStale: 0, staleHours: 24, firstLabelDay: '2026-11-01', today: '2026-11-19' };
let e = R.evaluateReadiness(good);
chk('all good = Ready, no bad, no warn', e.bad === 0 && e.warn === 0 && /^Ready/.test(e.verdict), e.verdict);
chk('parallel run day counts from the first label (1 Nov -> 19 Nov = day 19)', e.items.find((i) => i.id === 'days').title === 'Parallel run: day 19');
const lv = (f, id) => R.evaluateReadiness({ ...good, ...f }).items.find((i) => i.id === id);
chk('no pack sizes -> parts item is "bad"', lv({ packOpts: 0 }, 'parts').level === 'bad');
chk('no assembly login -> users "bad"', lv({ roles: { admin: 1, fg: 1 } }, 'users').level === 'bad');
chk('no fg login but store+dispatch is accepted', lv({ roles: { assembly: 1, store: 1, dispatch: 1 } }, 'users').level === 'ok');
chk('store only (no dispatch) is not enough', lv({ roles: { assembly: 1, store: 1 } }, 'users').level === 'bad');
chk('login without role -> warning item appears; absent when 0', lv({ noRole: 2 }, 'norole').level === 'warn' && !lv({ noRole: 0 }, 'norole'));
chk('opening stock not done -> warn', lv({ openingDone: '' }, 'opening').level === 'warn');
chk('no labels / no inward / no slip -> bad', lv({ labelBoxes: 0 }, 'labels').level === 'bad' && lv({ receivedBoxes: 0 }, 'inward').level === 'bad' && lv({ slips: 0 }, 'slips').level === 'bad');
chk('stale packed -> warn with the count in the text', lv({ packedStale: 5 }, 'stale').level === 'warn' && /5 box/.test(lv({ packedStale: 5 }, 'stale').detail));
chk('fewer than 14 days -> warn, mentions the day', lv({ firstLabelDay: '2026-11-10' }, 'days').level === 'warn' && /day 10/.test(lv({ firstLabelDay: '2026-11-10' }, 'days').title));
chk('exactly 14 days -> ok', lv({ firstLabelDay: '2026-11-06' }, 'days').level === 'ok');
chk('no label yet -> parallel run "has not started" warn', lv({ firstLabelDay: '' }, 'days').level === 'warn');
e = R.evaluateReadiness({ parts: 2, packOpts: 0, roles: { admin: 1 }, noRole: 0, openingDone: '', labelBoxes: 0, receivedBoxes: 0, slips: 0, packedStale: 0, firstLabelDay: '', today: '2026-11-19' });
chk('fresh system: Not ready, counts of bad/warn match the items', /^Not ready/.test(e.verdict) && e.bad === e.items.filter((i) => i.level === 'bad').length && e.bad >= 4, e.verdict + ' ' + e.bad);
chk('every item has a title and a detail', e.items.every((i) => i.title && i.detail));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
