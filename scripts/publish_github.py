"""Publish this project using existing Git Credential Manager authentication.

Tokens stay in process memory and are never printed or written to the project.
Only this directory is committed. Existing non-empty repositories are not reused.
"""
import json
import os
import pathlib
import subprocess
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
OWNER = "bibi45c"
NAME = "papertrade-monitor"
runenv = dict(os.environ, GIT_TERMINAL_PROMPT="0", GCM_INTERACTIVE="never")

def command(*args):
    return subprocess.run(args, cwd=ROOT, env=runenv, check=True, capture_output=True, text=True).stdout.strip()

def api(path, method="GET", data=None, allow_missing=False):
    request = urllib.request.Request("https://api.github.com" + path, method=method,
        data=None if data is None else json.dumps(data).encode(),
        headers={"Authorization": "Bearer " + credential, "Accept": "application/vnd.github+json", "Content-Type": "application/json", "User-Agent": "papertrade-monitor-setup"})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        if error.code == 404 and allow_missing:
            return None
        raise RuntimeError("GitHub API returned HTTP " + str(error.code)) from None

if __name__ == "__main__":
    process = subprocess.run(["git", "credential", "fill"], input="protocol=https\nhost=github.com\n\n", text=True, capture_output=True, env=runenv, timeout=25)
    fields = dict(line.split("=", 1) for line in process.stdout.splitlines() if "=" in line)
    credential = fields.get("password")
    if not credential:
        raise SystemExit("No existing GitHub credential found")
    user = api("/user")
    if user.get("login", "").lower() != OWNER.lower():
        raise SystemExit("Authenticated GitHub user does not match the requested owner")
    existing = api(f"/repos/{OWNER}/{NAME}", allow_missing=True)
    if existing is not None:
        raise SystemExit("Repository already exists; preserving it without changes")
    repository = api("/user/repos", "POST", {"name": NAME, "private": True, "description": "Read-only Papertrade × Hyperliquid market, queue, dividend and hedge-cost monitor", "auto_init": False})
    command("git", "init", "-b", "main")
    command("git", "config", "user.name", OWNER)
    command("git", "config", "user.email", str(user["id"]) + "+" + OWNER + "@users.noreply.github.com")
    command("git", "add", ".")
    command("git", "commit", "-m", "Build read-only Papertrade and Hyperliquid monitor")
    command("git", "remote", "add", "origin", repository["clone_url"])
    command("git", "push", "-u", "origin", "main")
    head = command("git", "rev-parse", "HEAD")
    remote = command("git", "ls-remote", "origin", "refs/heads/main").split()[0]
    if head != remote:
        raise SystemExit("Remote verification failed")
    print(json.dumps({"url": repository["html_url"], "private": repository["private"], "head": head, "remoteVerified": True}))
