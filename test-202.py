import subprocess, os, json, time, urllib.request

env = dict(os.environ)
insts = json.load(open('C:/tmp/mychart-bridge-instances.json'))
gc = json.load(open(r'C:/tmp/mychart-bridge/gmail-creds.json'))
env.update({
    "INSTANCES_JSON": json.dumps(insts),
    "DATABASE_URL": "postgresql://postgres:xztOFpepYtRxWZxgvVgVDhmRXftCBknU@reseau.proxy.rlwy.net:49458/railway",
    "BRIDGE_API_KEY": "localtest",
    "PORT": "8125",
    "GMAIL_CLIENT_ID": gc["client_id"], "GMAIL_CLIENT_SECRET": gc["client_secret"],
    "GMAIL_REFRESH_TOKEN": gc["refresh_token"], "GMAIL_FROM_FILTER": "donotreplymychart@providence.org",
})
subprocess.run(["taskkill", "/F", "/IM", "bun.exe"], capture_output=True)
time.sleep(1)
p = subprocess.Popen(["bun", "src/index.ts"], cwd="C:/tmp/mychart-bridge", env=env,
                     stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
time.sleep(5)
h = {"Authorization": "Bearer localtest", "Content-Type": "application/json",
     "Accept": "application/json, text/event-stream"}


def post(payload, timeout=460):
    req = urllib.request.Request("http://localhost:8125/mcp", data=json.dumps(payload).encode(), headers=h)
    r = urllib.request.urlopen(req, timeout=timeout)
    return r.status, r.read().decode()[:250]


print("init:", post({"jsonrpc": "2.0", "method": "initialize", "id": 1, "params": {
    "protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "v", "version": "1"}}}))
print("call:", post({"jsonrpc": "2.0", "method": "tools/call", "params": {
    "name": "run_raw_endpoint",
    "arguments": {"account": "lenna:mychartwa.providence.org", "method": "POST",
                  "path": "/api/bill-pay/GetBillPayData", "body": {}}}, "id": 9}))
print("---- server output ----")
print(p.stdout.read()[-1500:] if p.poll() is not None else "(still running)")
