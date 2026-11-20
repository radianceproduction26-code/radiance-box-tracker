"""Phase 5 tests: reports (day summary, stock ledger, stock on a date, ageing, voids, box history, Excel export, Home warning).
Usage: python3 tests/t_reports.py <repo root>
Part A checks the ledger logic against numbers produced by the REAL SQL functions (006_reports.sql) on the live project:
  (1) a synthetic scenario run in a rolled-back transaction, (2) the real boxes of 2 and 16 November.
Part B drives the web app in headless Chromium against the mock server (same logic, mirrored in Python)."""
import sys, os, time, subprocess, io
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import mock_supabase as M
from openpyxl import load_workbook
from playwright.sync_api import sync_playwright
import tempfile
TMP = tempfile.mkdtemp()
def xl(d):
    """Save a download as .xlsx and open it with openpyxl."""
    f = os.path.join(TMP, d.suggested_filename); d.save_as(f); return load_workbook(f)

S = os.path.abspath(sys.argv[1])
results = []
def chk(name, cond, extra=''):
    results.append(bool(cond)); print(('PASS ' if cond else 'FAIL ') + name + (f'  [{extra}]' if extra else ''))

DEF = dict(source='LABEL', shift='A', qa_sign='', lot='', pp_box_code='', tray_no='', rack=None, slip_no=None, fg_at=None, fg_by=None, out_at=None, label_date='2026-01-10')
def add_box(box_id, part, name, qty, status, events, slip=None, **kw):
    """A box with a hand-made history. events = [(event, iso time (UTC), note)]. created_at / fg_at / out_at follow the history."""
    M.DB['seq'] += 1
    b = dict(DEF, seq=M.DB['seq'], box_id=box_id, part_no=part, part_name=name, qty=qty, status=status, slip_no=slip, **kw)
    for e, at, note in events:
        M.ev(box_id, e, 'u-admin', note, at=at)
        if e in ('CREATED', 'OPENING'): b['created_at'] = at
        if e == 'RECEIVED': b['fg_at'] = at
        if e == 'DISPATCHED': b['out_at'] = at
    M.DB['boxes'].append(b)
    return b

def reset():
    M.DB['boxes'].clear(); M.DB['events'].clear(); M.DB['slips'].clear(); M.DB['seq'] = 0; M.DB['evid'] = 0; M.DB['settings'].clear()

def slip(no, party='SAMPLE AUTO PVT LTD'):
    M.DB['slips'][no] = dict(slip_no=no, party=party, location='', transport='', vehicle='', lr_no='', inv_no='', disp_exe='', driver_name='', driver_mob='', created_at='2026-01-11T09:30:00+00:00', created_by='u-admin', voided_at=None)

