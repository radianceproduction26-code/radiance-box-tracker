"""Phase 6 tests: FG inward scans with no signal are kept on the phone and sent later.
Usage: python3 tests/t_offline.py <repo root>      (SHOTS=<folder> also saves phone screenshots)
Runs the web app in headless Chromium (phone-sized, real Content-Security-Policy) against the stand-in Supabase server, whose receive_box
follows 007_offline_scan_time.sql (the real function was tested on the live project in a rolled-back transaction)."""
import sys, os, time, subprocess, json
from datetime import datetime, timedelta, timezone
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import mock_supabase as M
from playwright.sync_api import sync_playwright

S = os.path.abspath(sys.argv[1])
SHOTS = os.environ.get('SHOTS')
if SHOTS: os.makedirs(SHOTS, exist_ok=True)
BASE = 'http://127.0.0.1:8765/web/?api=http://127.0.0.1:8766&scanTimeout=1500'   # 1.5 s timeout so hanging connections are quick to test
results = []
def chk(name, cond, extra=''):
    results.append(bool(cond)); print(('PASS ' if cond else 'FAIL ') + name + (f'  [{extra}]' if extra else ''))

def mk(part='5017886', name='BRACKET RH', qty=100, age_min=180):
    """A packed box whose label was printed age_min minutes ago."""
    b = M.new_box(part, name, qty, 'WIP-PACKED', 'LABEL', 'u-admin', 'L1', M.today(), 'PP-1', 'T-1', 'QA')
    b['created_at'] = (datetime.now(timezone.utc) - timedelta(minutes=age_min)).isoformat()
    return b
iso = lambda s: datetime.fromisoformat(s.replace('Z', '+00:00'))
within = lambda a, b, sec: abs((iso(a) - iso(b)).total_seconds()) <= sec
events = lambda bid, ev='RECEIVED': [e for e in M.DB['events'] if e['box_id'] == bid and e['event'] == ev]

