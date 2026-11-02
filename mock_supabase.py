"""Stand-in for Supabase Auth + PostgREST, ONLY to exercise the web app's requests in the sandbox
(the sandbox cannot reach the real project). It mimics the contract of the real functions; the real
database logic was tested separately on the live project."""
import json, re, sys, threading, urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from datetime import datetime, timedelta, timezone

IST = timezone(timedelta(hours=5, minutes=30))
today = lambda: datetime.now(IST).date().isoformat()

USERS = {
    'admin@x.com': dict(id='u-admin', pw='secret'),
    'store@x.com': dict(id='u-store', pw='secret'),
    'new@x.com': dict(id='u-new', pw='secret'),
    'fg@x.com': dict(id='u-fg', pw='secret'),
}
DB = dict(
    profiles={'u-admin': dict(user_id='u-admin', full_name='Bhushan', role='admin', active=True),
              'u-store': dict(user_id='u-store', full_name='Store Man', role='store', active=True),
              'u-fg': dict(user_id='u-fg', full_name='FG Man', role='fg', active=True)},
    parts={}, packing={}, boxes=[], settings={}, seq=0, log=[], slips={}, parties={}, slipn={},
)
STATS = dict(refresh=0, logins=0, expired=set())
RES = {'select', 'order', 'limit', 'offset', 'on_conflict'}


def role_of(uid):
    p = DB['profiles'].get(uid)
    return p['role'] if p and p['active'] else None


class Err(Exception):
    def __init__(self, status, message, code=''):
        self.status, self.message, self.code = status, message, code


def views():
    b = DB['boxes']
    fg = {}
    for x in b:
        if x['status'] in ('FG-RECEIVED', 'WIP-PACKED'):
            r = fg.setdefault(x['part_no'], dict(part_no=x['part_no'], part_name=x['part_name'], fg_qty=0, fg_boxes=0, wip_qty=0, wip_boxes=0, oldest_fg_at=None, oldest_days=None))
            k = 'fg' if x['status'] == 'FG-RECEIVED' else 'wip'
            r[k + '_qty'] += x['qty']; r[k + '_boxes'] += 1
    out = {}
    for x in b:
        if x['status'] != 'VOID' and x['source'] == 'LABEL':
            r = out.setdefault((x['label_date'], x['part_no']), dict(day=x['label_date'], shift='A', part_no=x['part_no'], part_name=x['part_name'], boxes=0, qty=0))
            r['boxes'] += 1; r['qty'] += x['qty']
    return dict(fg_stock_by_part=sorted(fg.values(), key=lambda r: r['part_no']), assembly_out_by_date=list(out.values()), inward_by_date=[], dispatch_by_date=[])


def table_rows(t):
    if t == 'profiles': return list(DB['profiles'].values())
    if t == 'parts': return list(DB['parts'].values())
    if t == 'packing_options': return list(DB['packing'].values())
    if t == 'settings': return [dict(key=k, value=v) for k, v in DB['settings'].items()]
    if t == 'boxes': return DB['boxes']
    if t == 'parties': return sorted(DB['parties'].values(), key=lambda r: r['name'])
    if t == 'slips': return list(DB['slips'].values())
    if t == 'slip_summary':
        out = []
        for sl in DB['slips'].values():
            live = [b for b in DB['boxes'] if b['slip_no'] == sl['slip_no']]
            v = sl.get('voided_at')
            out.append(dict(sl, boxes=(sl.get('void_boxes') or 0) if v else len(live), qty=(sl.get('void_qty') or 0) if v else sum(b['qty'] for b in live)))
        return out
    v = views()
    if t in v: return v[t]
    raise Err(404, 'unknown table ' + t, '42P01')


