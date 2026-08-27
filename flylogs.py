import subprocess
r = subprocess.run(["C:/Users/antwo/.fly/bin/flyctl.exe", "logs", "--app", "mychart-bridge-mcp", "--no-tail",
                    "-t", open("DEPLOY_FLY_TOKEN.txt").read().strip()],
                   capture_output=True, text=True, timeout=45)
lines = r.stdout.splitlines()
err = [l for l in lines if "error" in l.lower() or "mcp error" in l.lower()]
print("\n".join(err[-10:]) or "no errors")
print("\n".join(lines[-6:]))
