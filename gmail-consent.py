import json, time, http.server, webbrowser, urllib.parse, urllib.request
from pathlib import Path

BASE = Path(r"C:/tmp/mychart-bridge")
d = json.loads((BASE / "gmail-creds.json").read_text())
PORT = 8765
REDIRECT = f"http://localhost:{PORT}"
SCOPES = "https://mail.google.com/"  # full access: read + permanent delete
client_id, client_secret = d["client_id"], d["client_secret"]

params = urllib.parse.urlencode({
    "client_id": client_id, "redirect_uri": REDIRECT, "response_type": "code",
    "scope": SCOPES, "access_type": "offline", "prompt": "consent",
})
url = "https://accounts.google.com/o/oauth2/v2/auth?" + params

result = {"code": None, "err": None}

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        result["code"] = (q.get("code") or [None])[0]
        result["err"] = (q.get("error") or [None])[0]
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"<h2>Consent received - you can close this tab.</h2>")

    def log_message(self, *a):
        pass

server = http.server.HTTPServer(("127.0.0.1", PORT), Handler)
print("CONSENT URL:", flush=True)
print(url, flush=True)
webbrowser.open(url)

deadline = time.time() + 900
while result["code"] is None and time.time() < deadline:
    server.timeout = 5
    server.handle_request()
server.server_close()

if result["err"]:
    raise SystemExit(f"consent error: {result['err']}")
if not result["code"]:
    raise SystemExit(f"no code captured within 15 minutes; if the browser showed "
                     + "redirect_uri_mismatch, the OAuth client needs http://localhost:8765 registered")

data = urllib.parse.urlencode({
    "client_id": client_id, "client_secret": client_secret, "code": result["code"],
    "grant_type": "authorization_code", "redirect_uri": REDIRECT,
}).encode()
req = urllib.request.Request("https://oauth2.googleapis.com/token", data=data,
                             headers={"Content-Type": "application/x-www-form-urlencoded"})
tok = json.loads(urllib.request.urlopen(req, timeout=30).read())
if "refresh_token" not in tok:
    raise SystemExit("no refresh_token in response: "
                     + json.dumps({k: v for k, v in tok.items() if k != "access_token"}))

d["refresh_token"] = tok["refresh_token"]
(BASE / "gmail-creds.json").write_text(json.dumps(d, indent=2) + "\n", encoding="utf-8")
print("CONSENT OK - refresh token saved (len", len(d["refresh_token"]), ")", flush=True)