"""Phase 7 tests: Parallel run page (admin): go-live check, comparison with an old stock list, full backup.
Usage: python3 tests/t_parallel.py <repo root>      (SHOTS=<folder> also saves screenshots)"""
import sys, os, time, subprocess, json, tempfile
from datetime import datetime, timedelta, timezone
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import mock_supabase as M
import openpyxl
from playwright.sync_api import sync_playwright

S = os.path.abspath(sys.argv[1])
SHOTS = os.environ.get('SHOTS')
if SHOTS: os.makedirs(SHOTS, exist_ok=True)
TMP = tempfile.mkdtemp()
BASE = 'http://127.0.0.1:8765/web/?api=http://127.0.0.1:8766'
results = []
def chk(name, cond, extra=''):
    results.append(bool(cond)); print(('PASS ' if cond else 'FAIL ') + name + (f'  [{extra}]' if extra else ''))
iso = lambda dt: dt.astimezone(timezone.utc).isoformat()

def mk(part, name, qty, status, age_h=1.0, rack=None):
    """A box whose label was printed age_h hours ago. FG-RECEIVED / DISPATCHED boxes also get their RECEIVED (and DISPATCHED) event, like the real database."""
    b = M.new_box(part, name, qty, status, 'LABEL', 'u-admin', '', M.today(), '', '', 'QA')
    b['created_at'] = iso(datetime.now(timezone.utc) - timedelta(hours=age_h)); b['rack'] = rack
    for e in M.DB['events']:
        if e['box_id'] == b['box_id']: e['at'] = b['created_at']
    if status in ('FG-RECEIVED', 'DISPATCHED'): receive(b, age_h - 0.25)
    if status == 'DISPATCHED': M.ev(b['box_id'], 'DISPATCHED', 'u-admin', 'SL-1', at=iso(datetime.now(timezone.utc) - timedelta(hours=max(age_h - 0.5, 0.01))))
    return b

def receive(b, age_h):
    at = iso(datetime.now(timezone.utc) - timedelta(hours=max(age_h, 0.01)))
    b.update(status='FG-RECEIVED', fg_at=at, fg_by='u-admin'); M.ev(b['box_id'], 'RECEIVED', 'u-admin', at=at)

def old_list(path, rows, sheet='Stock'):
    wb = openpyxl.Workbook(); ws = wb.active; ws.title = sheet
    for r in rows: ws.append(r)
    wb.save(path); return path

