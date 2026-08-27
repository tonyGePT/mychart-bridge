import json, subprocess, os
d = json.load(open("gmail-creds.json"))
env = dict(os.environ)
env["FLY_API_TOKEN"] = open("DEPLOY_FLY_TOKEN.txt").read().strip()
args = ["C:/Users/antwo/.fly/bin/flyctl.exe", "secrets", "set", "--app", "mychart-bridge-mcp",
        "GMAIL_CLIENT_ID=" + d["client_id"], "GMAIL_CLIENT_SECRET=" + d["client_secret"],
        "GMAIL_REFRESH_TOKEN=" + d["refresh_token"]]
r = subprocess.run(args, capture_output=True, text=True, timeout=120, env=env)
print((r.stdout or r.stderr)[-300:])
