"""Local dev server: serves public/ and runs the API against an in-memory store.

    python3 dev_server.py          # http://localhost:8001, data resets when you stop it
    python3 dev_server.py 9000     # another port

Set SUPABASE_URL and SUPABASE_SERVICE_KEY (and SN_MEMORY=0) to talk to the real database.
"""
import importlib.util
import json
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
os.environ.setdefault("SN_MEMORY", "1")

spec = importlib.util.spec_from_file_location("sn_api", os.path.join(ROOT, "api", "index.py"))
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)


class Dev(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=os.path.join(ROOT, "public"), **kw)

    def _api(self):
        if not self.path.startswith("/api"):
            return False
        n = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(n) if n else b""
        status, payload = api.respond(self.command, self.path, dict(self.headers.items()), raw)
        out = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)
        return True

    def do_GET(self):
        if not self._api():
            super().do_GET()

    def do_POST(self):
        self._api()

    do_PUT = do_DELETE = do_POST

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8001
    print(f"Snailnatra dev server on http://localhost:{port}  (memory store: {os.environ['SN_MEMORY'] == '1'})")
    ThreadingHTTPServer(("", port), Dev).serve_forever()
