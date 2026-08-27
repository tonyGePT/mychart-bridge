import subprocess
env_proc = None
r = subprocess.run(["C:/Users/antwo/.fly/bin/flyctl.exe", "deploy", "--app", "mychart-bridge-mcp",
                    "--remote-only", "--strategy", "immediate", "-t", open("DEPLOY_FLY_TOKEN.txt").read().strip()],
                   capture_output=True, text=True, timeout=900)
print((r.stdout or r.stderr)[-300:])
