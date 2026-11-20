"""Phase 7 tests: Stock take (physical count of the FG store compared with the system).
Usage: python3 tests/t_stocktake.py <repo root>      (SHOTS=<folder> also saves phone screenshots)
Runs the web app in headless Chromium (phone-sized, real Content-Security-Policy) against the stand-in Supabase server."""
import sys, os, time, subprocess, json, tempfile
from datetime import datetime, timezone
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

def mk(part, name, qty, status, rack=None, slip=None):
    b = M.new_box(part, name, qty, status, 'LABEL', 'u-admin', '', M.today(), '', '', 'QA')
    b['rack'] = rack
    if slip: b['slip_no'] = slip; b['out_at'] = datetime.now(timezone.utc).isoformat()
    return b

M.USERS['asm@x.com'] = dict(id='u-asm', pw='secret'); M.DB['profiles']['u-asm'] = dict(user_id='u-asm', full_name='Label PC', role='assembly', active=True)
M.USERS['disp@x.com'] = dict(id='u-disp', pw='secret'); M.DB['profiles']['u-disp'] = dict(user_id='u-disp', full_name='Dispatch Man', role='dispatch', active=True)
srv = subprocess.Popen([sys.executable, os.path.join(HERE, 'serve.py'), S, '8765', 'http://127.0.0.1:8766'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
mock = M.serve(8766); time.sleep(1)
errors = []
try:
    FG = [mk('5015855', 'END PLATE', 100, 'FG-RECEIVED', 'R1-01'), mk('5015855', 'END PLATE', 100, 'FG-RECEIVED', 'R1-02'), mk('5015855', 'END PLATE', 100, 'FG-RECEIVED', 'R1-03'),
          mk('5017886', 'BRACKET RH', 50, 'FG-RECEIVED', 'R2-01'), mk('5017886', 'BRACKET RH', 50, 'FG-RECEIVED', 'R2-02'), mk('5017886', 'BRACKET RH', 50, 'FG-RECEIVED', 'R2-03')]
    W1 = mk('5015855', 'END PLATE', 100, 'WIP-PACKED')
    M.DB['slips']['SL-X-001'] = dict(slip_no='SL-X-001', party='FFPL', created_at=datetime.now(timezone.utc).isoformat(), voided_at=None)
    D1 = mk('5017886', 'BRACKET RH', 50, 'DISPATCHED', slip='SL-X-001')
    V1 = mk('5015855', 'END PLATE', 100, 'VOID')
    D2 = mk('5017886', 'BRACKET RH', 50, 'DISPATCHED', slip='SL-X-001')
    ID = lambda b: b['box_id']
    UNKNOWN = 'RP-261119-99999'
    dialogs = []
    with sync_playwright() as p:
        br = p.chromium.launch(); ctx = br.new_context(viewport={'width': 400, 'height': 860}, accept_downloads=True); pg = ctx.new_page()
        pg.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
        pg.on('console', lambda m: errors.append('console: ' + m.text) if m.type == 'error' and 'net::ERR' not in m.text and 'Failed to load resource' not in m.text and 'Cannot reach' not in m.text else None)
        def on_dialog(d): dialogs.append(d.message); d.accept()
        pg.on('dialog', on_dialog)
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
        def scan(bid, wait=0.35):
            pg.fill('#typed', bid); pg.click('#typedgo'); time.sleep(wait)
        def shot(name):
            if SHOTS: pg.screenshot(path=os.path.join(SHOTS, name + '.png'), full_page=True)
        def stat(i): return pg.inner_text('#' + i).strip()
        def take(): return json.loads(pg.evaluate("localStorage.getItem('rbt.take.u-store')") or 'null')
        def xl(sel):
            with pg.expect_download() as di: pg.click(sel)
            path = os.path.join(TMP, di.value.suggested_filename or 'x.xlsx'); di.value.save_as(path); return openpyxl.load_workbook(path, data_only=True), di.value.suggested_filename
        rows_of = lambda ws: [[c for c in r] for r in ws.iter_rows(values_only=True)]
        trs = lambda sel='#pane tbody tr': pg.query_selector_all(sel)

        # ---------------------------------------------------------------- access
        pg.goto(BASE); pg.wait_for_selector('#lf'); login('disp@x.com')
        chk('dispatch role does not see "Stock take" in the menu', 'Stock take' not in txt('.top nav'))
        go('stocktake'); time.sleep(0.6)
        chk('dispatch role opening #/stocktake lands on Home instead', 'Stock take' not in txt('main h1') and 'Today' in txt('main'), txt('main h1'))
        pg.click('#signout'); pg.wait_for_selector('#lf')
        login('asm@x.com')
        chk('assembly role does not see "Stock take"', 'Stock take' not in txt('.top nav'))
        pg.click('#signout'); pg.wait_for_selector('#lf')

        login('store@x.com')
        chk('store role sees "Stock take" in the menu', 'Stock take' in txt('.top nav'))
        go('stocktake'); pg.wait_for_selector('#begin')
        chk('start screen: name box pre-filled with today\'s date, instructions shown', 'Stock take' in pg.input_value('#name') and 'Stop movements' in txt('main'))
        shot('01-start')

        # ---------------------------------------------------------------- counting
        pg.fill('#name', 'Month-end count'); pg.click('#begin'); pg.wait_for_selector('#typed')
        chk('count screen: system has 6 FG boxes (300+150 = 450 NOS... see tile), 0 counted', stat('s-sys') == '6' and stat('s-cnt') == '0' and '450 NOS' in txt('#s-sys-t') and 'Month-end count' in txt('main'), txt('#s-sys-t'))
        chk('count is saved on the phone straight away (name, no scans)', take() and take()['name'] == 'Month-end count' and take()['scans'] == [])
        chk('snapshot of the stock list is kept on the phone', len(json.loads(pg.evaluate("localStorage.getItem('rbt.take.snap.u-store')"))) == 7)   # 6 FG + 1 packed

        scan(ID(FG[0])); pg.wait_for_selector('#result.ok')
        chk('FG box: green with part and qty', '5015855' in txt('#result') and '100 NOS' in txt('#result') and 'R1-01' in txt('#result'), txt('#result'))
        chk('counters: 1 counted, 5 left', stat('s-cnt') == '1' and stat('s-left') == '5' and stat('s-odd') == '0')
        scan(ID(FG[0]))
        chk('same box again: amber "Already counted", still counted once', 'Already counted' in txt('#result') and stat('s-cnt') == '1' and len(take()['scans']) == 1, txt('#result'))
        scan(ID(W1))
        chk('packed-but-never-received box: amber, says it can be received at the end', 'never received into FG' in txt('#result') and 'receive it when you finish' in txt('#result'), txt('#result'))
        scan(ID(D1)); pg.wait_for_selector('#result.bad')
        chk('dispatched box: red, names the slip', 'dispatched on slip sl-x-001' in txt('#result').lower(), txt('#result'))
        scan(ID(V1))
        chk('voided box: red "voided"', 'voided' in txt('#result').lower() and pg.is_visible('#result.bad'), txt('#result'))
        scan(UNKNOWN)
        chk('box id not in the register: red', 'Not in the register' in txt('#result') and pg.is_visible('#result.bad'), txt('#result'))
        scan('HELLO')
        chk('not a Radiance label: red, NOT counted', 'Not a Radiance box label' in txt('#result') and len(take()['scans']) == 5, len(take()['scans']))
        chk('4 counted boxes are "not as the system expects" (packed, dispatched, voided, unknown)', stat('s-odd') == '4' and stat('s-cnt') == '5', stat('s-odd'))
        chk('last-scans table shows what the system says for each', '✓ in FG' in txt('#recent') and 'Dispatched on slip SL-X-001' in txt('#recent') and 'Not in the register' in txt('#recent'))
        shot('02-counting')
        scan(ID(FG[1]))
        pg.fill('#typed', ID(FG[2]).lower()); pg.click('#typedgo'); time.sleep(0.4)
        chk('lowercase Box ID is accepted and counted', stat('s-cnt') == '7' and ID(FG[2]) in [s['id'] for s in take()['scans']], stat('s-cnt'))

        # ---------------------------------------------------------------- reload resumes
        pg.reload(); pg.wait_for_selector('#typed')
        chk('page reload: the count is still there (7 boxes), same name', stat('s-cnt') == '7' and 'Month-end count' in txt('main'))
        chk('page reload: no second start screen, system side rebuilt', stat('s-sys') == '6')
        chk('page reload: boxes judged before are checked again by themselves (4 odd, none left "checking")', wait_js("document.querySelector('#s-odd').textContent === '4'", 6) and 'Checking' not in txt('#recent'), stat('s-odd'))

        # ---------------------------------------------------------------- offline counting
        ctx.set_offline(True)
        chk('offline: pill says "No signal"', wait_js("document.querySelector('#net').textContent === 'No signal'", 5), txt('#net'))
        scan(ID(FG[3]))
        chk('offline, box is in the saved stock list: still judged at once (green)', pg.is_visible('#result.ok') and '5017886' in txt('#result') and stat('s-cnt') == '8', txt('#result'))
        scan(ID(D2), wait=0.8)
        chk('offline, box not in the saved list: amber "Counted, check at the end", still counted', 'check at the end' in txt('#result') and stat('s-cnt') == '9', txt('#result'))
        chk('counter shows how many wait to be checked', '1 to be checked at the end' in txt('#s-odd-t'), txt('#s-odd-t'))
        pg.click('#finish'); time.sleep(0.8)
        chk('offline: Finish says "No connection", count kept on the phone, still on the counting screen', pg.is_visible('#typed') and take() and len(take()['scans']) == 9 and 'No connection' in txt('#toast'), txt('#toast'))
        ctx.set_offline(False)
        wait_js("document.querySelector('#net').textContent === 'Online'", 5)
        chk('back online: the box counted with no signal is judged by itself (5 odd, nothing "to be checked")', wait_js("document.querySelector('#s-odd').textContent === '5'", 8) and 'to be checked' not in txt('#s-odd-t'), txt('#s-odd-t'))

        # ---------------------------------------------------------------- finish
        pg.click('#finish'); pg.wait_for_selector('#xl')
        main = txt('main')
        chk('result: headline counts (9 counted, 2 FG matched, missing 3 = FG[4], FG[5] ... see numbers)', 'Counted 9 boxes' in main and '4 match the system' in main, main[:300])
        T = dict(sys=6, cnt=9)
        # scanned: FG0,FG1,FG2,FG3 (4 match), W1, D1, V1, UNKNOWN, D2 (5 unexpected). Missing: FG4, FG5 (2 boxes, 100 NOS)
        chk('result: 2 missing boxes (100 NOS) and 5 not as expected', '2 boxes (100 NOS)' in main and '5 counted boxes are not supposed' in main, main[:400])
        chk('result: tabs show the counts', 'Missing (2)' in main and 'Not as expected (5)' in main and 'Counted OK (4)' in main)
        chk('result: opens on the Missing tab; lists exactly FG4 and FG5', len(trs()) == 2 and ID(FG[4]) in txt('#pane') and ID(FG[5]) in txt('#pane'))
        pg.click('[data-tab=unexpected]')
        up = txt('#pane')
        chk('not-as-expected tab: all 5 with the reason in plain words', len(trs()) == 5 and 'Label printed, but never received into FG' in up and 'Dispatched on slip SL-X-001' in up and 'Voided' in up and 'Not in the register' in up)
        chk('only the packed box says "Can be received now"', up.count('Can be received now') == 1 and up.count('Check this box') == 4)
        chk('a counted box that was checked offline (D2) is now judged correctly', ID(D2) in up)
        pg.click('[data-tab=summary]')
        sm = txt('#pane')
        chk('by-part tab has a TOTAL row and the "(not in the register)" line', 'TOTAL' in sm and '(not in the register)' in sm, sm[:200])
        pg.click('[data-tab=matched]')
        chk('counted-OK tab: 4 boxes', len(trs()) == 4)
        chk('box ids link to Box history', pg.query_selector('#pane a[href^="#/reports?tab=history&box=RP-"]') is not None)
        shot('03-result')
        wb, fn = xl('#xl')
        chk('Excel: file name carries the count name', fn.startswith('stock-take-Month-end-count') and fn.endswith('.xlsx'), fn)
        chk('Excel: five sheets', wb.sheetnames == ['Summary', 'Missing', 'Not as expected', 'Counted OK', 'Info'], wb.sheetnames)
        sm = rows_of(wb['Summary']); tot = sm[-1]
        chk('Excel Summary: TOTAL row = system 6 boxes/450 NOS... counted 9 boxes', tot[0] == 'TOTAL' and tot[2] == 6 and tot[4] == 9, tot)
        chk('Excel Missing: FG4, FG5 with qty and rack', {r[0] for r in rows_of(wb['Missing'])[1:]} == {ID(FG[4]), ID(FG[5])} and rows_of(wb['Missing'])[1][3] == 50)
        ne = rows_of(wb['Not as expected'])[1:]
        chk('Excel Not as expected: 5 rows with reasons', len(ne) == 5 and any('Dispatched on slip SL-X-001' == r[4] for r in ne) and any(r[1] == '(not in the register)' for r in ne), ne[:2])
        chk('Excel Counted OK: 4 rows', len(rows_of(wb['Counted OK'])) == 5)
        info = {r[0]: r[1] for r in rows_of(wb['Info'])[1:]}
        chk('Excel Info: name, counted by, result', info.get('Name') == 'Month-end count' and info.get('Counted by') == 'Store Man' and info.get('Result') == 'Differences found' and info.get('Boxes counted') == 9, info)

        # ---------------------------------------------------------------- receive the packed box
        chk('"Receive 1 packed box into FG" button is offered', pg.is_visible('#recv') and 'Receive 1 packed box' in txt('#recv'))
        n_ev = len([e for e in M.DB['events'] if e['event'] == 'RECEIVED'])
        dialogs.clear(); pg.click('#recv'); pg.wait_for_selector('#xl'); time.sleep(0.8)
        chk('receive-now asked for confirmation first', any('Receive 1 box' in d for d in dialogs), dialogs)
        chk('packed box is now FG-RECEIVED in the database, with one RECEIVED event', W1['status'] == 'FG-RECEIVED' and len([e for e in M.DB['events'] if e['event'] == 'RECEIVED']) == n_ev + 1, W1['status'])
        main = txt('main')
        chk('result is re-judged: 5 match, 4 not as expected, button gone', 'Counted OK (5)' in main and 'Not as expected (4)' in main and not pg.query_selector('#recv'), main[:300])

        # ---------------------------------------------------------------- back to counting, then close
        pg.click('#back'); pg.wait_for_selector('#typed')
        chk('"Back to counting" keeps every scan (9)', stat('s-cnt') == '9' and stat('s-sys') == '7', stat('s-sys'))   # W1 is now FG, so the system has 7
        scan(ID(FG[4])); scan(ID(FG[5]))
        pg.click('#finish'); pg.wait_for_selector('#xl')
        main = txt('main')
        chk('after counting the 2 missing boxes: only the 4 odd boxes are left, nothing missing', 'Missing (0)' in main and 'Counted OK (7)' in main and 'Not as expected (4)' in main, main[:200])
        dialogs.clear(); pg.click('#close'); pg.wait_for_selector('#begin')
        chk('close: confirmation mentions downloading first', any('Download the Excel' in d for d in dialogs))
        chk('close: stored count and stock list are gone from the phone', take() is None and pg.evaluate("localStorage.getItem('rbt.take.snap.u-store')") is None)

        # ---------------------------------------------------------------- clean count
        # the system now has 7 boxes in FG (6 + the packed one received above): count exactly those
        pg.fill('#name', 'Clean count'); pg.click('#begin'); pg.wait_for_selector('#typed')
        for b in FG + [W1]: scan(ID(b), 0.25)
        pg.click('#finish'); pg.wait_for_selector('#xl')
        main = txt('main')
        chk('clean count: green headline "matches the system", 7 boxes', 'The count matches the system' in main and '7 boxes' in main and pg.is_visible('.msg.ok'), main[:200])
        chk('clean count: opens on By part, nothing missing, nothing odd', 'Missing (0)' in main and 'Not as expected (0)' in main and 'TOTAL' in txt('#pane'))
        pg.click('#close'); pg.wait_for_selector('#begin')

        # ---------------------------------------------------------------- rack filter (partial count)
        pg.fill('#name', 'Rack 1 only'); pg.click('#begin'); pg.wait_for_selector('#typed')
        pg.fill('#rack', 'r1'); pg.dispatch_event('#rack', 'change')
        scan(ID(FG[0])); scan(ID(FG[1]))
        chk('rack filter is remembered on the phone', take()['rack'] == 'r1')
        pg.click('#finish'); pg.wait_for_selector('#xl')
        main = txt('main')
        chk('rack filter: only racks starting with "r1" are judged, R2 boxes are NOT reported missing', 'Missing (1)' in main and ID(FG[2]) in txt('#pane') and ID(FG[3]) not in txt('#pane'), main[:300])
        chk('rack filter: the scope is written in the result', 'racks starting with “r1”' in main, main[:300])
        wb, fn = xl('#xl')
        chk('Excel Info says which part of the store was counted', any(r[0] == 'Part of the store' and 'r1' in r[1] for r in rows_of(wb['Info'])))
        pg.click('#back'); pg.wait_for_selector('#typed')
        chk('back to counting: rack filter still filled in', pg.input_value('#rack') == 'r1')

        # ---------------------------------------------------------------- cancel
        dialogs.clear(); pg.click('#cancel'); pg.wait_for_selector('#begin')
        chk('cancel: asks first, says how many boxes will be forgotten', any('forget the 2 boxes' in d for d in dialogs), dialogs)
        chk('cancel: back on the start screen, nothing stored', take() is None)

        # ---------------------------------------------------------------- finishing an empty count
        pg.fill('#name', 'Empty'); pg.click('#begin'); pg.wait_for_selector('#typed')
        dialogs.clear(); pg.click('#finish'); pg.wait_for_selector('#xl')
        chk('empty count: asks for confirmation, then everything FG is missing (7)', any('Nothing was scanned' in d for d in dialogs) and 'Missing (7)' in txt('main'), txt('main')[:200])
        pg.click('#close'); pg.wait_for_selector('#begin')

        # ---------------------------------------------------------------- starting with no signal
        ctx.set_offline(True)
        pg.click('#begin'); time.sleep(0.8)
        chk('no signal and no stock list on the phone: clear message, no count started', 'No connection and no stock list' in txt('#toast') and pg.is_visible('#begin') and take() is None, txt('#toast'))
        pg.evaluate("""localStorage.setItem('rbt.take.snap.u-store', JSON.stringify([{box_id:'%s',part_no:'5015855',part_name:'END PLATE',qty:100,status:'FG-RECEIVED',rack:null,slip_no:null,fg_at:null}]))""" % ID(FG[0]))
        pg.click('#begin'); pg.wait_for_selector('#typed')
        chk('no signal but a saved stock list: counting starts from the saved list', stat('s-sys') == '1' and take() is not None, stat('s-sys'))
        ctx.set_offline(False)
        pg.evaluate("localStorage.removeItem('rbt.take.u-store'); localStorage.removeItem('rbt.take.snap.u-store')")

        # ---------------------------------------------------------------- each login has its own count
        pg.goto(BASE); pg.wait_for_selector('.top nav'); go('stocktake'); pg.wait_for_selector('#begin')
        pg.fill('#name', 'Store count'); pg.click('#begin'); pg.wait_for_selector('#typed'); scan(ID(FG[0]))
        pg.click('#signout'); pg.wait_for_selector('#lf'); login('fg@x.com'); go('stocktake'); pg.wait_for_selector('#begin')
        chk('another login on the same phone does not see the first login\'s count', pg.is_visible('#begin') and 'Store count' not in txt('main'))
        pg.click('#signout'); pg.wait_for_selector('#lf'); login('store@x.com'); go('stocktake'); pg.wait_for_selector('#typed')
        chk('...and the first login finds its own count again', stat('s-cnt') == '1' and 'Store count' in txt('main'))
        chk('stock take never changed a box (no event was written by counting)', [e for e in M.DB['events'] if e['event'] not in ('CREATED', 'RECEIVED')] == [], [e['event'] for e in M.DB['events']])
        br.close()
finally:
    srv.kill()
bad = [e for e in errors if e]
chk('no browser errors', not bad, '; '.join(bad[:3]))
print(f'\n{sum(results)} passed, {len(results) - sum(results)} failed')
sys.exit(0 if all(results) else 1)