srv = subprocess.Popen([sys.executable, os.path.join(HERE, 'serve.py'), S, '8765', 'http://127.0.0.1:8766'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
mock = M.serve(8766); time.sleep(1)
errors = []
try:
    with sync_playwright() as p:
        br = p.chromium.launch(); ctx = br.new_context(viewport={'width': 1100, 'height': 900}, accept_downloads=True); pg = ctx.new_page()
        pg.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
        pg.on('console', lambda m: errors.append('console: ' + m.text) if m.type == 'error' and 'net::ERR' not in m.text and 'Failed to load resource' not in m.text else None)
        pg.on('dialog', lambda d: d.accept())
        go = lambda h: pg.evaluate(f"location.hash='#/{h}'")
        txt = lambda sel='main': pg.inner_text(sel)
        def wait_js(expr, timeout=10):
            end = time.time() + timeout
            while time.time() < end:
                if pg.evaluate(expr): return True
                time.sleep(0.1)
            return False
        def login(email):
            pg.fill('#em', email); pg.fill('#pw', 'secret'); pg.click('#go'); pg.wait_for_selector('.top nav')
        def shot(name):
            if SHOTS: pg.screenshot(path=os.path.join(SHOTS, name + '.png'), full_page=True)
        def xl(sel):
            with pg.expect_download() as di: pg.click(sel)
            path = os.path.join(TMP, di.value.suggested_filename or 'x.xlsx'); di.value.save_as(path); return openpyxl.load_workbook(path, data_only=True), di.value.suggested_filename
        rows_of = lambda ws: [list(r) for r in ws.iter_rows(values_only=True)]
        item = lambda i: pg.query_selector(f'.chkrow[data-id="{i}"]')
        lvl = lambda i: item(i).query_selector('.lvl').inner_text() if item(i) else None

        # ---------------------------------------------------------------- access
        pg.goto(BASE); pg.wait_for_selector('#lf'); login('store@x.com')
        chk('store login has no "Parallel run" in the menu', 'Parallel run' not in txt('.top nav'))
        go('parallel'); time.sleep(0.6)
        chk('store login opening #/parallel lands on Home', 'Parallel run' not in txt('main h1'), txt('main h1'))
        pg.click('#signout'); pg.wait_for_selector('#lf'); login('admin@x.com')
        chk('admin sees "Parallel run" in the menu', 'Parallel run' in txt('.top nav'))

        # ---------------------------------------------------------------- go-live check on a fresh system
        go('parallel'); pg.wait_for_selector('#verdict')
        chk('opens on the Go-live check tab', pg.is_visible('[data-tab=golive].on') and 'Go-live check' in txt('.tabs'))
        chk('fresh system: verdict "Not ready"', 'Not ready' in txt('#verdict'), txt('#verdict'))
        chk('fresh system: parts/pack sizes, logins, labels, inward, slips are "Fix"', all(lvl(i) == 'Fix' for i in ('parts', 'users', 'labels', 'inward', 'slips')), [lvl(i) for i in ('parts', 'users', 'labels', 'inward', 'slips')])
        chk('fresh system: opening stock "Check", parallel run not started "Check"', lvl('opening') == 'Check' and lvl('days') == 'Check')
        chk('fresh system: stale boxes "OK" (there are none)', lvl('stale') == 'OK')
        chk('the login without a role (new@x.com) is reported', lvl('norole') == 'Check' and '1 login' in txt('.chkrow[data-id=norole]'))
        chk('cut-over steps are shown', len(pg.query_selector_all('#steps li')) == 6 and 'switch-over day' in txt('#steps'))
        chk('items link to the page that fixes them', pg.query_selector('.chkrow[data-id=parts] a[href="#/parts"]') is not None and pg.query_selector('.chkrow[data-id=users] a[href="#/users"]') is not None)
        if SHOTS: shot('p1-golive-fresh')

        # ---------------------------------------------------------------- go-live check once the system is in use
        M.DB['parts']['5015855'] = dict(part_no='5015855', name='END PLATE', std_qty=100, active=True)
        M.DB['packing'][('5015855', 100)] = dict(part_no='5015855', std_qty=100, pp_box_code='PP1', tray_no='T1')
        M.DB['profiles']['u-new'] = dict(user_id='u-new', full_name='Label PC', role='assembly', active=True)
        M.DB['settings']['opening_stock_done'] = '2026-11-01 10:00'
        A = mk('5015855', 'END PLATE', 100, 'FG-RECEIVED', age_h=24 * 20)
        B = mk('5015855', 'END PLATE', 100, 'FG-RECEIVED', age_h=24 * 3)
        C = mk('5017886', 'BRACKET RH', 50, 'WIP-PACKED', age_h=30)       # printed 30 h ago, never received: "stale"
        D = mk('5017886', 'BRACKET RH', 50, 'WIP-PACKED', age_h=2)        # fresh: not stale
        M.DB['slips']['SL-1'] = dict(slip_no='SL-1', party='FFPL', created_at=iso(datetime.now(timezone.utc)), voided_at=None)
        E = mk('5017886', 'BRACKET RH', 50, 'DISPATCHED', age_h=24 * 5); E['slip_no'] = 'SL-1'
        pg.click('[data-tab=compare]'); pg.click('[data-tab=golive]'); pg.wait_for_selector('#verdict'); time.sleep(0.3)
        chk('in use: parts+pack sizes OK, labels OK, inward OK, slips OK, opening OK', all(lvl(i) == 'OK' for i in ('parts', 'labels', 'inward', 'slips', 'opening')), [lvl(i) for i in ('parts', 'labels', 'inward', 'slips', 'opening')])
        chk('in use: logins OK (assembly + fg + store exist)', lvl('users') == 'OK', lvl('users'))
        chk('in use: the stale-box item counts only the box printed more than 24 h ago (1)', lvl('stale') == 'Check' and '1 box' in txt('.chkrow[data-id=stale]'), txt('.chkrow[data-id=stale]'))
        chk('in use: parallel run is on day 21 (first label 20 days ago) -> OK', lvl('days') == 'OK' and 'day 21' in txt('.chkrow[data-id=days]'), txt('.chkrow[data-id=days]'))
        chk('no role item is gone now that new@x.com has a role', item('norole') is None)
        M.DB['profiles']['u-fg'] = dict(user_id='u-fg', full_name='FG Man', role='fg', active=False)   # switched off: must not count
        pg.click('[data-tab=compare]'); pg.click('[data-tab=golive]'); pg.wait_for_selector('#verdict'); time.sleep(0.3)
        chk('a switched-off fg login does not count', lvl('users') == 'Fix')
        M.DB['profiles']['u-fg']['active'] = True
        receive(C, 0.5)
        pg.click('[data-tab=compare]'); pg.click('[data-tab=golive]'); pg.wait_for_selector('#verdict'); time.sleep(0.3)
        chk('all conditions met: "Ready" (green message), no Fix / Check left', 'Ready' in txt('#verdict') and pg.is_visible('.msg.ok') and lvl('users') == 'OK' and lvl('stale') == 'OK', txt('#verdict'))
        chk('all OK rows: nothing to fix, nothing to check', pg.query_selector('.chkrow .lvl.bad') is None and pg.query_selector('.chkrow .lvl.warn') is None)
        shot('p2-golive-ready')

        # ---------------------------------------------------------------- compare with the old list
        pg.click('[data-tab=compare]')
        chk('compare tab: needs a file first (Compare button disabled, no column box)', pg.is_disabled('#go') and pg.is_hidden('#map'))
        # app stock today: 5015855: A 100 + B 100 = 200 ; 5017886: C 50 (received above) = 50 ; D packed 50 (WIP) ; E dispatched
        f1 = old_list(os.path.join(TMP, 'old1.xlsx'), [['OLD FG STOCK REGISTER'], [], ['Sr', 'Part No', 'Part Name', 'Closing Stock', 'Std/box'],
                       [1, 5015855, 'END PLATE', 200, 100], [2, '5017886', 'BRACKET RH', 120, 50], [3, '5015855', 'END PLATE', 0, 100], [4, '4000001', 'OLD ONLY', 40, 10], [5, '', '', '', ''], [6, 'ABC', 'BAD', 'x', 1], ['', 'TOTAL', '', 360, '']])
        pg.set_input_files('#file', f1); pg.wait_for_selector('#map:not([hidden])')
        chk('file read: columns found automatically (header on line 3, Part No, Closing Stock, name)', pg.input_value('#hdr') == '3' and 'Part No' in pg.eval_on_selector('#c-part', 'e=>e.selectedOptions[0].text') and 'Closing Stock' in pg.eval_on_selector('#c-qty', 'e=>e.selectedOptions[0].text') and 'Part Name' in pg.eval_on_selector('#c-name', 'e=>e.selectedOptions[0].text'),
            [pg.eval_on_selector(i, 'e=>e.selectedOptions[0].text') for i in ('#c-part', '#c-qty', '#c-name')])
        chk('Compare button is enabled after choosing a file', not pg.is_disabled('#go'))
        pg.click('#go'); pg.wait_for_selector('#verdict')
        chk('result: parts differ message, "stock as on" today', 'parts differ' in txt('#verdict') and M.today().split('-')[0] in txt('#out'), txt('#verdict'))
        # old: 5015855 = 200+0 = 200 (match), 5017886 = 120 (app 50 -> less 70), 4000001 = 40 (only old), ABC skipped
        chk('result tiles: old 360, app 250? (200 + 50), difference', pg.inner_text('#t-old') == '360' and pg.inner_text('#t-app') == '250' and pg.inner_text('#t-diff').replace('−', '-') == '-110', [pg.inner_text(i) for i in ('#t-old', '#t-app', '#t-diff', '#t-parts')])
        chk('"show only differences" is on by default: matching part hidden, 2 rows', len(pg.query_selector_all('#cmp tbody tr')) == 2 and '5015855' not in txt('#cmp'), txt('#cmp')[:200])
        chk('differences are labelled in words', 'App has less' in txt('#cmp') and 'Only in old list' in txt('#cmp'))
        chk('skipped line is reported (ABC: not a number) and the TOTAL line is ignored', 'could not be read' in txt('#out') and 'ABC' in txt('#out') and 'TOTAL line was ignored' in txt('#out'), txt('#out')[:500])
        chk('same part on two lines was added together (noted)', 'more than one line' in txt('#out'))
        pg.uncheck('#only'); time.sleep(0.2)
        chk('untick "show only differences": the matching part appears', len(pg.query_selector_all('#cmp tbody tr')) == 3 and '5015855' in txt('#cmp'))
        shot('p3-compare')
        wb, fn = xl('#xl')
        chk('Excel: file name has the date; sheets Comparison, Lines not read, Info', fn == f'stock-compare-{M.today()}.xlsx' and wb.sheetnames == ['Comparison', 'Lines not read', 'Info'], (fn, wb.sheetnames))
        cm = rows_of(wb['Comparison'])
        chk('Excel Comparison: all 3 parts + TOTAL (360 / 250 / -110)', len(cm) == 5 and cm[-1][0] == 'TOTAL' and cm[-1][2:5] == [360, 250, -110], cm)
        chk('Excel Comparison: status text per part', {r[0]: r[5] for r in cm[1:4]} == {'5015855': 'Match', '5017886': 'App has less', '4000001': 'Only in old list'}, {r[0]: r[5] for r in cm[1:4]})
        sk = rows_of(wb['Lines not read'])
        chk('Excel Lines not read: line number and reason', len(sk) == 2 and sk[1][0] == 9 and 'not a number' in sk[1][1], sk)
        chk('Excel Info: file name, date, WIP option', any(r[0] == 'Old list file' and r[1] == 'old1.xlsx' for r in rows_of(wb['Info'])) and any(r[0].startswith('Includes') and r[1] == 'No' for r in rows_of(wb['Info'])))

        # include packed-not-received (WIP): D = 50 NOS packed -> 5017886 app = 100
        pg.check('#wip'); time.sleep(0.3)
        chk('"count boxes not yet scanned into FG" changes the result at once (app 300)', pg.inner_text('#t-app') == '300' and pg.inner_text('#t-diff').replace('−', '-') == '-60', pg.inner_text('#t-app'))
        pg.uncheck('#wip'); time.sleep(0.2)

        # as-on date in the past: 8 days ago only box A (created 20 days ago) existed as FG ... A is 100 NOS of 5015855
        past = (datetime.now(timezone(timedelta(hours=5, minutes=30))) - timedelta(days=8)).date().isoformat()
        pg.fill('#on', past); pg.dispatch_event('#on', 'change'); pg.click('#go'); time.sleep(0.6)
        chk('stock as on an earlier date is fetched and used (only box A existed: app total 100)', pg.inner_text('#t-app') == '100', pg.inner_text('#t-app'))
        pg.fill('#on', M.today()); pg.dispatch_event('#on', 'change')

        # choose columns by hand + a second file where the headings are not recognised
        f2 = old_list(os.path.join(TMP, 'old2.xlsx'), [['code', 'pcs'], ['5015855', 200], ['5017886', 50]], sheet='Sheet1')
        pg.set_input_files('#file', f2); pg.wait_for_selector('#map:not([hidden])'); time.sleep(0.3)
        chk('unrecognised headings: the app says so and asks you to choose', 'headings were not recognised' in txt('#map'))
        pg.click('#go'); pg.wait_for_selector('#verdict'); time.sleep(0.2)
        chk('guessing columns 1 and 2 works here: all parts match', 'All 2 parts match' in txt('#verdict'), txt('#verdict'))
        pg.check('#only'); time.sleep(0.2)
        chk('all matching: green message, no difference table rows', pg.is_visible('.msg.ok') and len(pg.query_selector_all('#cmp tbody tr')) == 0)
        # swap the same column for part and qty -> refused
        pg.select_option('#c-qty', '0'); pg.click('#go'); time.sleep(0.4)
        chk('same column for Part no and Quantity is refused', 'must be different columns' in txt('#toast'), txt('#toast'))
        pg.select_option('#c-qty', '1')

        # multi-sheet workbook: the sheet with recognisable headings is chosen
        wb3 = openpyxl.Workbook(); ws = wb3.active; ws.title = 'Notes'; ws.append(['just some notes'])
        w2 = wb3.create_sheet('Closing'); [w2.append(r) for r in [['Item code', 'Qty'], ['5015855', 200], ['5017886', 50]]]
        f3 = os.path.join(TMP, 'old3.xlsx'); wb3.save(f3)
        pg.set_input_files('#file', f3); pg.wait_for_selector('#sheet'); time.sleep(0.3)
        chk('several sheets: picks the one with part and qty headings, sheet box offered', pg.eval_on_selector('#sheet', 'e=>e.selectedOptions[0].text') == 'Closing')
        pg.click('#go'); pg.wait_for_selector('#verdict'); time.sleep(0.2)
        chk('...and compares it', 'All 2 parts match' in txt('#verdict'))

        # csv with commas in numbers and a part that is only in the app
        f4 = os.path.join(TMP, 'old4.csv'); open(f4, 'w').write('Part No,Qty,Name\n5015855,"1,000",END PLATE\n')
        pg.set_input_files('#file', f4); pg.wait_for_selector('#map:not([hidden])'); time.sleep(0.3); pg.click('#go'); pg.wait_for_selector('#verdict'); time.sleep(0.2)
        chk('CSV: "1,000" read as 1000; the part only in the app is listed', pg.inner_text('#t-old') == '1,000' and '5017886' in txt('#cmp') and 'Only in app' in txt('#cmp'), txt('#cmp')[:200])
        f5 = os.path.join(TMP, 'empty.csv'); open(f5, 'w').write('')
        pg.set_input_files('#file', f5); time.sleep(0.5)
        chk('empty file: clear message', 'no data' in txt('#out'), txt('#out'))

        # the chosen file and result stay when switching tabs
        pg.click('[data-tab=backup]'); pg.click('[data-tab=compare]'); time.sleep(0.3)
        chk('switching tabs keeps the loaded old list and result', pg.is_visible('#verdict') or pg.is_visible('#map'))

        # ---------------------------------------------------------------- backup
        pg.click('[data-tab=backup]'); pg.wait_for_selector('#bk')
        M.DB['parties']['FFPL'] = dict(name='FFPL', location='Nandur', transport='Renuka', disp_exe='X', driver_name='Y', driver_mob='1')
        wb, fn = xl('#bk'); time.sleep(0.3)
        chk('backup: file name has the date', fn == f'radiance-backup-{M.today()}.xlsx', fn)
        chk('backup: sheets', wb.sheetnames == ['Info', 'Boxes', 'Box history', 'Packing slips', 'Parts', 'Pack sizes', 'Parties'], wb.sheetnames)
        n_box = len(M.DB['boxes']); n_ev = len(M.DB['events'])
        chk('backup: Boxes has every box (and the header)', len(rows_of(wb['Boxes'])) == n_box + 1, (len(rows_of(wb['Boxes'])), n_box))
        chk('backup: Box history has every event, with names (admin)', len(rows_of(wb['Box history'])) == n_ev + 1 and rows_of(wb['Box history'])[1][3] == 'Bhushan', rows_of(wb['Box history'])[1])
        chk('backup: slips, parts, pack sizes, parties', len(rows_of(wb['Packing slips'])) == 2 and len(rows_of(wb['Parts'])) == 2 and len(rows_of(wb['Pack sizes'])) == 2 and len(rows_of(wb['Parties'])) == 2)
        bx = rows_of(wb['Boxes']); head = bx[0]
        chk('backup: box row has id, part (text), qty (number), status, dispatched slip', head[:5] == ['Box ID', 'Part no', 'Part name', 'Qty', 'Status'] and all(isinstance(r[3], (int, float)) for r in bx[1:]) and any(r[11] == 'SL-1' for r in bx[1:]))
        info = {r[0]: r[1] for r in rows_of(wb['Info'])[1:]}
        chk('backup Info: counts match', info.get('Boxes') == n_box and info.get('Box history lines') == n_ev and info.get('Packing slips') == 1, info)
        chk('backup: done message shown', 'Done' in txt('#bkmsg') and str(n_box) in txt('#bkmsg'), txt('#bkmsg'))
        shot('p4-backup')

        # ---------------------------------------------------------------- phone layout
        pg.set_viewport_size({'width': 390, 'height': 844})
        pg.click('[data-tab=golive]'); pg.wait_for_selector('#verdict'); time.sleep(0.3)
        chk('phone: no sideways scroll on the Go-live tab', pg.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), pg.evaluate('document.documentElement.scrollWidth'))
        shot('p5-golive-phone')
        pg.click('[data-tab=compare]'); time.sleep(0.2)
        chk('phone: no sideways scroll on the Compare tab', pg.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), pg.evaluate('document.documentElement.scrollWidth'))
        br.close()
finally:
    srv.kill()
bad = [e for e in errors if e]
chk('no browser errors', not bad, '; '.join(bad[:3]))
print(f'\n{sum(results)} passed, {len(results) - sum(results)} failed')
sys.exit(0 if all(results) else 1)
