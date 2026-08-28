import subprocess, os, yaml
from pathlib import Path

FLY = r"C:/Users/antwo/.fly/bin/flyctl.exe"
APP = "mychart-bridge-mcp"
BASE = Path(__file__).parent
os.chdir(BASE)
env = dict(os.environ, FLY_NO_UPDATE_CHECK="1")
tok = yaml.safe_load(Path(r"C:/Users/antwo/.fly/config.yml").read_text())["access_token"].strip()

def log(msg: str) -> None:
    print(msg, flush=True)

def fly(args, timeout=1500):
    r = subprocess.run([FLY] + args + ["-t", tok], capture_output=True, text=True, timeout=timeout, env=env)
    return r.returncode, (r.stdout + r.stderr)
log("== staging secrets (no deploy) ==")
wh = (BASE / "DISCORD_WEBHOOK.txt").read_text().strip()
oak = (BASE / "OPENROUTER_KEY.txt").read_text().strip()
rc, out = fly(["secrets", "set", "--app", APP, "--stage",
               f"DISCORD_WEBHOOK_URL={wh}", f"OPENROUTER_API_KEY={oak}",
               "WATCH_TIMES=07:00,20:00", "TZ=America/Los_Angeles",
               "DISCORD_MENTION_USER_ID=413676504430542848",
               "INSTANCES_JSON=" + (BASE / ".." / "mychart-bridge-instances.json").resolve().read_text().strip()])
log(f"secrets stage rc={rc}: {out.strip().replace(oak, '<oak>').replace(wh, '<wh>')[-300:]}")

rc, out = fly(["secrets", "unset", "--app", APP, "--stage", "WATCH_INTERVAL_MIN"])
log(f"unset WATCH_INTERVAL_MIN rc={rc}: {out.strip()[-120:]}")

log("== deploying code (remote builder) ==")
rc, out = fly(["deploy", "--app", APP, "--remote-only", "--strategy", "immediate"], 1500)
log(f"deploy rc={rc}: {out.strip()[-600:]}")
log("== done ==")