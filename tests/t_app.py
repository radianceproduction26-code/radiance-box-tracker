"""End-to-end test of the web app in headless Chromium against the mock Supabase server.
Usage: python3 tests/t_app.py <repo root> <path to CHECKLIST_Bavare.xlsx>
Serves the web folder with the real Content-Security-Policy from web/vercel.json."""
import sys, os, re, io, json, time, subprocess
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import mock_supabase as M
import numpy as np, cv2
from openpyxl import Workbook
from playwright.sync_api import sync_playwright

S = os.path.abspath(sys.argv[1])      # repo root (served over http)
CHECKLIST = os.path.abspath(sys.argv[2])
OUT = os.path.join(S, 'tests', 'out'); os.makedirs(OUT, exist_ok=True)
BASE = 'http://127.0.0.1:8765/web/?api=http://127.0.0.1:8766'
results = []
def chk(name, cond, extra=''):
    results.append(bool(cond)); print(('PASS ' if cond else 'FAIL ') + name + (f'  [{extra}]' if extra else ''))

srv = subprocess.Popen([sys.executable, os.path.join(HERE, 'serve.py'), S, '8765', 'http://127.0.0.1:8766'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
mock = M.serve(8766); time.sleep(1)
errors = []
def wait_js(pg, expr, timeout=15):
    # page.wait_for_function() evaluates a string in the page, which the production CSP (correctly) forbids; poll with evaluate instead.
    end = time.time() + timeout
    while time.time() < end:
        if pg.evaluate(expr): return
        time.sleep(0.1)
    raise TimeoutError('condition not met: ' + expr)
try:
    with sync_playwright() as p:
        br = p.chromium.launch(); ctx = br.new_context(accept_downloads=True, viewport={'width': 1280, 'height': 900}); pg = ctx.new_page()
        pg.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
        pg.on('console', lambda m: errors.append('console: ' + m.text) if m.type == 'error' and 'net::ERR' not in m.text and 'Failed to load resource' not in m.text else None)
        dialog = {'text': 'ok', 'accept': True, 'seen': []}
        def on_dialog(d):
            dialog['seen'].append((d.type, d.message))
            d.accept(dialog['text']) if dialog['accept'] else d.dismiss()
        pg.on('dialog', on_dialog)
        pg.add_init_script("window.__prints=[]; window.print=()=>{window.__prints.push(document.getElementById('print-area').innerHTML)}")
        go = lambda h: (pg.evaluate(f"location.hash='#/{h}'"))
        txt = lambda sel='main': pg.inner_text(sel)

        # ---------------- login
        pg.goto(BASE); pg.wait_for_selector('#lf')
        chk('login page shown when signed out', 'Sign in' in txt('#app'))
        pg.fill('#em', 'admin@x.com'); pg.fill('#pw', 'wrong'); pg.click('#go'); pg.wait_for_selector('.msg.bad')
        chk('wrong password -> friendly message', 'Wrong email or password' in txt('#err'), txt('#err'))
        pg.fill('#em', 'new@x.com'); pg.fill('#pw', 'secret'); pg.click('#go'); pg.wait_for_selector('text=has no role yet')
        chk('login with no role -> "no role yet", no data', 'no role yet' in txt('#app') and not pg.query_selector('nav'))
        pg.click('#signout'); pg.wait_for_selector('#lf')
        pg.fill('#em', 'admin@x.com'); pg.fill('#pw', 'secret'); pg.click('#go'); pg.wait_for_selector('.top nav')
        nav = [a.inner_text() for a in pg.query_selector_all('.top nav a')]
        chk('admin sees every page', nav == ['Home', 'FG inward', 'FG outward', 'Slips', 'Print labels', 'Box register', 'Reports', 'Parts', 'Opening stock', 'Users'], nav)
        chk('header shows name and role', 'Bhushan · admin' in txt('.who'))
        pg.wait_for_selector('.stat'); chk('home loads with stats', 'FG stock NOS' in txt())
        chk('admin sees "Upload opening stock" button on Home', 'Opening stock not uploaded yet' in txt() and pg.query_selector('a.btn[href="#/opening"]') is not None)

        # ---------------- parts import (real CHECKLIST)
        go('parts'); pg.wait_for_selector('#file')
        pg.set_input_files('#file', CHECKLIST); pg.wait_for_selector('#imp')
        pv = txt('#prev')
        chk('preview: 177 parts / 233 pack sizes / 12 merged', '177 parts' in pv and '233 pack sizes' in pv and '12 repeated rows merged' in pv, pv[:160].replace('\n', ' '))
        pg.click('#imp'); pg.wait_for_selector('text=Imported 233 pack sizes')
        chk('database now has 177 parts + 233 pack sizes', len(M.DB['parts']) == 177 and len(M.DB['packing']) == 233, (len(M.DB['parts']), len(M.DB['packing'])))
        chk('merged duplicate keeps box code (BC00004915 / 600)', M.DB['packing'][('BC00004915', 600)]['pp_box_code'] == 'CG BOX')
        chk('part numbers stored clean (no dots/spaces)', not any(re.search(r'[.…\s]$|^\s', k) for k in M.DB['parts']))
        M.DB['packing'][('5009573', 50)]['tray_no'] = 'KEEP-ME'
        pg.set_input_files('#file', CHECKLIST); pg.wait_for_selector('#imp'); pg.click('#imp'); pg.wait_for_selector('text=Imported 233 pack sizes')
        chk('second import is idempotent, and does not wipe a saved code', len(M.DB['packing']) == 233 and M.DB['packing'][('5009573', 50)]['tray_no'] == 'KEEP-ME')
        dialog['text'] = 'sample cover'
        pg.click('button[data-edit]'); pg.wait_for_selector('text=sample cover'.upper()) if False else time.sleep(0.5)
        chk('edit part name saves in upper case', any(v['name'] == 'SAMPLE COVER' for v in M.DB['parts'].values()))

        # ---------------- print labels
        go('print'); pg.wait_for_selector('#part')
        pg.fill('#part', '5009573'); pg.dispatch_event('#part', 'change')
        chips = [c.inner_text() for c in pg.query_selector_all('#packs .chip')]
        chk('pack-size chips appear for the part', chips == ['50', '84'], chips)
        pg.click('.chip[data-std="84"]')
        pg.fill('#name', 'End plate'); pg.fill('#n', '3'); pg.fill('#last', '20'); pg.fill('#lot', 'l9')
        chk('summary shows total and PP box code', '3 label(s), total 188 NOS' in txt('#sum') and 'EP1101897' in txt('#sum'), txt('#sum'))
        chk('QA sign defaults to the logged-in name', pg.input_value('#qa') == 'Bhushan')
        pg.click('#go'); wait_js(pg, 'window.__prints.length===1')
        area = pg.inner_html('#print-area')
        ids = [b['box_id'] for b in M.DB['boxes']]
        chk('3 boxes created with RP-YYMMDD-NNNNN ids', len(ids) == 3 and all(re.fullmatch(r'RP-\d{6}-\d{5}', i) for i in ids) and ids[0].endswith('-00001'), ids)
        chk('last box is 20, others 84', [b['qty'] for b in M.DB['boxes']] == [84, 84, 20])
        chk('print area has 3 labels with all fields', area.count('class="lb"') == 3 and 'RADIANCE POLYMERS' in area and 'ACCEPTED' in area and '20 NOS' in area and 'Unique Code:- ' + ids[0] in area and '/L9' in area, '')
        d = M.today().split('-'); chk('label date shown dd.mm.yyyy', f'{d[2]}.{d[1]}.{d[0]}' in area)
        chk('part name saved upper-case on label', 'END PLATE' in area)
        chk('confirmation card shown', '3 label(s) created' in txt('#done'))
        # QR really scans: rasterise the on-page SVG and decode
        pg.add_style_tag(content='#print-area{display:block!important} #app{display:none!important}')
        qrs = pg.query_selector_all('#print-area .lb .qr svg')
        dec = cv2.QRCodeDetectorAruco(); good = 0
        for i, el in enumerate(qrs):
            png = el.screenshot(); img = cv2.imdecode(np.frombuffer(png, np.uint8), cv2.IMREAD_GRAYSCALE)
            t = dec.detectAndDecode(img)[0]; good += (t == ids[i])
        chk('every printed QR decodes to its Box ID', len(qrs) == 3 and good == 3, f'{good}/{len(qrs)}')
        clipped = pg.evaluate("[...document.querySelectorAll('#print-area .lb>div')].filter(d=>d.scrollWidth>d.clientWidth+1).map(d=>d.textContent.trim())")
        chk('no text is cut off on the printed labels', clipped == [], clipped)
        long_clip = pg.evaluate("""async () => { const L = await import('./js/labels.js'); const d = document.createElement('div'); d.id='tmp'; document.body.appendChild(d);
          d.innerHTML = L.labelsHtml([{box_id:'RP-261031-123456', part_no:'BC00004915-LONG', part_name:'FRONT COVER ASSEMBLY WITH BRACKET LH', qty:12000, lot:'9E2602C-BATCH-77', label_date:'2026-10-31', qa_sign:'MS. JAGSMITA PATIL'}]); L.fitLabels(d);
          const bad = [...d.querySelectorAll('.lb>div')].filter(x=>x.scrollWidth>x.clientWidth+1).map(x=>x.textContent.trim()); d.remove(); return bad; }""")
        chk('long part name / lot / QA name shrink instead of being cut off', long_clip == [], long_clip)
        pg.evaluate("(async () => { const L = await import('./js/labels.js'); const d = document.createElement('div'); d.id='longlab'; document.body.appendChild(d); d.innerHTML = L.labelsHtml([{box_id:'RP-261031-123456', part_no:'BC00004915-LONG', part_name:'FRONT COVER ASSEMBLY WITH BRACKET LH', qty:12000, lot:'9E2602C-BATCH-77', label_date:'2026-10-31', qa_sign:'MS. JAGSMITA PATIL'}]); L.fitLabels(d); })()")
        pg.wait_for_selector('#longlab .lb'); pg.query_selector('#longlab .lb').screenshot(path=os.path.join(OUT, 'label_long.png')); pg.evaluate("document.getElementById('longlab').remove()")
        pg.query_selector('#print-area .lb').screenshot(path=os.path.join(OUT, 'label_preview.png'))
        pg.emulate_media(media='print'); pdf = pg.pdf(prefer_css_page_size=True); pg.emulate_media(media='screen')
        open(os.path.join(OUT, 'labels.pdf'), 'wb').write(pdf)
        pages = len(re.findall(rb'/Type\s*/Page[^s]', pdf)); mb = re.search(rb'/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)', pdf)
        chk('print output: one 101.6 x 63.5 mm page per label', pages == 3 and mb and abs(float(mb.group(1)) - 288) < 1 and abs(float(mb.group(2)) - 180) < 1, f'pages={pages} box={mb.groups() if mb else None}')
        pg.add_style_tag(content='#print-area{display:none!important} #app{display:block!important}')
        n_before = len(M.DB['boxes']); pg.click('#again'); wait_js(pg, 'window.__prints.length===2')
        chk('"Print these again" reprints, creates no new boxes', len(M.DB['boxes']) == n_before and pg.evaluate('window.__prints[1]') == pg.evaluate('window.__prints[0]'))
        pg.fill('#n', '0'); pg.fill('#part', '5009573'); pg.click('#go'); time.sleep(0.4)
        chk('invalid count is blocked by the browser form (no request)', len(M.DB['boxes']) == 3)

        # ---------------- register
        go('register'); pg.wait_for_selector('#out table')
        rows = pg.query_selector_all('#out tbody tr'); chk('register lists 3 boxes', len(rows) == 3 and '3' in txt('#out').split('\n')[0])
        pg.select_option('#status', 'FG-RECEIVED'); pg.click('#f .btn'); pg.wait_for_selector('text=No boxes match')
        chk('status filter works (none in FG yet)', True)
        pg.select_option('#status', ''); pg.fill('#box', '00002'); pg.click('#f .btn'); time.sleep(0.5)
        chk('box id filter finds exactly one', len(pg.query_selector_all('#out tbody tr')) == 1 and ids[1] in txt('#out'))
        pg.fill('#box', ''); pg.fill('#part', '5009573'); pg.click('#f .btn'); time.sleep(0.5)
        chk('part filter works', len(pg.query_selector_all('#out tbody tr')) == 3)
        pg.check(f'.sel[data-id="{ids[2]}"]'); pg.click('#reprint'); wait_js(pg, 'window.__prints.length===3')
        last = pg.evaluate('window.__prints[2]'); chk('reprint ticked box prints only that label', last.count('class="lb"') == 1 and ids[2] in last)
        dialog['text'] = 'printer jam'; pg.click(f'button[data-void="{ids[0]}"]'); pg.wait_for_selector('.pill.VOID')
        chk('void works and shows VOID', M.DB['boxes'][0]['status'] == 'VOID' and ids[0] in txt('#out'))
        chk('void button gone for voided box', pg.query_selector(f'button[data-void="{ids[0]}"]') is None)
        with pg.expect_download() as dl: pg.click('#csv')
        raw = open(dl.value.path(), 'rb').read(); chk('register CSV downloads (UTF-8 BOM, header)', raw.startswith(b'\xef\xbb\xbfBox ID') and raw.count(b'\n') >= 3, raw[:40])

        # ---------------- reports + home
        go('reports'); pg.wait_for_selector('#out table')
        o = txt('#out'); chk('assembly-out per day excludes the voided box (2 boxes, 104)', 'TOTAL' in o and '104' in o and '188' not in o, o[:120].replace('\n', ' '))
        with pg.expect_download() as dl: pg.click('#csv')
        chk('report CSV downloads', dl.value.suggested_filename.startswith('assembly_out_by_date'))
        go(''); pg.wait_for_selector('.stat'); chk('home shows 104 packed NOS and 104 assembly out today', txt().count('104') >= 2)

        # ---------------- opening stock
        go('opening'); pg.wait_for_selector('#file')
        tpl = os.path.join(S, 'web', 'templates', 'opening-stock-template.xlsx')
        chk('Excel template is served and linked', pg.query_selector('a[href="templates/opening-stock-template.xlsx"][download]') is not None and pg.evaluate("fetch('templates/opening-stock-template.xlsx').then(r => r.ok && r.headers.get('content-type'))"))
        pg.set_input_files('#file', tpl); pg.wait_for_selector('.msg.warn')
        chk('empty template -> "No data rows found" message', 'No data rows found' in txt('#prev'), txt('#prev')[:80])
        from openpyxl import load_workbook
        wbt = load_workbook(tpl); wst = wbt['OPENING_STOCK']; wst.append(['5017886', 'COVER', 200, 2, 50, 'L1', '16.10.2026']); filled = os.path.join(OUT, 'tpl_filled.xlsx'); wbt.save(filled)
        pg.set_input_files('#file', filled); pg.wait_for_selector('#up')
        chk('filled template previews 3 boxes / 450 NOS (EXAMPLE sheet ignored)', '3 boxes' in txt('#prev') and '450 NOS' in txt('#prev'), txt('#prev')[:90].replace('\n', ' '))
        bad = os.path.join(OUT, 'opening_bad.csv'); open(bad, 'w').write('PART NO,PART NAME,QTY PER BOX,NO OF BOXES,LOOSE BOX QTY,LOT,DATE\n5017886,COVER,200,2,50,L1,16.10.2026\n,X,10,1,0,,\n5011769,Y,0,3,0,,\n')
        pg.set_input_files('#file', bad); pg.wait_for_selector('.msg.bad')
        chk('bad opening file: problems listed, upload button hidden', 'Row 3' in txt('#prev') and 'Row 4' in txt('#prev') and pg.query_selector('#up') is None, txt('#prev')[:140].replace('\n', ' '))
        wb = Workbook(); ws = wb.active; ws.title = 'OPENING_STOCK'
        ws.append(['PART NO', 'PART NAME', 'QTY PER BOX', 'NO OF BOXES', 'LOOSE BOX QTY', 'LOT', 'DATE'])
        ws.append(['5017886', 'COVER', 200, 2, 50, 'L1', '16.10.2026']); ws.append([' 5011769. ', 'End plate', 300, 0, 120, None, None])
        good_x = os.path.join(OUT, 'opening_good.xlsx'); wb.save(good_x)
        pg.set_input_files('#file', good_x); pg.wait_for_selector('#up')
        chk('good opening file: 4 boxes / 570 NOS previewed', '4 boxes' in txt('#prev') and '570 NOS' in txt('#prev'), txt('#prev')[:100].replace('\n', ' '))
        pg.click('#up'); pg.wait_for_selector('text=Done:')
        op = [b for b in M.DB['boxes'] if b['source'] == 'OPENING']
        chk('opening boxes are FG-RECEIVED, cleaned part, dated 16.10.2026', len(op) == 4 and all(b['status'] == 'FG-RECEIVED' for b in op) and op[0]['label_date'] == '2026-10-16' and op[3]['part_no'] == '5011769', [(b['part_no'], b['qty']) for b in op])
        go(''); pg.wait_for_selector('.stat'); go('opening'); pg.wait_for_selector('text=can only be done once')
        chk('second visit: already uploaded, no form', pg.query_selector('#file') is None)
        go(''); pg.wait_for_selector('.stat'); chk('home FG stock = 570 after opening upload', '570' in txt()); chk('Home button disappears once opening stock is done', 'Opening stock not uploaded yet' not in txt())

        # ---------------- users
        go('users'); pg.wait_for_selector('select[data-f=role]')
        chk('users page lists all logins', all(e in txt() for e in ['admin@x.com', 'store@x.com', 'new@x.com']))
        pg.fill('input[data-f=name][data-id=u-new]', 'New Guy'); pg.select_option('select[data-f=role][data-id=u-new]', 'dispatch'); pg.click('button[data-save=u-new]'); time.sleep(0.5)
        chk('assigning a role saves the profile', M.DB['profiles'].get('u-new', {}).get('role') == 'dispatch' and M.DB['profiles']['u-new']['full_name'] == 'New Guy')
        pg.select_option('select[data-f=role][data-id=u-admin]', 'viewer'); pg.click('button[data-save=u-admin]'); time.sleep(0.4)
        chk('admin cannot demote self', M.DB['profiles']['u-admin']['role'] == 'admin')

        # ---------------- token refresh + network failure
        r0 = M.STATS['refresh']; tok = pg.evaluate("JSON.parse(localStorage.getItem('rbt.session')).access_token"); M.STATS['expired'].add(tok)
        go('reports'); pg.wait_for_selector('#out table')
        chk('expired token: refreshed once, page still loads', M.STATS['refresh'] == r0 + 1 and 'TOTAL' in txt('#out'))
        pg.evaluate("(()=>{const s=JSON.parse(localStorage.getItem('rbt.session')); s.expires_at=Math.floor(Date.now()/1000)+10; localStorage.setItem('rbt.session',JSON.stringify(s));})()")
        pg.reload(); pg.wait_for_selector('.top nav'); chk('near-expiry token refreshed before the request', M.STATS['refresh'] == r0 + 2)
        pg.route('**/rest/v1/**', lambda r: r.abort()); go('register'); pg.wait_for_selector('#retry')
        chk('server unreachable -> clear message + Try again', 'Cannot reach the server' in txt(), txt()[:80])
        pg.unroute('**/rest/v1/**'); pg.click('#retry'); pg.wait_for_selector('#out table'); chk('Try again recovers', True)

        # ---------------- storeman: limited UI, server refuses
        pg.click('#signout'); pg.wait_for_selector('#lf'); pg.fill('#em', 'store@x.com'); pg.fill('#pw', 'secret'); pg.click('#go'); pg.wait_for_selector('.top nav')
        nav = [a.inner_text() for a in pg.query_selector_all('.top nav a')]
        chk('store role sees Home / FG inward / Slips / Box register / Reports', nav == ['Home', 'FG inward', 'Slips', 'Box register', 'Reports'], nav)
        go('print'); pg.wait_for_selector('.stat'); chk('store opening #/print lands on Home', 'Today' in txt('h1'))
        go('register'); pg.wait_for_selector('#out table'); chk('store has no Void buttons or tick boxes', pg.query_selector('[data-void]') is None and pg.query_selector('.sel') is None)
        res = pg.evaluate("""async () => { const api = await import('./js/api.js'); try { await api.rpc('create_boxes', {p_part_no:'X', p_part_name:'x', p_std_qty:1, p_n:1}); return 'ALLOWED'; } catch (e) { return e.message; } }""")
        chk('server refuses create_boxes for store role', 'Not allowed for your role (store)' in res, res)
        # exactly 1000 rows: the 2nd page request is 'out of range' (416) and must be treated as the end, not as an error
        n = 0
        while len(M.DB['parts']) < 1000: n += 1; M.DB['parts'][f'FILL{n}'] = dict(part_no=f'FILL{n}', name='', std_qty=None, active=True)
        got = pg.evaluate("""async () => { const api = await import('./js/api.js'); try { return (await api.selectAll('parts', 'select=part_no&order=part_no')).length; } catch (e) { return 'ERR ' + e.message; } }""")
        chk('reading exactly 1000 rows works (416 on the next page is the end)', got == 1000, got)
        br.close()
finally:
    srv.terminate()

chk('no JavaScript errors in the browser console', not errors, errors[:3])
print(f'\n{sum(results)}/{len(results)} checks passed')
sys.exit(0 if all(results) else 1)
