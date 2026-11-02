"""FG outward + packing slip, tested end to end with a FAKE CAMERA and the mock Supabase.
Usage: python3 tests/t_outward.py <repo root>
Checks: camera scan of real label images, FIFO warning, rules (not received / already dispatched / unknown), draft survives reload,
create slip (all-or-nothing), PDF content (read back with pdftotext), Slips list + search, void by admin, role gating."""
import sys, os, time, subprocess, json, re
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import mock_supabase as M
import fakecam as FC
import numpy as np
from playwright.sync_api import sync_playwright

S = os.path.abspath(sys.argv[1])
OUT = os.path.join(S, 'tests', 'out'); os.makedirs(OUT, exist_ok=True)
BASE = 'http://127.0.0.1:8765/web/?api=http://127.0.0.1:8766'
results = []
def chk(name, cond, extra=''):
    results.append(bool(cond)); print(('PASS ' if cond else 'FAIL ') + name + (f'  [{extra}]' if extra else ''))

srv = subprocess.Popen([sys.executable, os.path.join(HERE, 'serve.py'), S, '8765', 'http://127.0.0.1:8766'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
mock = M.serve(8766); time.sleep(1)
errors = []
def wait_js(pg, expr, timeout=15):
    end = time.time() + timeout
    while time.time() < end:
        if pg.evaluate(expr): return
        time.sleep(0.1)
    raise TimeoutError('condition not met: ' + expr)
def pdf_text(path):
    return subprocess.run(['pdftotext', '-layout', path, '-'], capture_output=True, text=True).stdout

def box(part, name, qty, status, pp='', tray=''):
    b = M.new_box(part, name, qty, status, 'LABEL', 'u-admin', '9E2602C', M.today(), pp, tray, 'MS. PATIL')
    if status == 'FG-RECEIVED': b['fg_by'] = 'u-store'
    return b
A1 = box('5017886', 'BRACKET RH', 200, 'FG-RECEIVED', 'PP-12', 'T-7')      # oldest of the part
A2 = box('5017886', 'BRACKET RH', 200, 'FG-RECEIVED', 'PP-12', 'T-7')
B1 = box('5011769', 'COVER ASSEMBLY LH', 120, 'FG-RECEIVED')
W1 = box('5011769', 'COVER ASSEMBLY LH', 120, 'WIP-PACKED')                  # not received yet
D1 = box('5017886', 'BRACKET RH', 200, 'FG-RECEIVED'); M.DB['slips']['SL-261030-001'] = dict(slip_no='SL-261030-001', party='OLD', created_at='2026-10-30T05:00:00+00:00', voided_at=None)
D1.update(status='DISPATCHED', slip_no='SL-261030-001')
X1 = box('5011769', 'COVER ASSEMBLY LH', 120, 'FG-RECEIVED')                # used for the "someone else dispatched it" case
M.DB['parties']['FFPL'] = dict(name='FFPL', location='Nandur', transport='XYZ', disp_exe='X', driver_name='RAMESH', driver_mob='99001')

try:
    with sync_playwright() as p:
        br0 = p.chromium.launch()
        shots = FC.render_label_shots(br0, BASE, [A1, A2, B1, W1], OUT); br0.close()
        rng = np.random.default_rng(11)
        blank = lambda n: [FC.scene(rng, None, 0) for _ in range(n)]
        lab = lambda b, n, **kw: [FC.scene(rng, shots[b['box_id']], **kw) for _ in range(n)]
        seq = (blank(15) + lab(A2, 30, width=760, angle=3) + blank(25) + lab(A1, 30, width=740, angle=-4, tilt=10) + blank(25) + lab(B1, 30, width=760, angle=2)
               + blank(25) + lab(W1, 30, width=750, angle=-2) + blank(120))
        y4m = os.path.join(OUT, 'fake_outward.y4m'); FC.write_y4m(y4m, seq)

        br = p.chromium.launch(args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', f'--use-file-for-fake-video-capture={y4m}'])
        ctx = br.new_context(viewport={'width': 390, 'height': 844}, permissions=['camera'], accept_downloads=True); pg = ctx.new_page()
        pg.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
        pg.on('console', lambda m: errors.append('console: ' + m.text) if m.type == 'error' and 'net::ERR' not in m.text and 'Failed to load resource' not in m.text else None)
        dlg = {'text': 'wrong truck', 'accept': True, 'seen': []}
        def on_dialog(d):
            dlg['seen'].append((d.type, d.message)); d.accept(dlg['text']) if dlg['accept'] else d.dismiss()
        pg.on('dialog', on_dialog)
        go = lambda h: pg.evaluate(f"location.hash='#/{h}'")
        txt = lambda sel='main': pg.inner_text(sel)
        login = lambda email: (pg.wait_for_selector('#lf'), pg.fill('#em', email), pg.fill('#pw', 'secret'), pg.click('#go'), pg.wait_for_selector('.top nav'))

        pg.goto(BASE); login('fg@x.com')
        nav = [a.inner_text() for a in pg.query_selector_all('.top nav a')]
        chk('FG store role sees inward AND outward', nav == ['Home', 'FG inward', 'FG outward', 'Slips', 'Box register', 'Reports'], nav)
        go('outward'); pg.wait_for_selector('#f_party')
        chk('outward page opens, create button disabled when empty', pg.is_disabled('#create'))

        # party suggestion fills the rest
        pg.fill('#f_party', 'FFPL'); pg.dispatch_event('#f_party', 'change')
        chk('known party fills location, transport, disp.exe, driver', pg.input_value('#f_location') == 'Nandur' and pg.input_value('#f_driver_name') == 'RAMESH' and pg.input_value('#f_driver_mob') == '99001')
        pg.fill('#f_vehicle', 'MH12AB1234'); pg.fill('#f_inv_no', 'INV-77'); pg.fill('#f_lr_no', 'LR9')

        # camera: A2 (older A1 still in stock -> FIFO warn), A1, B1, W1 (not received)
        seen = []
        def snap():
            r = pg.evaluate("(() => { const e = document.getElementById('result'); return e ? [e.className, e.innerText.replace(/\\s+/g,' ')] : null })()")
            if r and (not seen or seen[-1] != r): seen.append(r)
        pg.click('#start'); pg.wait_for_selector('#stop:not([hidden])', timeout=10000); t0 = time.time()
        while time.time() - t0 < 45:
            snap()
            if pg.inner_text('#n-boxes') == '3' and any('not yet received' in t for c, t in seen): break
            time.sleep(0.08)
        time.sleep(0.5); snap()
        print('   results seen:', [(c.split()[-1], t[:80]) for c, t in seen])
        chk('3 boxes scanned by camera, 520 NOS', pg.inner_text('#n-boxes') == '3' and pg.inner_text('#n-qty') == '520', (pg.inner_text('#n-boxes'), pg.inner_text('#n-qty')))
        chk('older box still in stock -> amber FIFO warning (box still added)', any('result warn' in c and 'FIFO' in t and A1['box_id'] in t for c, t in seen), [t for c, t in seen if 'warn' in c])
        chk('box not yet received in FG -> red, not added', any('result bad' in c and 'not yet received' in t for c, t in seen))
        chk('each box was checked once (no repeat requests while held)', len([1 for (f, a) in M.DB['log'] if f == 'check_box_for_slip' and a['p_box_id'] == A2['box_id']]) == 1)
        pg.click('#stop')
        chk('summary groups by part: 5017886 x2 = 400, 5011769 x1 = 120', '400' in txt('#list') and '120' in txt('#list') and '520' in txt('#list'))

        # typed rules
        for bid, want in ((D1['box_id'], 'already dispatched on slip SL-261030-001'), ('RP-261101-99999', 'not in register'), (A1['box_id'], 'Already on this slip'), ('hello', 'Not a Radiance box label')):
            pg.fill('#typed', bid); pg.click('#typedgo'); time.sleep(0.35)
            chk(f'typed {bid[:16]} -> {want}', want in txt('#result') and 'result bad' in pg.get_attribute('#result', 'class'), txt('#result'))
        chk('rejected boxes did not change the slip', pg.inner_text('#n-boxes') == '3')

        # draft survives a reload
        pg.reload(); pg.wait_for_selector('#f_party')
        chk('draft survives reload (party, vehicle, 3 boxes)', pg.input_value('#f_party') == 'FFPL' and pg.input_value('#f_vehicle') == 'MH12AB1234' and pg.inner_text('#n-boxes') == '3')
        pg.click('summary'); pg.click(f'[data-rm="{A2["box_id"]}"]'); time.sleep(0.2)
        chk('remove one box -> 2 boxes, 320 NOS', pg.inner_text('#n-boxes') == '2' and pg.inner_text('#n-qty') == '320')
        pg.fill('#typed', A2['box_id']); pg.click('#typedgo'); time.sleep(0.4)
        chk('typed box added back -> 3 boxes (FIFO warning not shown: A1 already on slip)', pg.inner_text('#n-boxes') == '3' and 'result ok' in pg.get_attribute('#result', 'class'), pg.get_attribute('#result', 'class'))
        pg.screenshot(path=os.path.join(OUT, 'outward_phone.png'), full_page=True)

        # one more box that "someone else" dispatches meanwhile -> create fails safely and takes it off
        pg.fill('#typed', X1['box_id']); pg.click('#typedgo'); time.sleep(0.4)
        chk('4th box added', pg.inner_text('#n-boxes') == '4')
        X1['status'] = 'DISPATCHED'; X1['slip_no'] = 'SL-261030-001'
        pg.click('#create'); time.sleep(0.6)
        chk('create confirm shown with the totals', any('Dispatch 4 boxes (640 NOS) to FFPL' in m for t, m in dlg['seen']), dlg['seen'][-1:])
        chk('box taken by another slip -> red message, only that box removed, nothing dispatched', 'not available for dispatch' in txt('#problem') and pg.inner_text('#n-boxes') == '3' and A1['status'] == 'FG-RECEIVED' and not [s for s in M.DB['slips'] if s != 'SL-261030-001'], txt('#problem'))

        # no connection on create
        pg.route('**/rest/v1/rpc/create_slip', lambda r: r.abort())
        pg.click('#create'); time.sleep(0.8)
        chk('no connection on create -> tells you to look under Slips before retrying', 'under Slips' in txt('#problem') and not [s for s in M.DB['slips'] if s != 'SL-261030-001'], txt('#problem'))
        pg.unroute('**/rest/v1/rpc/create_slip')

        # create for real
        pg.click('#create'); pg.wait_for_selector('.donecard', timeout=10000)
        new = [s for s in M.DB['slips'] if s != 'SL-261030-001']
        slip_no = new[0] if new else ''
        chk('slip created: number, boxes and status', len(new) == 1 and re.match(r'SL-\d{6}-001$', slip_no) and all(b['status'] == 'DISPATCHED' and b['slip_no'] == slip_no for b in (A1, A2, B1)), new)
        chk('success card shows slip, 3 boxes, 520 NOS, party', slip_no in txt('.donecard') and '3 boxes' in txt('.donecard') and '520' in txt('.donecard') and 'FFPL' in txt('.donecard'))
        with pg.expect_download() as dl: pg.click('#dl')
        f1 = os.path.join(OUT, 'slip_from_outward.pdf'); dl.value.save_as(f1)
        t1 = pdf_text(f1)
        chk('PDF file name is the slip number', dl.value.suggested_filename == slip_no + '.pdf', dl.value.suggested_filename)
        chk('PDF has party, vehicle, invoice, LR, driver, slip no', all(x in t1 for x in ('FFPL', 'MH12AB1234', 'INV-77', 'LR9', 'RAMESH', slip_no, 'Delivery challan cum Packing Slip', 'RADIANCE POLYMERS')), t1[:400])
        rows = [re.sub(r'\s+', ' ', l).strip() for l in t1.splitlines() if l.strip()]
        chk('PDF part lines (sorted by part): 5011769 1 box of 120; 5017886 2 boxes of 200 = 400 (4 trays)', any(re.match(r'^1 5011769 120 1 120', l) for l in rows) and any(re.match(r'^2 5017886 PP-12 T-7 4 200 2 400', l) for l in rows), [l for l in rows if l.startswith(('1 ', '2 '))][:3])
        chk('PDF totals: 3 boxes, 520 NOS', any(re.match(r'^TOTAL 4 3 520', l) for l in rows), [l for l in rows if l.startswith('TOTAL')])
        chk('PDF box list page has all 3 Box IDs', all(b['box_id'] in t1 for b in (A1, A2, B1)) and f'Box ID list for {slip_no} (3 boxes)' in t1)
        with pg.expect_download() as dl2: pg.click('#share')
        chk('Share/print falls back to download when the browser cannot share files', dl2.value.suggested_filename == slip_no + '.pdf')
        from pypdf import PdfReader
        chk('PDF is valid, 2 pages (slip + box list)', len(PdfReader(f1).pages) == 2)
        subprocess.run(['pdftoppm', '-r', '70', '-png', f1, os.path.join(OUT, 'slip_from_outward')])

        # slip draft cleared; new slip starts empty
        pg.click('#again'); pg.wait_for_selector('#f_party')
        chk('"New slip" starts empty and the saved draft is gone', pg.input_value('#f_party') == '' and pg.inner_text('#n-boxes') == '0' and pg.evaluate("localStorage.getItem('rbt.slipdraft')") is None)

        # slips list
        go('slips'); pg.wait_for_selector('#tbl table')
        chk('Slips list shows the new slip with party, invoice, boxes, qty', all(x in txt('#tbl') for x in (slip_no, 'FFPL', '520', '3')) and 'DISPATCHED' in txt('#tbl'), txt('#tbl')[:200])
        pg.fill('#s', 'ffpl'); time.sleep(0.8); chk('search by party finds it', slip_no in txt('#tbl'))
        pg.fill('#s', 'zzzz'); time.sleep(0.8); chk('search with no match -> empty message', 'No slips yet' in txt('#tbl'))
        pg.fill('#s', ''); time.sleep(0.8)
        pg.click(f'a[href="#/slips?slip={slip_no}"]'); pg.wait_for_selector('#share')
        chk('slip detail shows facts, parts and boxes; fg has no Void button', all(x in txt() for x in ('FFPL', 'MH12AB1234', 'INV-77', 'Nandur', A1['box_id'], '5011769')) and pg.query_selector('#void') is None)
        with pg.expect_download() as dl3: pg.click('#dl')
        f2 = os.path.join(OUT, 'slip_from_detail.pdf'); dl3.value.save_as(f2)
        chk('PDF from the detail page has the same content', pdf_text(f2).split('DATE:')[0] == t1.split('DATE:')[0] and all(b['box_id'] in pdf_text(f2) for b in (A1, A2, B1)))

        # inward still fine for the same login; store role cannot use outward; admin voids
        pg.click('#signout'); login('store@x.com')
        nav = [a.inner_text() for a in pg.query_selector_all('.top nav a')]
        chk('store role: inward yes, outward no (Slips and register readable)', 'FG inward' in nav and 'FG outward' not in nav and 'Slips' in nav, nav)
        go('outward'); pg.wait_for_selector('.stat'); chk('store opening #/outward lands on Home', 'Today' in txt('h1'))
        pg.click('#signout'); login('admin@x.com')
        go(f'slips?slip={slip_no}'); pg.wait_for_selector('#void')
        pg.click('#void'); wait_js(pg, "document.body.innerText.includes('VOIDED')")
        s_ = M.DB['slips'][slip_no]
        chk('admin voided the slip: boxes back to FG-RECEIVED, reason kept, slip stays on record', s_['void_reason'] == 'wrong truck' and all(b['status'] == 'FG-RECEIVED' and b['slip_no'] is None for b in (A1, A2, B1)), s_.get('void_reason'))
        chk('voided detail page says so and shows no PDF button', 'wrong truck' in txt() and pg.query_selector('#share') is None and 'boxes went back to FG stock' in txt())
        go('slips'); pg.wait_for_selector('#tbl table')
        chk('Slips list shows VOIDED with the original 3 boxes / 520', 'VOIDED' in txt('#tbl') and '520' in txt('#tbl'))
        pg.select_option('#st', 'void'); time.sleep(0.7); chk('status filter: voided only', slip_no in txt('#tbl'))
        pg.select_option('#st', 'live'); time.sleep(0.7); chk('status filter: active only excludes it', slip_no not in txt('#tbl'))
        go(f'slips?slip=SL-000000-999'); pg.wait_for_selector('.msg.bad'); chk('unknown slip -> clear message', 'Slip not found' in txt())
        br.close()

        # camera refused still lets you type
        br2 = p.chromium.launch(); c2 = br2.new_context(viewport={'width': 390, 'height': 844}); p2 = c2.new_page()
        p2.goto(BASE); p2.wait_for_selector('#lf'); p2.fill('#em', 'fg@x.com'); p2.fill('#pw', 'secret'); p2.click('#go'); p2.wait_for_selector('.top nav')
        p2.evaluate("location.hash='#/outward'"); p2.wait_for_selector('#start'); p2.click('#start'); p2.wait_for_selector('#result.bad', timeout=10000)
        chk('camera not allowed -> red message, typing still possible', p2.is_visible('#start') and p2.is_visible('#typed'), p2.inner_text('#result'))
        br2.close()
    chk('no JavaScript / CSP errors in the browser console', not errors, errors[:5])
finally:
    srv.terminate()
print(f'\n{sum(results)}/{len(results)} checks passed')
