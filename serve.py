"""Static server for tests: serves the repo root and applies the exact headers from web/vercel.json (CSP included)."""
import json, os, sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

root = os.path.abspath(sys.argv[1]); port = int(sys.argv[2]); extra_connect = sys.argv[3] if len(sys.argv) > 3 else ''
hdrs = json.load(open(os.path.join(root, 'web', 'vercel.json')))['headers'][0]['headers']

class H(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=root, **k)
    def log_message(self, *a): pass
    def end_headers(self):
        if self.path.startswith('/web/'):
            for h in hdrs:
                v = h['value']
                if h['key'] == 'Content-Security-Policy' and extra_connect: v = v.replace("connect-src 'self'", f"connect-src 'self' {extra_connect}")
                self.send_header(h['key'], v)
        super().end_headers()

ThreadingHTTPServer(('127.0.0.1', port), H).serve_forever()
