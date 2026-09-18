#!/usr/bin/env python3
"""
Finish Finnish - local flashcard app server.

Pure standard library (no pip installs needed). Serves the frontend from
./public and a tiny JSON API backed by files in ./cards and ./data.

Progress is tracked per (category, direction, card) with two tiers:

  - "mastered" ("Learned"): the card has been answered correctly
    MASTERY_STREAK times in a row in normal practice. A miss resets the
    streak to 0, which un-masters the card.

  - "retained" ("Retained", long-term mastery): a lightweight spaced-
    repetition check. Once a card is first mastered, it's scheduled for a
    handful of follow-up reviews spread across REVIEW_INTERVALS days
    (default 2, 4, 8 -> ~14 days total). Each of those reviews only
    "counts" if it happens on or after its due date; getting it right
    advances to the next interval, getting it wrong resets the schedule.
    A card becomes "retained" once it's passed every scheduled review.
"""
import json
import os
import re
from datetime import date, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

ROOT = os.path.dirname(os.path.abspath(__file__))
CARDS_DIR = os.path.join(ROOT, "cards")
DATA_DIR = os.path.join(ROOT, "data")
PUBLIC_DIR = os.path.join(ROOT, "public")
PROGRESS_FILE = os.path.join(DATA_DIR, "progress.json")

# A card counts as "mastered" (Learned) once it's been answered correctly
# this many times in a row. Getting it wrong resets the streak to 0.
MASTERY_STREAK = 3

# Days between each scheduled spaced-repetition check-in after a card is
# first mastered. Passing every check-in in this list earns "retained"
# (long-term mastery). Sums to ~14 days end to end.
REVIEW_INTERVALS = [2, 4, 8]

DIRECTIONS = ("fi-en", "en-fi")
DEFAULT_DIRECTION = "fi-en"

DEFAULT_RETENTION = {
    "stage": 0,
    "firstMasteredDate": None,
    "nextReviewDue": None,
    "retained": False,
}

DEFAULT_ENTRY = {
    "correctStreak": 0,
    "timesSeen": 0,
    "timesCorrect": 0,
    "mastered": False,
    "retention": dict(DEFAULT_RETENTION),
}

os.makedirs(DATA_DIR, exist_ok=True)

CATEGORY_ID_RE = re.compile(r"^[a-zA-Z0-9_-]+$")


def today_str():
    return date.today().isoformat()


def add_days(iso_date_str, days):
    d = date.fromisoformat(iso_date_str)
    return (d + timedelta(days=days)).isoformat()


def fresh_entry():
    entry = dict(DEFAULT_ENTRY)
    entry["retention"] = dict(DEFAULT_RETENTION)
    return entry


def normalize_entry(entry):
    """Fill in any fields missing from an older/partial entry."""
    out = fresh_entry()
    out.update(entry or {})
    retention = dict(DEFAULT_RETENTION)
    retention.update((entry or {}).get("retention") or {})
    out["retention"] = retention
    return out


def load_progress():
    if os.path.exists(PROGRESS_FILE):
        try:
            with open(PROGRESS_FILE, "r", encoding="utf-8") as f:
                raw = json.load(f)
        except (json.JSONDecodeError, OSError):
            return {}
    else:
        raw = {}

    return migrate_progress(raw)


def migrate_progress(raw):
    """
    Upgrade older progress files to the {category: {direction: {cardId: entry}}}
    shape. Older files stored entries directly as {category: {cardId: entry}}
    (single, undirected mode) - treat that data as fi-en progress.
    """
    changed = False
    migrated = {}
    for category_id, bucket in raw.items():
        if not isinstance(bucket, dict):
            continue
        if any(k in DIRECTIONS for k in bucket.keys()):
            # Already in the new shape.
            migrated[category_id] = bucket
            continue
        # Old shape: bucket maps cardId -> entry directly.
        changed = True
        migrated[category_id] = {DEFAULT_DIRECTION: bucket, "en-fi": {}}

    if changed:
        save_progress(migrated)
    return migrated


def save_progress(progress):
    tmp_path = PROGRESS_FILE + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(progress, f, indent=2, ensure_ascii=False)
    os.replace(tmp_path, PROGRESS_FILE)


def list_category_ids():
    ids = []
    if os.path.isdir(CARDS_DIR):
        for fname in sorted(os.listdir(CARDS_DIR)):
            if fname.endswith(".json"):
                ids.append(fname[: -len(".json")])
    return ids


def load_category(category_id):
    if not CATEGORY_ID_RE.match(category_id):
        return None
    path = os.path.join(CARDS_DIR, category_id + ".json")
    if not os.path.exists(path):
        return None
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def card_progress_entry(progress, category_id, direction, card_id):
    bucket = progress.get(category_id, {}).get(direction, {})
    return normalize_entry(bucket.get(card_id))


