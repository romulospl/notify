"""Fake Umami for the HA test: accepts POST /api/send and records the website of each event."""
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

LOG = sys.argv[1]


class H(BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        site = json.loads(body).get("payload", {}).get("website", "?")
        with open(LOG, "a") as f:
            f.write(f"{self.server.server_port} {site}\n")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b"{}")

    def log_message(self, *a):
        pass


HTTPServer(("0.0.0.0", 3000), H).serve_forever()
