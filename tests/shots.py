"""Takes screenshots of the main screens (iPhone size and desktop) into tests/out/shots for a visual check. Usage: python3 tests/shots.py <repo root>"""
import sys, os, time, subprocess
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import mock_supabase as M
from playwright.sync_api import sync_playwright
S = os.path.abspath(sys.argv[1]); OUT = os.path.join(S, 'tests', 'out', 'shots'); os.makedirs(OUT, exist_ok=True)
BASE = 'http://127.0.0.1:8765/web/?api=http://127.0.0.1:8766'
srv = subprocess.Popen([sys.executable, os.path.join(HERE, 'serve.py'), S, '8765', 'http://127.0.0.1:8766'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
mock = M.serve(8766); time.sleep(1)
def box(part, name, qty, status, pp='', tray=''):
    b = M.new_box(part, name, qty, status, 'LABEL', 'u-admin', '9E2602C', M.today(), pp, tray, 'MS. PATIL')
    if status == 'FG-RECEIVED': b['fg_by'] = 'u-fg'
    return b
def seed():
    global bx, wip
    M.DB['boxes'].clear(); M.DB['slips'].clear(); M.DB['seq'] = 0; M.DB['slipn'].clear()
    bx = [box('5017886', 'BRACKET RH', 200, 'FG-RECEIVED', 'PP-12', 'T-7') for _ in range(3)] + [box('5011769', 'COVER ASSEMBLY LH', 120, 'FG-RECEIVED') for _ in range(2)]
    wip = [box('5011769', 'COVER ASSEMBLY LH', 120, 'WIP-PACKED') for _ in range(2)]
M.DB['parties']['FFPL'] = dict(name='FFPL', location='Nandur', transport='XYZ', disp_exe='X', driver_name='RAMESH', driver_mob='99001')
for n, v in (('5017886', 'BRACKET RH'),): M.DB['parts'][n] = dict(part_no=n, name=v, std_qty=200, active=True)
try:
    with sync_playwright() as p:
        br = p.chromium.launch()
        for name, vp, scale in (('phone', {'width': 390, 'height': 844}, 2), ('desk', {'width': 1280, 'height': 800}, 1)):
            seed(); ctx = br.new_context(viewport=vp, device_scale_factor=scale); pg = ctx.new_page()
            shot = lambda n, full=True: pg.screenshot(path=os.path.join(OUT, f'{name}_{n}.png'), full_page=full)
            go = lambda h: pg.evaluate(f"location.hash='#/{h}'")
            pg.goto(BASE); pg.wait_for_selector('#lf'); shot('login', False)
            pg.fill('#em', 'admin@x.com'); pg.fill('#pw', 'secret'); pg.click('#go'); pg.wait_for_selector('.top nav'); pg.wait_for_selector('.stat'); shot('home')
            go('inward'); pg.wait_for_selector('#start')
            pg.fill('#typed', wip[0]['box_id']); pg.click('#typedgo'); pg.wait_for_selector('#result.ok'); shot('inward_ok')
            pg.fill('#typed', 'RP-261101-99999'); pg.click('#typedgo'); pg.wait_for_selector('#result.bad'); shot('inward_bad', False)
            go('outward'); pg.wait_for_selector('#f_party')
            pg.fill('#f_party', 'FFPL'); pg.dispatch_event('#f_party', 'change'); pg.fill('#f_vehicle', 'MH12AB1234'); pg.fill('#f_inv_no', 'INV-77')
            for b in bx[:3] + bx[4:]:
                pg.fill('#typed', b['box_id']); pg.click('#typedgo'); time.sleep(0.25)
            shot('outward_ok')
            pg.fill('#typed', bx[3]['box_id']); pg.click('#typedgo'); time.sleep(0.3); shot('outward_warn_or_ok', False)
            pg.fill('#typed', wip[1]['box_id']); pg.click('#typedgo'); time.sleep(0.3); shot('outward_bad', False)
            pg.once('dialog', lambda d: d.accept()); pg.click('#create'); pg.wait_for_selector('.donecard'); shot('outward_done')
            go('slips'); pg.wait_for_selector('#tbl table'); shot('slips')
            sl = list(M.DB['slips'])[0]; go(f'slips?slip={sl}'); pg.wait_for_selector('#share'); shot('slip_detail')
            go('print'); pg.wait_for_selector('#part'); shot('print')
            go('register'); time.sleep(0.8); shot('register')
            go('users'); time.sleep(0.8); shot('users')
            ctx.close()
        br.close()
finally:
    srv.terminate()
print(sorted(os.listdir(OUT)))
