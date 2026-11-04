#!/usr/bin/env python3
"""Chrome native messaging host for DIGIT Bug Reporter v2.

Lets the extension start a read-only diagnosis (../auto-triage.sh) the moment an issue is created, and read the
result back for the tracker. It accepts only these requests, each with GitHub issue URLs checked against a pattern:
  {"type": "ping"}
  {"type": "diagnose", "url": ..., "force": bool, "frames": [base64 jpeg, ...], "mdms": [record json, ...]}
  {"type": "status", "urls": [...]}
  {"type": "report", "url": ...}
"""
import base64, json, os, re, struct, subprocess, sys, time

HERE = os.path.dirname(os.path.realpath(__file__))
TRIAGE = os.environ.get("DIGIT_TRIAGE_CMD") or os.path.join(os.path.dirname(HERE), "auto-triage.sh")
OUT = os.environ.get("DIGIT_TRIAGE_OUT") or os.path.expanduser("~/digit-bug-triage")
URL_RE = re.compile(r"^https://github\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)/issues/(\d+)$")
MAX_TEXT = 200_000      # Chrome drops replies over 1 MB
MAX_FRAMES = 24
START_GRACE_S = 60
MAX_MDMS_RECORDS = 400
MAX_MDMS_BYTES = 8_000_000
SAFE_NAME = re.compile(r"[^A-Za-z0-9_.-]+")
MAX_FRAME_BYTES = 400_000
VERSION = 1


def read_message():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    (n,) = struct.unpack("<I", raw)
    return json.loads(sys.stdin.buffer.read(n))


def write_message(msg):
    data = json.dumps(msg).encode()
    sys.stdout.buffer.write(struct.pack("<I", len(data)) + data)
    sys.stdout.buffer.flush()


def issue_dir(url):
    m = URL_RE.match(url or "")
    if not m:
        raise ValueError("not a GitHub issue URL")
    return os.path.join(OUT, f"{m.group(2)}-{m.group(3)}")


def pid_alive(path):
    try:
        os.kill(int(open(path).read().strip()), 0)
        return True
    except (OSError, ValueError):
        return False


def status_of(url):
    d = issue_dir(url)
    report = os.path.join(d, "report.md")
    started = os.path.join(d, ".started")
    if pid_alive(os.path.join(d, ".running")):
        return {"state": "running"}
    # the runner writes .running a moment after it starts; until then, a fresh .started counts
    if (os.path.exists(started) and time.time() - os.path.getmtime(started) < START_GRACE_S
            and not (os.path.isfile(report) and os.path.getmtime(report) >= os.path.getmtime(started))):
        return {"state": "running"}
    if os.path.isfile(report) and os.path.getsize(report):
        first = open(report, encoding="utf-8", errors="replace").readline().strip()
        return {"state": "done", "verdict": re.sub(r"^VERDICT:\s*", "", first)[:300], "dir": d,
                "at": int(os.path.getmtime(report) * 1000)}
    if os.path.exists(os.path.join(d, ".failed")):
        return {"state": "failed", "dir": d}
    return {"state": "none"}


def save_frames(d, frames):
    fdir = os.path.join(d, "attachments", "frames")
    os.makedirs(fdir, exist_ok=True)
    for old in os.listdir(fdir):
        os.remove(os.path.join(fdir, old))
    for i, b64 in enumerate(frames[:MAX_FRAMES], 1):
        data = base64.b64decode(b64, validate=True)
        if len(data) > MAX_FRAME_BYTES or not data.startswith(b"\xff\xd8"):
            raise ValueError("frames must be JPEG images under 400 KB")
        with open(os.path.join(fdir, f"{i:02d}.jpg"), "wb") as f:
            f.write(data)