# ------------------------------------------------------------------ Part A: logic against the real SQL results
def part_a():
    reset(); slip('SL-Y')
    add_box('ZZ-T1', 'ZZ-TEST', 'TEST PART', 50, 'VOID', [('CREATED', '2026-01-10T03:30:00+00:00', None), ('RECEIVED', '2026-01-10T05:30:00+00:00', None), ('REPRINTED', '2026-01-10T06:30:00+00:00', None), ('VOIDED', '2026-01-11T04:30:00+00:00', 'damaged')])
    add_box('ZZ-T2', 'ZZ-TEST', 'TEST PART', 30, 'DISPATCHED', [('OPENING', '2026-01-10T02:30:00+00:00', None), ('DISPATCHED', '2026-01-11T09:30:00+00:00', 'SL-X'), ('SLIP_VOIDED', '2026-01-12T09:30:00+00:00', 'SL-X: wrong party'), ('DISPATCHED', '2026-01-13T09:30:00+00:00', 'SL-Y')], slip='SL-Y')
    add_box('ZZ-T3', 'ZZ-TEST', 'TEST PART', 20, 'VOID', [('CREATED', '2026-01-10T04:00:00+00:00', None), ('VOIDED', '2026-01-10T12:30:00+00:00', 'misprint')])
    key = ('day', 'fg_open', 'out_qty', 'in_qty', 'disp_qty', 'other_qty', 'fg_close', 'wip_close', 'out_boxes', 'in_boxes', 'disp_boxes')
    got = [tuple(r[k] for k in key) for r in M.stock_ledger('2026-01-09', '2026-01-14')]
    want = [('2026-01-10', 0, 70, 50, 0, 30, 80, 0, 2, 1, 0), ('2026-01-11', 80, 0, 0, 30, -50, 0, 0, 0, 0, 1), ('2026-01-12', 0, 0, 0, 0, 30, 30, 0, 0, 0, 0), ('2026-01-13', 30, 0, 0, 30, 0, 0, 0, 0, 0, 1)]
    chk('ledger logic = real SQL (opening stock, void from FG, void from packed, slip void, reprint ignored)', got == want, got)
    on = {d: [(r['fg_qty'], r['fg_boxes'], r['wip_qty']) for r in M.stock_as_on(d)] for d in ('2026-01-09', '2026-01-10', '2026-01-11', '2026-01-12', '2026-01-13')}
    chk('stock-on-a-date logic = real SQL', on == {'2026-01-09': [], '2026-01-10': [(80, 2, 0)], '2026-01-11': [], '2026-01-12': [(30, 1, 0)], '2026-01-13': []}, on)

    # the real boxes of 2 and 16 Nov 2026 (IST times from the live project)
    reset(); slip('SL-261102-001'); slip('SL-261116-001')
    for i in range(4, 9): add_box(f'RP-261102-{i:05d}', '5015855', 'END PLATE ,PLASTIC', 100, 'WIP-PACKED', [('CREATED', '2026-11-02T09:19:07+00:00', None)])
    add_box('RP-261102-00009', '5023380', 'END PLATE', 100, 'DISPATCHED', [('CREATED', '2026-11-02T10:07:19+00:00', None), ('RECEIVED', '2026-11-02T10:25:00+00:00', None), ('DISPATCHED', '2026-11-02T10:27:36+00:00', 'SL-261102-001')], slip='SL-261102-001')
    add_box('RP-261102-00010', '5023380', 'END PLATE', 100, 'WIP-PACKED', [('CREATED', '2026-11-02T10:07:19+00:00', None)])
    add_box('RP-261102-00011', '5023380', 'END PLATE', 100, 'FG-RECEIVED', [('CREATED', '2026-11-02T10:09:47+00:00', None), ('RECEIVED', '2026-11-02T10:30:42+00:00', None)])
    add_box('RP-261116-00012', '5015855', 'END PLATE ,PLASTIC', 100, 'DISPATCHED', [('CREATED', '2026-11-16T10:45:32+00:00', None), ('RECEIVED', '2026-11-16T10:52:03+00:00', None), ('DISPATCHED', '2026-11-16T10:55:39+00:00', 'SL-261116-001')], slip='SL-261116-001')
    got = [tuple(r[k] for k in ('day', 'part_no', 'fg_open', 'out_qty', 'in_qty', 'disp_qty', 'other_qty', 'fg_close', 'wip_close')) for r in M.stock_ledger('2026-11-01', '2026-11-17')]
    want = [('2026-11-02', '5015855', 0, 500, 0, 0, 0, 0, 500), ('2026-11-02', '5023380', 0, 300, 200, 100, 0, 100, 100), ('2026-11-16', '5015855', 0, 100, 100, 100, 0, 0, 500)]
    chk('ledger logic = real SQL on the live boxes', got == want, got)
    now = [(r['part_no'], r['fg_qty'], r['fg_boxes'], r['wip_qty'], r['wip_boxes']) for r in M.stock_as_on('2026-11-17')]
    chk('stock now = real SQL on the live boxes', now == [('5015855', 0, 0, 500, 5), ('5023380', 100, 1, 100, 1)], now)

part_a()

