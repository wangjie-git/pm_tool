import http.server, sys, json

LOG = r"D:\ai\pm-todo\tools\hook_received.jsonl"

class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(n).decode("utf-8")
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps({"path": self.path, "body": body}) + "\n")
        resp = json.dumps({"errcode": 0, "errmsg": "ok"}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(resp)))
        self.end_headers()
        self.wfile.write(resp)
    def log_message(self, *a):
        pass

http.server.ThreadingHTTPServer(("127.0.0.1", 8765), H).serve_forever()