def matches(row, key, spec):
    op, arg = spec.split('.', 1)
    v = row.get(key)
    if op == 'not': return not matches(row, key, arg)
    if op == 'is': return (v is None) if arg == 'null' else (v is not None)
    if op == 'eq': return str(v).lower() == arg.lower()
    if op == 'gte': return v is not None and str(v) >= arg
    if op == 'lte': return v is not None and str(v) <= arg
    if op == 'ilike':
        rx = '^' + re.escape(arg).replace(r'\*', '.*') + '$'
        return re.match(rx, str(v or ''), re.I) is not None
    raise Err(400, 'op ' + op)


def new_box(part, name, qty, status, source, user, lot, date, pp, tray, qa=''):
    DB['seq'] += 1
    s = DB['seq']
    bid = 'RP-' + datetime.now(IST).strftime('%y%m%d') + '-' + str(s).zfill(5)
    now = datetime.now(timezone.utc).isoformat()
    b = dict(seq=s, box_id=bid, part_no=part, part_name=name, qty=qty, status=status, source=source, shift='A', qa_sign=qa, lot=lot,
             label_date=date, pp_box_code=pp, tray_no=tray, rack=None, slip_no=None, created_at=now, fg_at=now if status == 'FG-RECEIVED' else None, fg_by=user if status == 'FG-RECEIVED' else None, out_at=None)
    DB['boxes'].append(b)
    return b


clean = lambda p: re.sub(r'[.…]+$', '', str(p or '').strip().upper()).strip()