# ------------------------------------------------------------------ Part B: the screens
srv = subprocess.Popen([sys.executable, os.path.join(HERE, 'serve.py'), S, '8765', 'http://127.0.0.1:8766'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
mock = M.serve(8766); time.sleep(1)
BASE = 'http://127.0.0.1:8765/web/?api=http://127.0.0.1:8766'
errors = []
SHOTS = os.environ.get('SHOTS')   # set SHOTS=<folder> to save screenshots of every tab
if SHOTS: os.makedirs(SHOTS, exist_ok=True)
try:
    # data for the screens: the January scenario (3 boxes, 4 days) + today's real flow through the RPCs
    reset(); slip('SL-Y')
    add_box('RP-260110-00001', '5015855', 'COVER LH', 50, 'VOID', [('CREATED', '2026-01-10T03:30:00+00:00', None), ('RECEIVED', '2026-01-10T05:30:00+00:00', 'A-1'), ('VOIDED', '2026-01-11T04:30:00+00:00', 'damaged in store')])
    add_box('RP-260110-00002', '5015855', 'COVER LH', 30, 'DISPATCHED', [('OPENING', '2026-01-10T02:30:00+00:00', None), ('DISPATCHED', '2026-01-11T09:30:00+00:00', 'SL-X'), ('SLIP_VOIDED', '2026-01-12T09:30:00+00:00', 'SL-X: wrong party'), ('DISPATCHED', '2026-01-13T09:30:00+00:00', 'SL-Y')], slip='SL-Y', source='OPENING')
    add_box('RP-260110-00003', '5015855', 'COVER LH', 20, 'VOID', [('CREATED', '2026-01-10T04:00:00+00:00', None), ('VOIDED', '2026-01-10T12:30:00+00:00', 'misprint')])
    # old boxes for the ageing report: packed 3 days ago and never received; in FG for 40 days
    from datetime import datetime, timedelta, timezone
    iso = lambda d: (datetime.now(timezone.utc) - d).replace(microsecond=0).isoformat()
    add_box('RP-OLD-WIP-1', '5023380', 'BRACKET RH', 100, 'WIP-PACKED', [('CREATED', iso(timedelta(days=3, hours=2)), None)], lot='L7')
    add_box('RP-OLD-WIP-2', '5023380', 'BRACKET RH', 100, 'WIP-PACKED', [('CREATED', iso(timedelta(hours=2)), None)])   # fresh: must NOT be listed
    add_box('RP-OLD-FG-1', '5023380', 'BRACKET RH', 200, 'FG-RECEIVED', [('CREATED', iso(timedelta(days=41)), None), ('RECEIVED', iso(timedelta(days=40)), 'B-3')], rack='B-3')
    add_box('RP-NEW-FG-1', '5023380', 'BRACKET RH', 200, 'FG-RECEIVED', [('CREATED', iso(timedelta(days=5)), None), ('RECEIVED', iso(timedelta(days=4)), None)])   # newer than 30 d: not listed

    with sync_playwright() as p:
        br = p.chromium.launch(); ctx = br.new_context(accept_downloads=True, viewport={'width': 1280, 'height': 900}); pg = ctx.new_page()
        pg.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
        pg.on('console', lambda m: errors.append('console: ' + m.text) if m.type == 'error' and 'net::ERR' not in m.text and 'Failed to load resource' not in m.text else None)
        go = lambda h: pg.evaluate(f"location.hash='#/{h}'")
        txt = lambda sel='main': pg.inner_text(sel)
        rows = lambda sel='#rep table': pg.evaluate("(s)=>[...document.querySelectorAll(s+' tbody tr')].map(tr=>[...tr.children].map(td=>td.innerText.trim()))", sel)
        def wait(sel, t=8000): pg.wait_for_selector(sel, timeout=t)
        def settle():
            time.sleep(0.15)
            for _ in range(60):
                if not pg.query_selector('#out .hint:has-text("Loading")'): return
                time.sleep(0.1)
        def show(tab, **fields):
            pg.click(f'[data-tab="{tab}"]'); settle()
            for k, v in fields.items():
                (pg.select_option if k in ('hrs', 'days', 'r') else pg.fill)(f'#{k}', str(v))
            pg.click('#show'); settle()
            if SHOTS: pg.screenshot(path=os.path.join(SHOTS, f'desk-{tab}.png'), full_page=True)
        num = lambda s: int(s.replace(',', '').replace('+', '').replace('−', '-').replace('-', '-') or 0)

        pg.goto(BASE); wait('#lf'); pg.fill('#em', 'admin@x.com'); pg.fill('#pw', 'secret'); pg.click('#go'); wait('.top nav')

        # ---- Home warning about boxes printed long ago and never scanned in
        go(''); wait('.stat')
        chk('Home warns about the packed-not-received box (1 old, the fresh one is not counted)', '1 box(es)' in txt() and 'still not scanned into FG' in txt(), txt()[:200].replace('\n', ' '))
        pg.click('a:has-text("See which")'); wait('[data-tab="aging"].on'); settle()
        chk('"See which" opens Reports > Ageing', 'Packed, not received in FG: 1 box(es)' in txt())

        # ---- Day summary (default tab)
        go('reports'); wait('[data-tab="summary"].on'); settle()
        chk('Reports opens on Day summary with quick-range buttons and export buttons', pg.query_selector('[data-q="month"]') and pg.query_selector('#xlsx') and pg.query_selector('#csv') and pg.query_selector('#book'))
        show('summary', **{'from': '2026-01-09', 'to': '2026-01-14'})
        r = rows()
        chk('Day summary: one row per day (6) plus TOTAL', len(r) == 7 and r[-1][0] == 'TOTAL', [x[0] for x in r])
        d10 = next(x for x in r if x[0].startswith('10.01.2026'))
        chk('Day summary 10.01: out 2 boxes/70, in 1 box/50, voided 20, FG end 80, packed 0', d10[1:] == ['2', '70', '1', '50', '0', '0', '20', '80', '0'], d10)
        d11 = next(x for x in r if x[0].startswith('11.01.2026'))
        chk('Day summary 11.01: dispatched 1 box/30, voided 50, FG end 0', d11[5:9] == ['1', '30', '50', '0'], d11)
        d14 = next(x for x in r if x[0].startswith('14.01.2026'))
        chk('Day summary: a day with no movement still shows, FG stays 0', d14[1:] == ['0'] * 9, d14)
        chk('Day summary TOTAL: out 70, in 50, dispatched 60, voided 70', r[-1][1:8] == ['2', '70', '1', '50', '2', '60', '70'], r[-1])
        # Excel + CSV of the Day summary
        with pg.expect_download() as dl: pg.click('#xlsx')
        wb = xl(dl.value); ws = wb['Day summary']
        vals = list(ws.iter_rows(values_only=True))
        chk('Excel file: sheet "Day summary", header, 6 days + TOTAL, real dates and numbers', wb.sheetnames == ['Day summary'] and vals[0][0] == 'Date' and len(vals) == 8 and vals[1][0].strftime('%Y-%m-%d') == '2026-01-09' and vals[2][2] == 70 and vals[2][7] == 20 and vals[2][8] == 80 and vals[-1][0] == 'TOTAL', vals[:3])
        chk('Excel file name', dl.value.suggested_filename == 'day-summary-2026-01-09-to-2026-01-14.xlsx', dl.value.suggested_filename)
        with pg.expect_download() as dl: pg.click('#csv')
        raw = open(dl.value.path(), 'rb').read().decode('utf-8-sig')
        chk('CSV file: dates written as dd.mm.yyyy', raw.splitlines()[0].startswith('Date,Assembly out boxes') and '10.01.2026,2,70,1,50,0,0,20,80,0' in raw, raw.splitlines()[:3])

        # ---- Period checks and quick buttons
        show('summary', **{'from': '2026-02-01', 'to': '2026-01-01'})
        chk('"From" after "To" is refused with a clear message', '"From" is after "To"' in txt('#out'))
        show('summary', **{'from': '2024-01-01', 'to': '2026-01-01'})
        chk('More than 366 days is refused', 'at most 366 days' in txt('#out'))
        pg.click('[data-q="month"]'); settle()
        today = M.today()
        chk('"This month" button sets From = 1st of the month, To = today', pg.input_value('#from') == today[:8] + '01' and pg.input_value('#to') == today, (pg.input_value('#from'), pg.input_value('#to')))
        pg.click('[data-q="last"]'); settle()
        chk('"Last month" button gives a whole calendar month', pg.input_value('#from').endswith('-01') and pg.input_value('#from')[:7] < today[:7] and pg.input_value('#to') >= pg.input_value('#from'))

        # ---- Stock ledger
        show('ledger', **{'from': '2026-01-09', 'to': '2026-01-14', 'part': ''})
        r = rows()
        chk('Ledger: 4 days of movement + TOTAL', len(r) == 5 and r[-1][0] == 'TOTAL', [x[0] for x in r])
        ok_arith = all(num(x[3]) + num(x[5]) + num(x[7]) - num(x[6]) == num(x[8]) for x in r[:-1])
        chk('Ledger: FG opening + inward + other - dispatched = closing on every row', ok_arith, r[:-1])
        chk('Ledger: opening of each day = closing of the day before (part 5015855)', [x[3] for x in r[:-1]] == ['0', '80', '0', '30'] and [x[8] for x in r[:-1]] == ['80', '0', '30', '0'], r[:-1])
        chk('Ledger: "Other" shows sign (+30, -50)', [x[7] for x in r[:-1]] == ['+30', '-50', '+30', '0'], [x[7] for x in r[:-1]])
        show('ledger', **{'part': 'zzz-none'})
        chk('Ledger part filter with no match shows an empty message', 'No stock movement' in txt('#out'))
        show('ledger', **{'part': 'cover'})
        chk('Ledger part filter matches the part name (case-insensitive)', len(rows()) == 5)

        # ---- Stock on a date
        show('ason', on='2026-01-12')
        r = rows()
        chk('Stock on 12.01.2026: 1 part, FG 30 NOS in 1 box, + TOTAL row', len(r) == 2 and r[0][:4] == ['5015855', 'COVER LH', '30', '1'] and r[1][0] == 'TOTAL', r)
        show('ason', on='2026-01-11')
        chk('Stock on 11.01.2026: nothing in FG (empty-state message)', 'No stock on this date' in txt('#out') or all(x[2] == '0' for x in rows()), txt('#out')[:80])
        with pg.expect_download() as dl: pg.click('#xlsx')
        wb = xl(dl.value)
        chk('Stock-on-a-date sheet is named with the date', wb.sheetnames[0] == 'Stock on 11.01.2026', wb.sheetnames)

        # ---- Ageing
        show('aging', hrs='24', days='30')
        t = txt('#out')
        chk('Ageing: packed 3 days ago is listed, the fresh one (2 h) is not', 'RP-OLD-WIP-1' in t and 'RP-OLD-WIP-2' not in t, t[:200].replace('\n', ' '))
        chk('Ageing: FG for 40 days is listed, the 4-day one is not', 'RP-OLD-FG-1' in t and 'RP-NEW-FG-1' not in t)
        chk('Ageing shows waiting time in days and hours', '3 d 2 h' in t, t[:300].replace('\n', ' '))
        show('aging', hrs='6', days='7')
        t = txt('#out')
        chk('Ageing thresholds change the lists (6 h: still 1 old; 7 d: still the 40-day box only)', 'RP-OLD-WIP-2' not in t and 'RP-OLD-FG-1' in t and 'RP-NEW-FG-1' not in t)
        with pg.expect_download() as dl: pg.click('#xlsx')
        wb = xl(dl.value)
        chk('Ageing Excel has two sheets with Box ID, qty, waiting days', wb.sheetnames == ['Packed, not received in FG', 'In FG for a long time'] and list(wb.worksheets[0].iter_rows(values_only=True))[1][0] == 'RP-OLD-WIP-1' and abs(list(wb.worksheets[0].iter_rows(values_only=True))[1][5] - 3.1) < 0.2, wb.sheetnames)
        pg.click('a:has-text("RP-OLD-FG-1")'); wait('[data-tab="history"].on'); settle()
        chk('Clicking a Box ID in Ageing opens its history', 'RP-OLD-FG-1' in txt('#out') and 'Received in FG' in txt('#out'))

        # ---- Voids
        show('voids', **{'from': '2026-01-01', 'to': '2026-01-31'})
        r = rows()
        t = txt('#out')
        chk('Voids: 2 boxes voided (50 + 20 = 70 NOS) and 1 slip void (30 NOS)', '2\nboxes voided (70 NOS)' in t and '1\nboxes put back in FG' in t, t[:200].replace('\n', ' '))
        chk('Voids list: reasons and the admin sees who did it', any('damaged in store' in ' '.join(x) and 'Bhushan' in ' '.join(x) for x in r) and any('SL-X: wrong party' in ' '.join(x) for x in r) and len(r) == 3, r)

        # ---- Box history
        show('history', box='RP-260110-00002')
        t = txt('#out')
        chk('Box history: status, part, then the 4 steps in order', 'RP-260110-00002' in t and 'Opening stock' in t and t.index('Opening stock') < t.index('Dispatched') < t.index('Slip voided, box back in FG'), t[:300].replace('\n', ' '))
        chk('Box history: shows 4 rows with the slip void reason', len(rows()) == 4 and 'SL-X: wrong party' in txt('#out'))
        chk('Box history links to the packing slip', pg.query_selector('a[href="#/slips?slip=SL-Y"]') is not None)
        show('history', box='3')
        chk('Box history: last digits are enough', 'RP-260110-00003' in txt('#out') and 'Box voided' in txt('#out'), txt('#out')[:150])
        show('history', box='NOPE-1')
        chk('Box history: unknown box -> clear message', 'No box' in txt('#out') and 'NOPE-1' in txt('#out'))
        show('history', box='')
        chk('Box history: empty input -> hint, no error', 'Type or paste a Box ID' in txt('#out'))
        go('register'); wait('#out table')
        pg.click('a[href="#/reports?tab=history&box=RP-OLD-FG-1"]'); wait('[data-tab="history"].on'); settle()
        chk('Box register: Box ID links to the history of that box', 'RP-OLD-FG-1' in txt('#out') and pg.input_value('#box') == 'RP-OLD-FG-1')

        # ---- Per-date lists (the original reports) still work
        go('reports'); wait('[data-tab="summary"].on'); settle()
        show('detail', **{'from': '2026-01-01', 'to': '2026-12-31', 'r': 'inw'})
        chk('Per-date list "FG inward": TOTAL row and the detail table', 'TOTAL' in txt('#out') and 'Detail' in txt('#out'))
        with pg.expect_download() as dl: pg.click('#csv')
        chk('Per-date list CSV keeps its old file name', dl.value.suggested_filename.startswith('inward_by_date-2026-01-01-to-2026-12-31'), dl.value.suggested_filename)

        # ---- Month-end workbook
        pg.click('[data-tab="summary"]'); settle()
        pg.fill('#from', '2026-01-09'); pg.fill('#to', '2026-01-14')
        with pg.expect_download() as dl: pg.click('#book')
        wb = xl(dl.value)
        names = wb.sheetnames
        chk('Month-end workbook: 9 sheets in a sensible order', names == ['Day summary', 'Stock ledger', 'Stock on 14.01.2026', 'Assembly out per date', 'FG inward per date', 'Dispatch per date', 'Voids', 'Packed, not received in FG', 'In FG for a long time'], names)
        chk('Month-end workbook: file name carries the dates', dl.value.suggested_filename == 'radiance-reports-2026-01-09-to-2026-01-14.xlsx', dl.value.suggested_filename)
        led = list(wb['Stock ledger'].iter_rows(values_only=True))
        chk('Month-end workbook: ledger sheet has the 4 movement days + TOTAL', len(led) == 6 and led[-1][0] == 'TOTAL' and led[1][1] == '5015855', led[:2])
        ag = list(wb['Packed, not received in FG'].iter_rows(values_only=True))
        chk('Month-end workbook: ageing sheets list EVERY waiting box (thresholds off)', any(x[0] == 'RP-OLD-WIP-2' for x in ag), [x[0] for x in ag])

        # ---- Store role: can read reports, sees no names in Voids
        pg.click('#signout'); wait('#lf'); pg.fill('#em', 'store@x.com'); pg.fill('#pw', 'secret'); pg.click('#go'); wait('.top nav')
        go('reports'); wait('[data-tab="summary"].on'); settle()
        show('summary', **{'from': '2026-01-09', 'to': '2026-01-14'})
        chk('Store role can read the Day summary', len(rows()) == 7)
        show('voids', **{'from': '2026-01-01', 'to': '2026-01-31'})
        r = rows()
        chk('Store role sees the voids but not who did them', len(r) == 3 and all('Bhushan' not in ' '.join(x) for x in r), r)

        # ---- Deep link
        go('reports?tab=ledger'); wait('[data-tab="ledger"].on'); settle()
        chk('Deep link #/reports?tab=ledger opens that tab', pg.query_selector('[data-tab="ledger"].on') is not None)
        if SHOTS:   # phone width
            pg.set_viewport_size({'width': 390, 'height': 844})
            for tab, extra in (('summary', ''), ('ledger', ''), ('ason', ''), ('aging', ''), ('voids', ''), ('history', '&box=RP-260110-00002'), ('detail', '')):
                go(f'reports?tab={tab}{extra}'); wait(f'[data-tab="{tab}"].on'); settle()
                if tab != 'history': pg.click('#show'); settle()
                pg.screenshot(path=os.path.join(SHOTS, f'phone-{tab}.png'), full_page=True)
        br.close()
finally:
    srv.terminate()

chk('no page errors or console errors', not errors, errors[:3])
print(f"\n{sum(results)}/{len(results)} passed")
sys.exit(0 if all(results) else 1)