srv = subprocess.Popen([sys.executable, os.path.join(HERE, 'serve.py'), S, '8765', 'http://127.0.0.1:8766'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
mock = M.serve(8766); time.sleep(1)
errors = []
try:
    P = [mk() for _ in range(14)]
    with sync_playwright() as p:
        br = p.chromium.launch(); ctx = br.new_context(viewport={'width': 400, 'height': 860}, accept_downloads=True); pg = ctx.new_page()
        pg.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
        pg.on('console', lambda m: errors.append('console: ' + m.text) if m.type == 'error' and 'net::ERR' not in m.text and 'Failed to load resource' not in m.text and 'Cannot reach' not in m.text else None)
        go = lambda h: pg.evaluate(f"location.hash='#/{h}'")
        txt = lambda sel='main': pg.inner_text(sel)
        def wait_js(expr, timeout=12):
            end = time.time() + timeout
            while time.time() < end:
                if pg.evaluate(expr): return True
                time.sleep(0.1)
            return False
        def login(email):
            pg.fill('#em', email); pg.fill('#pw', 'secret'); pg.click('#go'); pg.wait_for_selector('.top nav')
        def scan(bid):
            pg.fill('#typed', bid); pg.click('#typedgo'); time.sleep(0.25)
        def queue(): return json.loads(pg.evaluate("localStorage.getItem('rbt.queue.u-store')") or '[]')
        def shot(name):
            if SHOTS: pg.screenshot(path=os.path.join(SHOTS, name + '.png'), full_page=True)
        qrows = lambda: pg.query_selector_all('#qlist tbody tr')
        def abort_rpc(): pg.route('**/rest/v1/rpc/receive_box', lambda r: r.abort())
        def unabort(): pg.unroute('**/rest/v1/rpc/receive_box')

        pg.goto(BASE); pg.wait_for_selector('#lf'); login('store@x.com')
        go('inward'); pg.wait_for_selector('#start')

        # ---- online: nothing changes
        chk('online: pill says Online, nothing is queued, no header pill', txt('#net') == 'Online' and pg.is_hidden('#qcard') and pg.is_hidden('#qpill'), txt('#net'))
        scan(P[0]['box_id']); pg.wait_for_selector('#result.ok')
        chk('online scan is received at once (green)', P[0]['status'] == 'FG-RECEIVED' and pg.is_hidden('#qcard'))

        # ---- no signal: scans are saved on the phone
        ctx.set_offline(True)
        chk('browser goes offline: the pill changes by itself', wait_js("document.querySelector('#net').textContent === 'No signal'", 5), txt('#net'))
        scan(P[1]['box_id']); pg.wait_for_selector('#result.warn')
        chk('offline scan: amber "Saved on this phone", box NOT received yet', 'Saved on this phone' in txt('#result') and P[1]['status'] == 'WIP-PACKED', txt('#result'))
        chk('offline scan: listed under "Saved on this phone" as waiting', pg.is_visible('#qcard') and len(qrows()) == 1 and 'Waiting for signal' in txt('#qlist') and P[1]['box_id'] in txt('#qlist'))
        chk('header shows "1 waiting to send"', pg.is_visible('#qpill') and txt('#qpill') == '1 waiting to send', txt('#qpill'))
        scan(P[2]['box_id']); scan(P[3]['box_id'])
        scan(P[1]['box_id'])
        chk('same box scanned twice offline: "Already saved", not listed twice', 'Already saved on this phone' in txt('#result') and len(qrows()) == 3, len(qrows()))
        scan('HELLO'); pg.wait_for_selector('#result.bad')
        chk('a stranger QR offline is still refused at once and not queued', 'Not a Radiance box label' in txt('#result') and len(qrows()) == 3)
        q = queue()
        chk('the queue is stored on the phone with the real scan time', len(q) == 3 and [i['box_id'] for i in q] == [P[1]['box_id'], P[2]['box_id'], P[3]['box_id']] and all(i['status'] == 'queued' and within(i['at'], datetime.now(timezone.utc).isoformat(), 60) for i in q), q[:1])
        shot('phone-offline-queue')
        scanned_at = {i['box_id']: i['at'] for i in q}

        # ---- signal is back
        ctx.set_offline(False)
        chk('signal back: all 3 are sent by themselves', wait_js("document.querySelector('#qcard').hidden", 12), txt('#qlist')[:100])
        chk('all 3 are FG-RECEIVED by the store login', all(P[i]['status'] == 'FG-RECEIVED' and P[i]['fg_by'] == 'u-store' for i in (1, 2, 3)))
        chk('each box carries the time it was SCANNED, not the time it was sent', all(within(P[i]['fg_at'], scanned_at[P[i]['box_id']], 1) for i in (1, 2, 3)))
        chk('the history event has the same time (so reports are right)', all(len(events(P[i]['box_id'])) == 1 and events(P[i]['box_id'])[0]['at'] == P[i]['fg_at'] for i in (1, 2, 3)))
        chk('pill is Online again and header pill gone', txt('#net') == 'Online' and pg.is_hidden('#qpill'))
        wait_js("document.querySelector('#list').textContent.includes('%s')" % P[3]['box_id'], 8)
        chk('the sent scans appear in "Your last 20 scans"', all(P[i]['box_id'] in txt('#list') for i in (1, 2, 3)), txt('#list')[:120])
        chk('the stored queue is empty again', queue() == [])

        # ---- the queue survives a reload and sends from another page
        abort_rpc()
        scan(P[4]['box_id']); pg.wait_for_selector('#result.warn')
        pg.reload(); pg.wait_for_selector('#start')
        chk('after a page reload the saved scan is still there', len(qrows()) == 1 and P[4]['box_id'] in txt('#qlist') and P[4]['status'] == 'WIP-PACKED')
        go(''); pg.wait_for_selector('.stat')
        chk('on another page the header still says what is waiting', txt('#qpill') == '1 waiting to send', txt('#qpill'))
        unabort()
        chk('and from that other page it is sent when the line works', wait_js("document.querySelector('#qpill').hidden", 10) and P[4]['status'] == 'FG-RECEIVED')
        go('inward'); pg.wait_for_selector('#start')

        # ---- scan times: believed only inside the allowed window
        P[12]['created_at'] = (datetime.now(timezone.utc) - timedelta(days=11)).isoformat()
        abort_rpc()
        for i in (5, 6, 7, 12): scan(P[i]['box_id'])
        now = datetime.now(timezone.utc)
        two_h, future, ten_d = (now - timedelta(hours=2)).isoformat(), (now + timedelta(hours=1)).isoformat(), (now - timedelta(days=9)).isoformat()
        pg.evaluate("""([a,b,c,d]) => { const k='rbt.queue.u-store'; const q=JSON.parse(localStorage.getItem(k)); q[0].at=a; q[1].at=b; q[2].at=c; q[3].at=d; localStorage.setItem(k, JSON.stringify(q)); }""",
                    [two_h, future, (now - timedelta(minutes=10)).isoformat(), ten_d])
        pg.reload(); pg.wait_for_selector('#start'); unabort(); pg.click('#sendnow')
        wait_js("document.querySelector('#qcard').hidden", 10)
        got = lambda i: P[i]['fg_at']
        chk('a scan made 2 hours ago is dated 2 hours ago', within(got(5), two_h, 1), got(5))
        chk('a time in the future is replaced by the server time', within(got(6), now.isoformat(), 20), got(6))
        chk('a scan made 10 minutes ago is dated 10 minutes ago', within(got(7), (now - timedelta(minutes=10)).isoformat(), 1), got(7))
        chk('a scan older than 7 days is replaced by the server time', within(got(12), now.isoformat(), 20), got(12))

        # ---- refused boxes stay visible until removed
        abort_rpc()
        for i in (8, 9, 10): scan(P[i]['box_id'])
        scan('RP-261101-99999')
        P[8]['status'] = 'VOID'                                               # voided while the phone had no signal
        P[9].update(status='FG-RECEIVED', fg_at=datetime.now(timezone.utc).isoformat(), fg_by='u-fg')   # received by someone else meanwhile
        unabort(); pg.click('#sendnow'); wait_js("document.querySelectorAll('#qlist tbody tr').length === 2 && !document.querySelector('#qlist').textContent.includes('Sending')", 10)
        chk('the good box was received; the box someone else received is dropped quietly', P[10]['status'] == 'FG-RECEIVED' and P[10]['fg_by'] == 'u-store' and P[9]['fg_by'] == 'u-fg')
        t = txt('#qlist')
        chk('refused boxes stay in the list with the reason (voided, not in register)', len(qrows()) == 2 and 'already VOID' in t and 'not in register' in t, t[:200].replace('\n', ' '))
        chk('header pill turns red: "2 not accepted"', txt('#qpill') == '2 not accepted' and 'bad' in pg.get_attribute('#qpill', 'class'), txt('#qpill'))
        shot('phone-not-accepted')
        pg.click('[data-rm]'); chk('Remove takes one line away', len(qrows()) == 1)
        pg.click('[data-rm]'); chk('Remove the last one: list and header pill disappear', pg.is_hidden('#qcard') and pg.is_hidden('#qpill'))

        # ---- the answer was lost although the server did receive the box
        pg.route('**/rest/v1/rpc/receive_box', lambda r: (r.fetch(), r.abort()))
        scan(P[11]['box_id']); pg.wait_for_selector('#result.warn')
        chk('lost answer: the phone cannot know, so it keeps the scan (server did receive it)', 'Saved on this phone' in txt('#result') and P[11]['status'] == 'FG-RECEIVED' and len(qrows()) == 1)
        unabort(); pg.click('#sendnow'); wait_js("document.querySelector('#qcard').hidden", 10)
        chk('sending it again is harmless: still ONE received event, list cleared, no error shown', len(events(P[11]['box_id'])) == 1 and pg.is_hidden('#qcard') and pg.is_hidden('#qpill'))

        # ---- a connection that never answers must not freeze the screen
        M.STATS['hang'] = 4   # the server takes 4 s to answer: longer than the 1.5 s time-out
        pg.evaluate("document.querySelector('#result').className = 'result idle'")   # forget the previous amber card
        t0 = time.time(); scan(P[13]['box_id']); pg.wait_for_selector('#result.warn', timeout=15000); waited = time.time() - t0
        chk('no answer: gives up after the time-out (about 1.5 s) and saves the scan', 1.0 <= waited <= 6.0 and P[13]['status'] == 'WIP-PACKED', round(waited, 1))
        extra = mk(); t0 = time.time(); scan(extra['box_id']); quick = time.time() - t0
        chk('the next scan is saved at once, without waiting again', 'Saved on this phone' in txt('#result') and quick < 1.0 and len(qrows()) == 2, round(quick, 2))
        M.STATS['hang'] = 0
        chk('when the line works again both are delivered', wait_js("document.querySelector('#qcard').hidden", 15) and P[13]['status'] == 'FG-RECEIVED' and extra['status'] == 'FG-RECEIVED')

        # ---- a busy server (HTTP 503 from the gateway) is not a refusal
        busy_box = mk()
        pg.route('**/rest/v1/rpc/receive_box', lambda r: r.fulfill(status=503, content_type='application/json', body='{"message":"upstream unavailable"}'))
        pg.evaluate("document.querySelector('#result').className = 'result idle'")
        scan(busy_box['box_id']); pg.wait_for_selector('#result.warn')
        chk('server busy (503) while scanning: saved on the phone, not a red error', 'Saved on this phone' in txt('#result') and busy_box['status'] == 'WIP-PACKED')
        pg.click('#sendnow'); time.sleep(0.8)
        chk('server busy (503) while sending: stays waiting ("will try again"), NOT "not accepted"', len(qrows()) == 1 and 'will try again' in txt('#qlist') and 'bad' not in (pg.get_attribute('#qpill', 'class') or ''), txt('#qlist')[:120])
        unabort(); pg.click('#sendnow'); wait_js("document.querySelector('#qcard').hidden", 10)
        chk('server healthy again: delivered', busy_box['status'] == 'FG-RECEIVED' and pg.is_hidden('#qpill'))

        # ---- sign out with scans waiting; queue belongs to the login
        last = mk(); abort_rpc(); scan(last['box_id']); pg.wait_for_selector('#result.warn')
        pg.once('dialog', lambda d: d.dismiss()); pg.click('#signout'); time.sleep(0.4)
        chk('sign out with a waiting scan asks first; Cancel keeps you signed in', pg.is_visible('.top nav') and pg.is_visible('#qpill'))
        said = []
        pg.once('dialog', lambda d: (said.append(d.message), d.accept())); pg.click('#signout'); pg.wait_for_selector('#lf')
        chk('the question names the waiting scan', said and '1 scan is still waiting' in said[0], said)
        chk('after signing out the scan is still stored on the phone', len(queue()) == 1)
        login('admin@x.com'); go('inward'); pg.wait_for_selector('#start')
        chk("another login does not see or send the store man's scans", pg.is_hidden('#qpill') and pg.is_hidden('#qcard') and last['status'] == 'WIP-PACKED')
        pg.click('#signout'); pg.wait_for_selector('#lf'); unabort()
        login('store@x.com')
        end = time.time() + 12
        while time.time() < end and last['status'] != 'FG-RECEIVED': time.sleep(0.1)
        chk('signing in as the same login sends them by itself (no need to open FG inward)', last['status'] == 'FG-RECEIVED' and last['fg_by'] == 'u-store' and wait_js("document.querySelector('#qpill').hidden", 5))
        go('inward'); pg.wait_for_selector('#start'); shot('phone-online')
        br.close()
finally:
    srv.terminate()

chk('no page errors or console errors', not errors, errors[:3])
print(f"\n{sum(results)}/{len(results)} passed")
sys.exit(0 if all(results) else 1)