def rpc(fn, a, uid):
    r = role_of(uid)
    def need(*roles):
        if r is None or r not in roles: raise Err(403, f"Not allowed for your role ({r or 'no role'})", '42501')
    DB['log'].append((fn, a))
    if fn == 'create_boxes':
        need('assembly', 'admin')
        part = clean(a['p_part_no'])
        if not part: raise Err(400, 'Part no is required', 'P0001')
        if not a['p_n'] or not 1 <= a['p_n'] <= 200: raise Err(400, 'Number of boxes must be 1 to 200', 'P0001')
        po = DB['packing'].get((part, a['p_std_qty']), {})
        name = (a.get('p_part_name') or '').strip().upper()
        old = DB['parts'].get(part, dict(part_no=part, name='', std_qty=None, active=True))
        DB['parts'][part] = dict(old, name=name or old['name'], std_qty=a['p_std_qty'])
        rows = []
        for i in range(1, a['p_n'] + 1):
            q = a['p_last_qty'] if (i == a['p_n'] and a.get('p_last_qty')) else a['p_std_qty']
            rows.append(new_box(part, name, q, 'WIP-PACKED', 'LABEL', uid, (a.get('p_lot') or '').upper(), a.get('p_label_date') or today(), po.get('pp_box_code', ''), po.get('tray_no', ''), a.get('p_qa_sign', '')))
        return rows
    if fn == 'reprint_boxes':
        need('assembly', 'admin')
        return [b for b in DB['boxes'] if b['box_id'] in a['p_box_ids']]
    if fn == 'void_box':
        need('assembly', 'admin')
        b = next((x for x in DB['boxes'] if x['box_id'] == a['p_box_id']), None)
        if not b: return dict(ok=False, msg='Box not found')
        if b['status'] not in ('WIP-PACKED', 'FG-RECEIVED'): return dict(ok=False, msg='Cannot void a box that is ' + b['status'])
        if not (a.get('p_reason') or '').strip(): raise Err(400, 'Reason is required', 'P0001')
        b['status'] = 'VOID'
        return dict(ok=True)
    if fn == 'receive_box':
        need('store', 'fg', 'admin')
        bid = (a.get('p_box_id') or '').strip().upper()
        rack = (a.get('p_rack') or '').strip() or None
        b = next((x for x in DB['boxes'] if x['box_id'] == bid), None)
        if b and b['status'] == 'WIP-PACKED':
            b.update(status='FG-RECEIVED', fg_at=datetime.now(timezone.utc).isoformat(), fg_by=uid, rack=rack)
            return dict(ok=True, msg=f"{bid} received · {b['part_no']} {b['part_name']} · {b['qty']} pcs",
                        box=dict(box_id=bid, part_no=b['part_no'], part_name=b['part_name'], qty=b['qty'], rack=rack, fg_at=b['fg_at']))
        if not b: return dict(ok=False, msg=bid + ': not in register')
        extra = {'FG-RECEIVED': ' on ' + (b['fg_at'] or '')[:10], 'DISPATCHED': ' on slip ' + (b['slip_no'] or '')}.get(b['status'], '')
        return dict(ok=False, msg=f"{bid}: already {b['status']}{extra}")
    if fn == 'check_box_for_slip':
        need('dispatch', 'fg', 'admin')
        bid = (a.get('p_box_id') or '').strip().upper(); have = a.get('p_scanned') or []
        b = next((x for x in DB['boxes'] if x['box_id'] == bid), None)
        if not b: return dict(ok=False, msg=bid + ': not in register')
        if bid in have: return dict(ok=False, msg=bid + ': already scanned in this slip')
        if b['status'] != 'FG-RECEIVED':
            why = {'WIP-PACKED': 'not yet received in FG (do FG inward first)', 'DISPATCHED': 'already dispatched on slip ' + (b['slip_no'] or '')}.get(b['status'], 'voided')
            return dict(ok=False, msg=f'{bid}: {why}')
        old = next((o['box_id'] for o in sorted(DB['boxes'], key=lambda o: o['seq']) if o['part_no'] == b['part_no'] and o['status'] == 'FG-RECEIVED' and o['seq'] < b['seq'] and o['box_id'] not in have), None)
        msg = f"{bid} · {b['part_no']} · {b['qty']} pcs" + (f' · FIFO note: older box {old} of this part is still in stock' if old else '')
        return dict(ok=True, warn=old is not None, msg=msg, box=dict(box_id=bid, part_no=b['part_no'], part_name=b['part_name'], qty=b['qty']))
    if fn == 'create_slip':
        need('dispatch', 'fg', 'admin')
        ids = [x.strip().upper() for x in (a.get('p_box_ids') or []) if x.strip()]
        if not ids: return dict(ok=False, msg='No boxes to dispatch')
        if len(set(ids)) != len(ids): return dict(ok=False, msg='The same box is listed twice')
        party = (a.get('p_party') or '').strip()
        if not party: return dict(ok=False, msg='Party name is required')
        bad = sorted(i for i in ids if not any(b['box_id'] == i and b['status'] == 'FG-RECEIVED' for b in DB['boxes']))
        if bad: return dict(ok=False, msg='Some boxes are not available for dispatch: ' + ', '.join(bad), bad=bad)
        day = datetime.now(IST).strftime('%y%m%d'); DB['slipn'][day] = DB['slipn'].get(day, 0) + 1
        no = f"SL-{day}-{DB['slipn'][day]:03d}"
        g = lambda k: (a.get(k) or '').strip()
        DB['slips'][no] = dict(slip_no=no, party=party, location=g('p_location'), transport=g('p_transport'), vehicle=g('p_vehicle'), lr_no=g('p_lr_no'), inv_no=g('p_inv_no'),
                               disp_exe=g('p_disp_exe'), driver_name=g('p_driver_name'), driver_mob=g('p_driver_mob'), created_at=datetime.now(timezone.utc).isoformat(), created_by=uid, voided_at=None)
        q = 0
        for b in DB['boxes']:
            if b['box_id'] in ids: b.update(status='DISPATCHED', slip_no=no, out_at=datetime.now(timezone.utc).isoformat(), out_by=uid); q += b['qty']
        DB['parties'][party] = dict(name=party, location=g('p_location'), transport=g('p_transport'), disp_exe=g('p_disp_exe'), driver_name=g('p_driver_name'), driver_mob=g('p_driver_mob'))
        return dict(ok=True, slip_no=no, boxes=len(ids), qty=q)
    if fn == 'void_slip':
        need('admin')
        reason = (a.get('p_reason') or '').strip()
        if not reason: return dict(ok=False, msg='A reason is required to void a slip')
        no = (a.get('p_slip_no') or '').strip().upper(); sl = DB['slips'].get(no)
        if not sl: return dict(ok=False, msg=no + ': slip not found')
        if sl.get('voided_at'): return dict(ok=False, msg=no + ': already voided')
        live = [b for b in DB['boxes'] if b['slip_no'] == no and b['status'] == 'DISPATCHED']
        sl.update(voided_at=datetime.now(timezone.utc).isoformat(), void_reason=reason, void_boxes=len(live), void_qty=sum(b['qty'] for b in live))
        for b in live: b.update(status='FG-RECEIVED', slip_no=None, out_at=None, out_by=None)
        return dict(ok=True, msg=f'{no} voided · {len(live)} boxes back in FG stock', boxes=len(live), qty=sl['void_qty'])
    if fn == 'admin_list_users':
        need('admin')
        return [dict(user_id=v['id'], email=e, full_name=(DB['profiles'].get(v['id']) or {}).get('full_name'), role=(DB['profiles'].get(v['id']) or {}).get('role'),
                     active=(DB['profiles'].get(v['id']) or {}).get('active'), last_sign_in_at=None) for e, v in USERS.items()]
    if fn == 'add_opening_stock':
        need('admin')
        if 'opening_stock_done' in DB['settings']: raise Err(400, 'Opening stock was already uploaded on ' + DB['settings']['opening_stock_done'], 'P0001')
        n = q = 0
        for x in a['p_rows']:
            part = clean(x['part_no'])
            std = x.get('std_qty'); cnt = int(x.get('n_boxes') or 0); loose = int(x.get('loose_qty') or 0)
            date = x.get('date') or today()
            for _ in range(cnt): new_box(part, (x.get('part_name') or '').upper(), std, 'FG-RECEIVED', 'OPENING', uid, (x.get('lot') or '').upper(), date, '', ''); n += 1; q += std
            if loose: new_box(part, (x.get('part_name') or '').upper(), loose, 'FG-RECEIVED', 'OPENING', uid, (x.get('lot') or '').upper(), date, '', ''); n += 1; q += loose
            if part not in DB['parts']: DB['parts'][part] = dict(part_no=part, name=(x.get('part_name') or '').upper(), std_qty=std, active=True)
        DB['settings']['opening_stock_done'] = datetime.now(IST).strftime('%Y-%m-%d %H:%M')
        return dict(ok=True, boxes=n, qty=q, rows=len(a['p_rows']))
    raise Err(404, 'no function ' + fn, 'PGRST202')


