"""FG inward scan page, tested with a FAKE CAMERA: Chromium is fed a video of real printed-label images
(rendered by the app's own label code, then rotated / tilted / blurred / noisy) and must read them with the app's decoder.
Usage: python3 tests/t_scan.py <repo root>
Runs against the mock Supabase and serves web/ with the real Content-Security-Policy."""
import sys, os, time, subprocess, json, urllib.request
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import mock_supabase as M
import numpy as np, cv2
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

# ---- data: two boxes waiting at the store, one already received, one voided, one more for typing
M.DB['profiles']['u-new'] = dict(user_id='u-new', full_name='Viewer', role='assembly', active=True)
A = M.new_box('5017886', 'BRACKET RH', 200, 'WIP-PACKED', 'LABEL', 'u-admin', '9E2602C', M.today(), 'PP-1', 'T-1', 'MS. PATIL')
B = M.new_box('5011769', 'COVER ASSEMBLY LH', 120, 'WIP-PACKED', 'LABEL', 'u-admin', '9E2602D', M.today(), 'PP-2', 'T-2', 'MS. PATIL')
C = M.new_box('5017886', 'BRACKET RH', 200, 'FG-RECEIVED', 'LABEL', 'u-admin', '9E2602C', M.today(), 'PP-1', 'T-1', 'MS. PATIL')
V = M.new_box('5017886', 'BRACKET RH', 200, 'WIP-PACKED', 'LABEL', 'u-admin', '9E2602C', M.today(), 'PP-1', 'T-1', 'MS. PATIL'); V['status'] = 'VOID'
D = M.new_box('5017886', 'BRACKET RH', 50, 'WIP-PACKED', 'LABEL', 'u-admin', '9E2602C', M.today(), 'PP-1', 'T-1', 'MS. PATIL')
C['fg_by'] = 'u-admin'