def is_due_for_review(entry):
    """A mastered-but-not-yet-retained card that's due for its next
    scheduled spaced-repetition check-in."""
    if not entry.get("mastered") or entry.get("retention", {}).get("retained"):
        return False
    due = entry.get("retention", {}).get("nextReviewDue")
    return bool(due) and due <= today_str()


class Handler(BaseHTTPRequestHandler):
    server_version = "FinishFinnish/0.2"

    def log_message(self, fmt, *args):
        # Quieter default logging.
        print("[%s] %s" % (self.log_date_time_string(), fmt % args))

    def _send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_error_json(self, message, status=400):
        self._send_json({"error": message}, status=status)

    def _serve_static(self, path):
        if path == "/":
            path = "/index.html"
        # Prevent path traversal.
        safe_path = os.path.normpath(path).lstrip("/")
        full_path = os.path.join(PUBLIC_DIR, safe_path)
        if not full_path.startswith(PUBLIC_DIR) or not os.path.isfile(full_path):
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b"Not found")
            return

        ext = os.path.splitext(full_path)[1]
        content_types = {
            ".html": "text/html; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
            ".json": "application/json; charset=utf-8",
            ".png": "image/png",
            ".svg": "image/svg+xml",
            ".ico": "image/x-icon",
        }
        content_type = content_types.get(ext, "application/octet-stream")

        with open(full_path, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)

        if path == "/api/categories":
            return self.handle_get_categories(query)

        m = re.match(r"^/api/category/([a-zA-Z0-9_-]+)$", path)
        if m:
            return self.handle_get_category(m.group(1), query)

        return self._serve_static(path)

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/api/answer":
            return self.handle_post_answer()

        self._send_error_json("Not found", status=404)

    def _direction_from_query(self, query):
        direction = (query.get("mode") or [DEFAULT_DIRECTION])[0]
        return direction if direction in DIRECTIONS else DEFAULT_DIRECTION

    def handle_get_categories(self, query):
        direction = self._direction_from_query(query)
        progress = load_progress()
        result = []
        for cid in list_category_ids():
            cat = load_category(cid)
            if not cat:
                continue
            cards = cat.get("cards", [])
            total = len(cards)
            mastered = 0
            retained = 0
            due_now = 0
            for card in cards:
                entry = card_progress_entry(progress, cid, direction, card["id"])
                if entry.get("mastered"):
                    mastered += 1
                if entry.get("retention", {}).get("retained"):
                    retained += 1
                if is_due_for_review(entry):
                    due_now += 1
            result.append(
                {
                    "id": cid,
                    "name": cat.get("name", cid),
                    "total": total,
                    "mastered": mastered,
                    "retained": retained,
                    "dueForReview": due_now,
                }
            )
        self._send_json({"categories": result, "direction": direction})

    def handle_get_category(self, category_id, query):
        direction = self._direction_from_query(query)
        cat = load_category(category_id)
        if not cat:
            return self._send_error_json("Unknown category", status=404)
        progress = load_progress()
        cards = []
        for card in cat.get("cards", []):
            entry = card_progress_entry(progress, category_id, direction, card["id"])
            retention = entry.get("retention", {})
            cards.append(
                {
                    "id": card["id"],
                    "fi": card["fi"],
                    "en": card["en"],
                    "hint": card.get("hint", ""),
                    "correctStreak": entry.get("correctStreak", 0),
                    "timesSeen": entry.get("timesSeen", 0),
                    "timesCorrect": entry.get("timesCorrect", 0),
                    "mastered": entry.get("mastered", False),
                    "retained": retention.get("retained", False),
                    "reviewStage": retention.get("stage", 0),
                    "nextReviewDue": retention.get("nextReviewDue"),
                    "dueForReview": is_due_for_review(entry),
                }
            )
        self._send_json(
            {
                "id": category_id,
                "name": cat.get("name", category_id),
                "direction": direction,
                "masteryStreak": MASTERY_STREAK,
                "reviewIntervals": REVIEW_INTERVALS,
                "cards": cards,
            }
        )

    def handle_post_answer(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            payload = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            return self._send_error_json("Invalid JSON body")

        category_id = payload.get("category")
        card_id = payload.get("cardId")
        correct = payload.get("correct")
        direction = payload.get("mode", DEFAULT_DIRECTION)

        if not category_id or not card_id or not isinstance(correct, bool):
            return self._send_error_json(
                "Body must include category (str), cardId (str), correct (bool)"
            )
        if direction not in DIRECTIONS:
            return self._send_error_json(f"mode must be one of {DIRECTIONS}")

        cat = load_category(category_id)
        if not cat:
            return self._send_error_json("Unknown category", status=404)
        if not any(c["id"] == card_id for c in cat.get("cards", [])):
            return self._send_error_json("Unknown card", status=404)

        progress = load_progress()
        progress.setdefault(category_id, {})
        progress[category_id].setdefault(direction, {})
        entry = normalize_entry(progress[category_id][direction].get(card_id))
        progress[category_id][direction][card_id] = entry
        retention = entry["retention"]

        today = today_str()
        was_mastered = entry["mastered"]
        was_retained = retention["retained"]
        was_due = is_due_for_review(entry)

        entry["timesSeen"] += 1
        if correct:
            entry["timesCorrect"] += 1
            entry["correctStreak"] += 1
        else:
            entry["correctStreak"] = 0
        entry["mastered"] = entry["correctStreak"] >= MASTERY_STREAK

        newly_mastered = (not was_mastered) and entry["mastered"]

        if newly_mastered:
            retention["stage"] = 0
            retention["firstMasteredDate"] = today
            retention["nextReviewDue"] = add_days(today, REVIEW_INTERVALS[0])
            retention["retained"] = False
        elif was_mastered and entry["mastered"]:
            # Still mastered - this answer only affects the spaced-review
            # schedule if it was actually a scheduled, due check-in.
            if was_due:
                if correct:
                    stage = retention["stage"] + 1
                    if stage >= len(REVIEW_INTERVALS):
                        retention["retained"] = True
                        retention["nextReviewDue"] = None
                        retention["stage"] = stage
                    else:
                        retention["stage"] = stage
                        retention["nextReviewDue"] = add_days(today, REVIEW_INTERVALS[stage])
                else:
                    retention["stage"] = 0
                    retention["nextReviewDue"] = add_days(today, REVIEW_INTERVALS[0])
                    retention["retained"] = False
            # else: extra practice on a not-yet-due card - no SRS effect.
        elif was_mastered and not entry["mastered"]:
            # A miss just knocked the card out of "Learned" entirely;
            # the spaced-review clock resets too.
            retention["stage"] = 0
            retention["firstMasteredDate"] = None
            retention["nextReviewDue"] = None
            retention["retained"] = False

        newly_retained = (not was_retained) and retention["retained"]

        save_progress(progress)
        self._send_json(
            {
                "ok": True,
                "progress": {
                    "correctStreak": entry["correctStreak"],
                    "timesSeen": entry["timesSeen"],
                    "timesCorrect": entry["timesCorrect"],
                    "mastered": entry["mastered"],
                    "retained": retention["retained"],
                    "reviewStage": retention["stage"],
                    "nextReviewDue": retention["nextReviewDue"],
                    "dueForReview": is_due_for_review(entry),
                },
                "newlyMastered": newly_mastered,
                "newlyRetained": newly_retained,
            }
        )


def tailscale_ip():
    """Best-effort lookup of this machine's Tailscale address, so we can
    print a ready-to-use phone URL on startup. Returns None if the
    tailscale CLI isn't installed or the daemon isn't running.

    Checks common install locations directly rather than relying on PATH,
    since launchd (used to auto-start this server) runs services with a
    stripped-down PATH that usually doesn't include /usr/local/bin or
    /opt/homebrew/bin."""
    import subprocess

    candidates = [
        "tailscale",  # rely on PATH, works when run from a normal shell
        "/usr/local/bin/tailscale",  # Homebrew on Intel Macs
        "/opt/homebrew/bin/tailscale",  # Homebrew on Apple Silicon
        "/Applications/Tailscale.app/Contents/MacOS/Tailscale",  # GUI app install
    ]
    for candidate in candidates:
        try:
            out = subprocess.run(
                [candidate, "ip", "-4"], capture_output=True, text=True, timeout=2
            )
            if out.returncode == 0 and out.stdout.strip():
                return out.stdout.strip().splitlines()[0]
        except (FileNotFoundError, OSError):
            continue
    return None


def main():
    port = int(os.environ.get("PORT", "8420"))
    # Bind to all interfaces, not just localhost, so this is reachable from
    # other devices on the LAN and (more usefully) over Tailscale - neither
    # of which requires opening anything to the public internet. See the
    # project README for why this is safe.
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"Finish Finnish running at http://localhost:{port}")
    ts_ip = tailscale_ip()
    if ts_ip:
        print(f"From your phone (via Tailscale): http://{ts_ip}:{port}")
    else:
        print("(Tailscale IP not detected - is `tailscale` installed and running?)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        server.shutdown()


if __name__ == "__main__":
    main()