class H(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def log_message(self, *a): pass

    def send(self, status, body=None, extra=None):
        data = b'' if body is None else json.dumps(body).encode()
        self.send_response(status)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Expose-Headers', 'Content-Range')
        self.send_header('Content-Type', 'application/json')
        for k, v in (extra or {}).items(): self.send_header(k, v)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'apikey,authorization,content-type,range,range-unit,prefer')
        self.send_header('Content-Length', '0')
        self.end_headers()

    def body(self):
        n = int(self.headers.get('Content-Length') or 0)
        return json.loads(self.rfile.read(n) or b'null') if n else None

    def handle_any(self, method):
        try:
            u = urllib.parse.urlparse(self.path)
            qs = urllib.parse.parse_qsl(u.query, keep_blank_values=True)
            if not self.headers.get('apikey'): raise Err(401, 'No API key found in request', 'PGRST301')
            if u.path == '/auth/v1/token':
                g = dict(qs)['grant_type']; b = self.body()
                if g == 'password':
                    usr = USERS.get(b['email'])
                    if not usr or usr['pw'] != b['password']: raise Err(400, 'Invalid login credentials', 'invalid_credentials')
                    STATS['logins'] += 1
                    return self.send(200, self.session(b['email'], usr['id']))
                STATS['refresh'] += 1
                rt = b['refresh_token']
                email = next(e for e, v in USERS.items() if v['id'] == rt.split('.')[1])
                return self.send(200, self.session(email, USERS[email]['id']))
            if u.path == '/auth/v1/logout': return self.send(204)
            if not u.path.startswith('/rest/v1/'): raise Err(404, 'not found')
            tok = (self.headers.get('Authorization') or '').replace('Bearer ', '')
            if not tok.startswith('at.') or tok in STATS['expired']: raise Err(401, 'JWT expired', 'PGRST301')
            uid = tok.split('.')[1]
            name = u.path[len('/rest/v1/'):]
            if name.startswith('rpc/'):
                res = rpc(name[4:], self.body() or {}, uid)
                return self.send(200, res)
            if role_of(uid) is None and name != 'profiles': return self.send(200, [])   # RLS: no role sees nothing
            if method == 'GET':
                rows = table_rows(name)
                for k, v in qs:
                    if k == 'or':
                        alts = [a.split('.', 1) for a in v.strip('()').split(',')]
                        rows = [r for r in rows if any(matches(r, f, rest) for f, rest in alts)]
                    elif k not in RES: rows = [r for r in rows if matches(r, k, v)]
                for k, v in reversed([(k, v) for k, v in qs if k == 'order']):
                    for part in reversed(v.split(',')):
                        f, _, d = part.partition('.')
                        rows = sorted(rows, key=lambda r: (r.get(f) is None, r.get(f)), reverse=(d == 'desc'))
                total = len(rows)
                rng = self.headers.get('Range')
                hdr = {}
                if rng:
                    a, b = map(int, rng.split('-'))
                    if a > 0 and a >= total: raise Err(416, 'Requested range not satisfiable', 'PGRST103')   # like PostgREST
                    rows = rows[a:b + 1]
                    hdr['Content-Range'] = (f'{a}-{a + len(rows) - 1}/{total}' if rows else f'*/{total}')
                return self.send(200, rows, hdr)
            if method in ('POST', 'PATCH'):
                r = role_of(uid)
                if name in ('parts', 'packing_options') and r not in ('admin', 'assembly'): raise Err(403, 'new row violates row-level security policy', '42501')
                if name == 'profiles' and r != 'admin': raise Err(403, 'new row violates row-level security policy', '42501')
                b = self.body()
                if method == 'POST':
                    pref = self.headers.get('Prefer', ''); ign = 'ignore-duplicates' in pref
                    for row in b:
                        if name == 'parts':
                            ex = DB['parts'].get(row['part_no'])
                            if ex and not ign: ex.update(row)
                            elif not ex: DB['parts'][row['part_no']] = dict(dict(name='', std_qty=None, active=True), **row)
                        elif name == 'packing_options':
                            DB['packing'].setdefault((row['part_no'], row['std_qty']), {}).update(row)
                        elif name == 'profiles': DB['profiles'].setdefault(row['user_id'], {}).update(row)
                    return self.send(201)
                if name == 'parts':
                    for row in table_rows('parts'):
                        if all(matches(row, k, v) for k, v in qs if k not in RES): row.update(b)
                    return self.send(204)
            raise Err(405, 'unsupported')
        except Err as e:
            self.send(e.status, dict(message=e.message, code=e.code))

    def session(self, email, uid):
        return dict(access_token=f'at.{uid}.{STATS["logins"]}.{STATS["refresh"]}', refresh_token=f'rt.{uid}.x', expires_in=3600,
                    expires_at=int(datetime.now().timestamp()) + 3600, user=dict(id=uid, email=email))

    do_GET = lambda s: s.handle_any('GET')
    do_POST = lambda s: s.handle_any('POST')
    do_PATCH = lambda s: s.handle_any('PATCH')


def serve(port=8766):
    srv = ThreadingHTTPServer(('127.0.0.1', port), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


if __name__ == '__main__':
    serve(int(sys.argv[1]) if len(sys.argv) > 1 else 8766)
    threading.Event().wait()