try:
    with sync_playwright() as p:
        # ---------- 1. render the real labels (and a stranger QR) to images
        br0 = p.chromium.launch(); ctx0 = br0.new_context(device_scale_factor=3, viewport={'width': 900, 'height': 1000}); pg0 = ctx0.new_page()
        pg0.goto(BASE); pg0.wait_for_selector('#lf')
        pg0.evaluate("""async (rows) => { const L = await import('./js/labels.js'); const Q = await import('./js/qr.js');
            const d = document.createElement('div'); d.id = 'lab'; d.style.cssText = 'position:fixed;inset:0;background:#fff;z-index:99;padding:10px';
            d.innerHTML = L.labelsHtml(rows) + '<div id="alien" style="width:300px;padding:10px;background:#fff">' + Q.qrSvg('https://example.com/promo?x=1', 3) + '</div>';
            document.body.appendChild(d); L.fitLabels(d); document.querySelectorAll('#lab .lb').forEach((e) => { e.style.marginBottom = '10px'; }); document.querySelector('#alien svg').style.width = '260px'; }""",
                     [dict(box_id=b['box_id'], part_no=b['part_no'], part_name=b['part_name'], qty=b['qty'], lot=b['lot'], label_date=b['label_date'], qa_sign=b['qa_sign'], pp_box_code=b['pp_box_code'], tray_no=b['tray_no']) for b in (A, B)])
        shots = {}
        for name, el in (('A', pg0.query_selector_all('#lab .lb')[0]), ('B', pg0.query_selector_all('#lab .lb')[1]), ('X', pg0.query_selector('#alien'))):
            path = os.path.join(OUT, f'cam_{name}.png'); el.screenshot(path=path); shots[name] = cv2.imread(path)
        br0.close()

        # ---------- 2. build the fake camera video (y4m): blank, A, blank, B, blank, stranger QR, blank, A again
        W, H, FPS = 1280, 720, 10
        rng = np.random.default_rng(7)
        def scene(img, width, angle, tilt, shift):
            bg = np.full((H, W, 3), 150, np.uint8); bg += rng.integers(0, 14, (H, W, 3), dtype=np.uint8)
            if img is not None:
                h0, w0 = img.shape[:2]; sc = width / w0; im = cv2.resize(img, (int(w0 * sc), int(h0 * sc)), interpolation=cv2.INTER_AREA)
                h, w = im.shape[:2]
                src = np.float32([[0, 0], [w, 0], [w, h], [0, h]])
                dst = np.float32([[0, 0], [w, tilt], [w, h - tilt], [0, h]])
                M_ = cv2.getPerspectiveTransform(src, dst)
                R = cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1.0)
                R3 = np.vstack([R, [0, 0, 1]]) @ M_
                warped = cv2.warpPerspective(im, R3, (W, H), flags=cv2.INTER_LINEAR, borderValue=(0, 0, 0))
                mask = cv2.warpPerspective(np.full((h, w), 255, np.uint8), R3, (W, H))
                M2 = np.float32([[1, 0, W / 2 - w / 2 + shift[0]], [0, 1, H / 2 - h / 2 + shift[1]]])
                warped = cv2.warpAffine(warped, M2, (W, H)); mask = cv2.warpAffine(mask, M2, (W, H))
                bg = np.where(mask[..., None] > 0, warped, bg)
            bg = cv2.GaussianBlur(bg, (0, 0), 0.9)
            return np.clip(bg.astype(np.int16) + rng.normal(0, 5, bg.shape), 0, 255).astype(np.uint8)
        def frames(img, n, **kw):
            return [scene(img, **kw) for _ in range(n)]
        seq = (frames(None, 20, width=0, angle=0, tilt=0, shift=(0, 0)) + frames(shots['A'], 40, width=760, angle=4, tilt=0, shift=(0, 0))
               + frames(None, 25, width=0, angle=0, tilt=0, shift=(0, 0)) + frames(shots['B'], 40, width=720, angle=-6, tilt=14, shift=(10, -8))
               + frames(None, 25, width=0, angle=0, tilt=0, shift=(0, 0)) + frames(shots['X'], 40, width=420, angle=3, tilt=0, shift=(0, 0))
               + frames(None, 25, width=0, angle=0, tilt=0, shift=(0, 0)) + frames(shots['A'], 40, width=760, angle=-3, tilt=0, shift=(0, 0))
               + frames(None, 60, width=0, angle=0, tilt=0, shift=(0, 0)))
        y4m = os.path.join(OUT, 'fake_camera.y4m')
        with open(y4m, 'wb') as f:
            f.write(f'YUV4MPEG2 W{W} H{H} F{FPS}:1 Ip A1:1 C420jpeg\n'.encode())
            for fr in seq:
                f.write(b'FRAME\n'); f.write(cv2.cvtColor(fr, cv2.COLOR_BGR2YUV_I420).tobytes())
        cv2.imwrite(os.path.join(OUT, 'cam_frame_B.jpg'), seq[20 + 40 + 25 + 10]); cv2.imwrite(os.path.join(OUT, 'cam_frame_X.jpg'), seq[20 + 40 + 25 + 40 + 25 + 10])

        # ---------- 3. store person scans with the fake camera
        br = p.chromium.launch(args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', f'--use-file-for-fake-video-capture={y4m}'])
        ctx = br.new_context(viewport={'width': 420, 'height': 860}, permissions=['camera']); pg = ctx.new_page()
        pg.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
        pg.on('console', lambda m: errors.append('console: ' + m.text) if m.type == 'error' and 'net::ERR' not in m.text and 'Failed to load resource' not in m.text else None)
        go = lambda h: pg.evaluate(f"location.hash='#/{h}'")
        txt = lambda sel='main': pg.inner_text(sel)

        pg.goto(BASE); pg.wait_for_selector('#lf'); pg.fill('#em', 'store@x.com'); pg.fill('#pw', 'secret'); pg.click('#go'); pg.wait_for_selector('.top nav')
        go('inward'); pg.wait_for_selector('#start')
        chk('FG inward page opens for the store role', 'FG inward' in txt('h1'))
        chk('in-transit count = boxes packed but not received (A, B, D)', pg.inner_text('#n-transit') == '3', pg.inner_text('#n-transit'))
        chk('empty list says no scans yet', 'No scans yet' in txt())
        pg.fill('#rack', 'R-12')

        seen = []; stop = {'v': False}
        def snap():
            r = pg.evaluate("(() => { const e = document.getElementById('result'); return e ? [e.className, e.innerText.replace(/\\s+/g,' ')] : null })()")
            if r and (not seen or seen[-1] != r): seen.append(r)
        pg.click('#start'); t0 = time.time()
        pg.wait_for_selector('#stop:not([hidden])', timeout=10000)
        chk('camera started (stop button shown, video message hidden)', pg.is_hidden('#vidmsg') and pg.is_visible('#stop'))
        rec = lambda: [x for x in seen if 'result ok' in x[0] or 'result bad' in x[0]]
        while time.time() - t0 < 40:
            snap()
            if len([1 for (f, a) in M.DB['log'] if f == 'receive_box']) >= 3 and any('Not a Radiance' in x[1] for x in seen): break
            time.sleep(0.08)
        time.sleep(0.6); snap()
        rpcs = [a['p_box_id'] for (f, a) in M.DB['log'] if f == 'receive_box']
        print('   results seen:', [(c.split()[-1], t[:70]) for c, t in rec()])
        chk('label A read by camera and received once (held 4 s, not scanned twice)', rpcs[:1] == [A['box_id']], rpcs)
        chk('label B (tilted, rotated) read by camera', rpcs[1:2] == [B['box_id']], rpcs)
        chk('A and B are FG-RECEIVED in the register, with rack and user', A['status'] == 'FG-RECEIVED' and B['status'] == 'FG-RECEIVED' and A['rack'] == 'R-12' and A['fg_by'] == 'u-store')
        chk('green result shows part no and qty', any('result ok' in c and '5017886' in t and '200 NOS' in t and 'BRACKET RH' in t for c, t in seen), [t for c, t in seen if 'ok' in c][:1])
        chk('stranger QR (not a Radiance label) -> red message, no request sent', any('result bad' in c and 'Not a Radiance box label' in t for c, t in seen) and all(x.startswith('RP-') for x in rpcs))
        chk('A shown again later -> red "already FG-RECEIVED"', any('result bad' in c and 'already FG-RECEIVED' in t for c, t in seen), [t for c, t in seen if 'bad' in c])
        pg.click('#stop'); time.sleep(0.3)
        chk('stop button turns the camera off', pg.is_visible('#start') and pg.is_hidden('#stop'))
        chk('in-transit count dropped to 1 (D left)', pg.inner_text('#n-transit') == '1', pg.inner_text('#n-transit'))
        rows = pg.query_selector_all('#list tbody tr')
        chk('last-scans list shows A and B, newest first', len(rows) == 2 and B['box_id'] in rows[0].inner_text() and A['box_id'] in rows[1].inner_text() and 'R-12' in rows[0].inner_text())
        pg.screenshot(path=os.path.join(OUT, 'inward_phone.png'), full_page=True)

        # typed fallback
        n0 = len(M.DB['log'])
        pg.fill('#typed', D['box_id'].lower()); pg.click('#typedgo'); pg.wait_for_selector('#result.ok')
        chk('typed Box ID (lower case) is received', D['status'] == 'FG-RECEIVED' and D['rack'] == 'R-12' and pg.inner_text('#n-transit') == '0')
        pg.fill('#typed', 'RP-261101-99999'); pg.click('#typedgo'); pg.wait_for_selector('#result.bad')
        chk('unknown Box ID -> "not in register"', 'not in register' in txt('#result'), txt('#result'))
        pg.fill('#typed', V['box_id']); pg.click('#typedgo'); time.sleep(0.4)
        chk('voided box -> "already VOID"', 'already VOID' in txt('#result'), txt('#result'))
        pg.fill('#typed', 'hello'); pg.click('#typedgo'); time.sleep(0.3)
        chk('typed garbage -> "Not a Radiance box label", nothing sent', 'Not a Radiance box label' in txt('#result') and len([1 for (f, a) in M.DB['log'][n0:] if f == 'receive_box']) == 3)
        pg.fill('#typed', C['box_id']); pg.click('#typedgo'); time.sleep(0.4)
        chk('already received box -> red with date', 'already FG-RECEIVED' in txt('#result'))

        # rack remembered
        pg.reload(); pg.wait_for_selector('#rack')
        chk('rack is remembered after reload', pg.input_value('#rack') == 'R-12')
        rows = pg.query_selector_all('#list tbody tr')
        chk('list is loaded from the database after reload (3 rows: D, B, A)', len(rows) == 3, len(rows))

        # no connection
        pg.route('**/rest/v1/rpc/receive_box', lambda r: r.abort())
        pg.fill('#typed', 'RP-261101-00001'); pg.click('#typedgo'); pg.wait_for_selector('#result.bad')
        chk('no connection -> says NOT saved', 'NOT saved' in txt('#result'), txt('#result'))
        pg.unroute('**/rest/v1/rpc/receive_box')

        # a role that may not receive
        pg.click('#signout'); pg.wait_for_selector('#lf'); pg.fill('#em', 'new@x.com'); pg.fill('#pw', 'secret'); pg.click('#go'); pg.wait_for_selector('.top nav')
        nav = [a.inner_text() for a in pg.query_selector_all('.top nav a')]
        chk('assembly role has no FG inward page', 'FG inward' not in nav, nav)
        go('inward'); pg.wait_for_selector('.stat'); chk('assembly role opening #/inward lands on Home', 'Today' in txt('h1'))
        # admin may use it
        pg.click('#signout'); pg.wait_for_selector('#lf'); pg.fill('#em', 'admin@x.com'); pg.fill('#pw', 'secret'); pg.click('#go'); pg.wait_for_selector('.top nav')
        go('inward'); pg.wait_for_selector('#start'); chk('admin can open FG inward', 'FG inward' in txt('h1'))
        br.close()

        # ---------- 4. camera refused -> clear message, typing still possible
        br2 = p.chromium.launch(); ctx2 = br2.new_context(viewport={'width': 420, 'height': 860}); pg2 = ctx2.new_page()
        pg2.goto(BASE); pg2.wait_for_selector('#lf'); pg2.fill('#em', 'store@x.com'); pg2.fill('#pw', 'secret'); pg2.click('#go'); pg2.wait_for_selector('.top nav')
        pg2.evaluate("location.hash='#/inward'"); pg2.wait_for_selector('#start'); pg2.click('#start'); pg2.wait_for_selector('#result.bad', timeout=10000)
        chk('camera not allowed -> red message, start button back, typing form still there', ('Camera' in pg2.inner_text('#result') or 'camera' in pg2.inner_text('#result')) and pg2.is_visible('#start') and pg2.is_visible('#typed'), pg2.inner_text('#result'))
        br2.close()

    # ---------- 5. install-on-phone files are served
    for path, ctype in (('manifest.webmanifest', 'json'), ('icons/icon-192.png', 'png'), ('icons/icon-512.png', 'png'), ('icons/apple-touch-icon.png', 'png')):
        try:
            r = urllib.request.urlopen('http://127.0.0.1:8765/web/' + path); ok = r.status == 200
        except Exception as e:
            ok = False
        chk('served: ' + path, ok)
    man = json.load(open(os.path.join(S, 'web', 'manifest.webmanifest')))
    chk('manifest is installable (name, start_url, standalone, 192 + 512 icons)', man['display'] == 'standalone' and man['start_url'] and {i['sizes'] for i in man['icons']} >= {'192x192', '512x512'})
    chk('no JavaScript / CSP errors in the browser console', not errors, errors[:5])
finally:
    srv.terminate()
print(f'\n{sum(results)}/{len(results)} checks passed')