def save_mdms(d, records):
    """MDMS records the console loaded while the bug was captured: exactly what the screen used."""
    parsed, total = [], 0
    for text in records[:MAX_MDMS_RECORDS]:  # check everything before writing anything
        total += len(text)
        if total > MAX_MDMS_BYTES:
            break
        r = json.loads(text)
        if not (isinstance(r, dict) and isinstance(r.get("schemaCode"), str) and isinstance(r.get("uniqueIdentifier"), str)):
            raise ValueError("MDMS records must have schemaCode and uniqueIdentifier")
        parsed.append(r)
    mdir = os.path.join(d, "mdms-from-page")
    os.makedirs(mdir, exist_ok=True)
    for old in os.listdir(mdir):
        os.remove(os.path.join(mdir, old))
    index = []
    for r in parsed:
        name = SAFE_NAME.sub("_", f"{r['schemaCode']}__{r['uniqueIdentifier']}")[:180] + ".json"
        with open(os.path.join(mdir, name), "w", encoding="utf-8") as f:
            json.dump(r, f, indent=1, ensure_ascii=False)
        index.append(f"| {r['schemaCode']} | {r['uniqueIdentifier']} | {r.get('lastModifiedTime') or ''} | {name} |")
    with open(os.path.join(mdir, "INDEX.md"), "w", encoding="utf-8") as f:
        f.write("MDMS records the console loaded while the bug was captured (as of capture time).\n\n"
                "| schemaCode | uniqueIdentifier | lastModifiedTime | file |\n|---|---|---|---|\n" + "\n".join(index) + "\n")


def diagnose(msg):
    url = msg.get("url")
    d = issue_dir(url)
    current = status_of(url)
    if current["state"] == "running" or (current["state"] == "done" and not msg.get("force")):
        return current
    os.makedirs(d, exist_ok=True)
    if current["state"] == "done":  # diagnose again: keep the earlier report
        stamp = time.strftime("%Y%m%d-%H%M%S")
        for name in ("report.md", "comment.md"):
            p = os.path.join(d, name)
            if os.path.exists(p):
                os.rename(p, os.path.join(d, f"{name[:-3]}.{stamp}.md"))
    if msg.get("frames"):
        save_frames(d, msg["frames"])
    if msg.get("mdms"):
        save_mdms(d, msg["mdms"])
    env = dict(os.environ)
    # Chrome starts hosts with a minimal PATH
    env["PATH"] = os.pathsep.join([os.path.expanduser("~/.local/bin"), "/usr/local/bin", "/usr/bin", "/bin", env.get("PATH", "")])
    open(os.path.join(d, ".started"), "w").close()
    # a new session, so the diagnosis keeps running after Chrome closes this host
    subprocess.Popen([TRIAGE, url], env=env, start_new_session=True, stdin=subprocess.DEVNULL,
                     stdout=open(os.path.join(d, "host-start.log"), "w"), stderr=subprocess.STDOUT)
    return {"state": "running"}


def report(url):
    d = issue_dir(url)
    read = lambda name: (open(os.path.join(d, name), encoding="utf-8", errors="replace").read()[:MAX_TEXT]
                         if os.path.isfile(os.path.join(d, name)) else "")
    return {**status_of(url), "report": read("report.md"), "comment": read("comment.md")}


def handle(msg):
    kind = msg.get("type")
    if kind == "ping":
        try:
            caps = json.loads(subprocess.run([os.path.join(os.path.dirname(HERE), "preflight.sh")], capture_output=True,
                                             text=True, timeout=20).stdout)
        except Exception:
            caps = None
        return {"version": VERSION, "out": OUT, "capabilities": caps}
    if kind == "diagnose":
        return diagnose(msg)
    if kind == "status":
        return {"results": {u: status_of(u) for u in (msg.get("urls") or [])[:200]}}
    if kind == "report":
        return report(msg.get("url"))
    raise ValueError(f"unknown request: {kind}")


def main():
    msg = read_message()
    if msg is None:
        return
    try:
        write_message({"ok": True, **handle(msg)})
    except Exception as e:  # report every failure to the extension rather than dying silently
        write_message({"ok": False, "error": str(e)[:300]})


if __name__ == "__main__":
    main()
