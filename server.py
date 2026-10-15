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

There is also a separate, purely informational "Mastery Quiz": a random
deck of QUIZ_SIZE words drawn from everything that's currently Learned or
Retained. Quiz answers are never sent to the server one at a time - only a
finished quiz's score is recorded (in its own file, quiz_history.json) - so
a quiz can never change any card's progress, for better or worse. A second
mode, the "look-alike" quiz, deals Learned words that are spelled alike
back to back (see lookalike_groups), and a "conjugation" mode quizzes the
Learned conjugation cards; scores are kept per mode.

Once a day the server also snapshots both data files into data/backups/,
keeping the newest five of each (see "Daily backups" below).
"""
import json
import os
import random
import re
import threading
from functools import lru_cache
import time
import uuid
from datetime import date, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

ROOT = os.path.dirname(os.path.abspath(__file__))
CARDS_DIR = os.path.join(ROOT, "cards")
# FINNISH_DATA_DIR lets a scratch copy of the server run against throwaway
# data (handy for testing without touching real progress).
DATA_DIR = os.environ.get("FINNISH_DATA_DIR") or os.path.join(ROOT, "data")
PUBLIC_DIR = os.path.join(ROOT, "public")
PROGRESS_FILE = os.path.join(DATA_DIR, "progress.json")
QUIZ_FILE = os.path.join(DATA_DIR, "quiz_history.json")
# Per-card quiz results (how often each card was asked / missed in a quiz).
# Kept apart from progress.json on purpose: quizzes never change progress, so
# this is only a record - the groundwork for a future "rescue" quiz that
# resurfaces cards you keep missing.
QUIZ_CARDS_FILE = os.path.join(DATA_DIR, "quiz_cards.json")
# How many of a card's most recent quiz results are remembered.
QUIZ_RECENT_KEEP = 10

# How many words a Mastery Quiz deck holds. The quiz is only available once
# at least this many distinct words are Learned (or Retained).
QUIZ_SIZE = 40

# Quiz modes. "mastery" is the 40-random-words check-up; "lookalike" drills
# words with similar spellings back to back; "conjugation" is the same random
# check-up over the Learned conjugation cards (which the others leave out). Each keeps its own score history
# (entries in quiz_history.json carry a "mode"; older entries have none and
# are mastery quizzes).
QUIZ_MODES = ("mastery", "lookalike", "conjugation")
DEFAULT_QUIZ_MODE = "mastery"

# A look-alike deck is made only of words that resemble another learned word,
# so it's smaller than QUIZ_SIZE until enough of those pile up. It unlocks at
# this many such words; the deck holds at most QUIZ_SIZE.
LOOKALIKE_MIN_WORDS = 10
# Groups of confusable words are capped at this many, so one big family of
# similar verbs doesn't swallow the whole deck.
LOOKALIKE_GROUP_MAX = 6

# Sets are grouped in the category picker and on the dashboard by an optional
# "group" field in their JSON file; sets without one are plain vocabulary.
DEFAULT_GROUP = "Vocabulary"
CONJUGATION_GROUP = "Conjugations"

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


# The server handles each request on its own thread, and every answer is a
# read-modify-write of one shared JSON file. Without serialising those, two
# answers arriving together (e.g. a double-tap) each read the same snapshot,
# so one answer is silently lost - and, because they used to share one temp
# file, they could also trample each other's write and corrupt the file.
# Hold this around any load -> change -> save sequence. (Plain reads don't
# need it: writes are atomic renames, so a reader sees the old or new file.)
_DATA_LOCK = threading.RLock()


def _write_json_atomic(path, obj):
    """Write JSON so readers never see a partial file: dump to a temp file
    with a name unique to this write, flush it to disk, then rename over the
    target (an atomic swap)."""
    tmp_path = f"{path}.{uuid.uuid4().hex}.tmp"
    try:
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(obj, f, indent=2, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, path)
    except BaseException:
        try:
            os.remove(tmp_path)
        except OSError:
            pass
        raise


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
    _write_json_atomic(PROGRESS_FILE, progress)


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


# --- Daily backups ----------------------------------------------------------
#
# Progress is the one thing here that can't be regenerated, so once per
# calendar day the server copies progress.json and quiz_history.json into
# data/backups/ (named progress-YYYY-MM-DD.json) and keeps only the newest
# BACKUP_KEEP of each, deleting older ones. Data only changes while the
# server is running, so doing this from inside the server - rather than from
# a separate scheduler - can't miss a day because the Mac was asleep.
#
# Two safety rules stop a bad file from ever displacing good backups:
#   - a data file that isn't valid JSON is never backed up, and
#   - neither is one that has lost most of its entries compared with the
#     latest backup (progress only ever grows, so that means data loss).
# In both cases nothing is pruned and a warning is logged.

BACKUP_DIR = os.path.join(DATA_DIR, "backups")
BACKUP_KEEP = 5
BACKUP_CHECK_SECONDS = 15 * 60
BACKUP_SHRINK_LIMIT = 0.5
_BACKUP_SOURCES = (
    ("progress", PROGRESS_FILE),
    ("quiz_history", QUIZ_FILE),
    ("quiz_cards", QUIZ_CARDS_FILE),
)


def _snapshot_size(data):
    """How much a data file holds: answered cards for progress, scores for
    quiz history. Used only to spot a file that has suddenly lost data."""
    if isinstance(data, dict):
        return sum(
            len(entries)
            for modes in data.values()
            if isinstance(modes, dict)
            for entries in modes.values()
            if isinstance(entries, dict)
        )
    if isinstance(data, list):
        return len(data)
    return 0


def _list_backups(stem):
    """[(date, path), ...] for one data file's backups, newest first. Only
    files matching the exact naming pattern are ever considered, so nothing
    else dropped into the folder can be pruned."""
    pattern = re.compile(rf"^{re.escape(stem)}-(\d{{4}}-\d{{2}}-\d{{2}})\.json$")
    found = []
    if os.path.isdir(BACKUP_DIR):
        for name in os.listdir(BACKUP_DIR):
            match = pattern.match(name)
            if match:
                found.append((match.group(1), os.path.join(BACKUP_DIR, name)))
    return sorted(found, reverse=True)


def _backup_one(stem, source, today):
    """Back up one data file if today's backup doesn't exist yet. Returns a
    log line, or None if there was nothing to do."""
    if not os.path.exists(source):
        return None
    existing = _list_backups(stem)
    if existing and existing[0][0] == today:
        return None  # already backed up today

    with _DATA_LOCK:  # a consistent snapshot, never one caught mid-answer
        try:
            with open(source, "r", encoding="utf-8") as f:
                snapshot = json.load(f)
        except (json.JSONDecodeError, OSError) as e:
            return (
                f"WARNING: not backing up {os.path.basename(source)} - it is "
                f"unreadable ({e}). Existing backups kept."
            )

    if existing:
        try:
            with open(existing[0][1], "r", encoding="utf-8") as f:
                previous = _snapshot_size(json.load(f))
        except (json.JSONDecodeError, OSError):
            previous = 0
        current = _snapshot_size(snapshot)
        if previous and current < previous * BACKUP_SHRINK_LIMIT:
            return (
                f"WARNING: not backing up {os.path.basename(source)} - it holds "
                f"{current} entries but the latest backup holds {previous}; "
                f"possible data loss. Existing backups kept."
            )

    os.makedirs(BACKUP_DIR, exist_ok=True)
    dest = os.path.join(BACKUP_DIR, f"{stem}-{today}.json")
    _write_json_atomic(dest, snapshot)
    for _, old in _list_backups(stem)[BACKUP_KEEP:]:
        os.remove(old)
    kept = len(_list_backups(stem))
    return f"Backed up {os.path.basename(source)} -> backups/{os.path.basename(dest)} ({kept} kept)"


def run_daily_backup():
    """Back up each data file if today's backup is missing. Never raises
    (a backup problem must not take the server down); returns log lines."""
    today = today_str()
    lines = []
    for stem, source in _BACKUP_SOURCES:
        try:
            line = _backup_one(stem, source, today)
        except Exception as e:
            line = f"WARNING: backup of {stem} failed: {e}"
        if line:
            lines.append(line)
    return lines


def _backup_loop():
    while True:
        try:
            for line in run_daily_backup():
                print(line, flush=True)
        except Exception as e:
            print(f"WARNING: backup check failed: {e}", flush=True)
        time.sleep(BACKUP_CHECK_SECONDS)


def start_backup_thread():
    """Check at startup and then every 15 minutes, so a server left running
    across midnight still takes the new day's backup."""
    threading.Thread(target=_backup_loop, name="daily-backup", daemon=True).start()


# --- Mastery Quiz -----------------------------------------------------------


def load_quiz_history():
    """Completed quizzes, oldest first. Missing/corrupt file -> empty."""
    if not os.path.exists(QUIZ_FILE):
        return []
    try:
        with open(QUIZ_FILE, "r", encoding="utf-8") as f:
            history = json.load(f)
        return history if isinstance(history, list) else []
    except (json.JSONDecodeError, OSError):
        return []


def save_quiz_history(history):
    _write_json_atomic(QUIZ_FILE, history)


def load_quiz_cards():
    """Per-card quiz stats as {category: {direction: {card_id: stats}}}, the
    same shape as progress. Missing/corrupt file -> empty."""
    if not os.path.exists(QUIZ_CARDS_FILE):
        return {}
    try:
        with open(QUIZ_CARDS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, OSError):
        return {}


def validate_quiz_answers(answers, total):
    """Check the per-card results a client sends with a finished quiz: one
    entry per question, each naming a real card, a real direction and a
    boolean result, with no card repeated. Returns an error string, or None."""
    if not isinstance(answers, list) or len(answers) != total:
        return f"answers must be a list of {total} results"
    cards_by_category = {}
    seen = set()
    for a in answers:
        if not isinstance(a, dict):
            return "each answer must be an object"
        cat, direction, card_id, correct = (
            a.get("category"),
            a.get("direction"),
            a.get("id"),
            a.get("correct"),
        )
        if not (isinstance(cat, str) and isinstance(card_id, str)):
            return "each answer needs a category and id"
        if direction not in DIRECTIONS or not isinstance(correct, bool):
            return "each answer needs a direction and a true/false correct"
        if cat not in cards_by_category:
            category = load_category(cat)
            cards_by_category[cat] = (
                {c["id"] for c in category.get("cards", [])} if category else set()
            )
        if card_id not in cards_by_category[cat]:
            return f"unknown card {cat}/{card_id}"
        key = (cat, direction, card_id)
        if key in seen:
            return "a card can only appear once per quiz"
        seen.add(key)
    return None


def record_quiz_answers(answers):
    """Fold one finished quiz's per-card results into quiz_cards.json. Call
    with _DATA_LOCK held. Never touches progress.json."""
    stats = load_quiz_cards()
    now = datetime.now().isoformat(timespec="seconds")
    for a in answers:
        entry = (
            stats.setdefault(a["category"], {})
            .setdefault(a["direction"], {})
            .setdefault(a["id"], {"asked": 0, "missed": 0, "recent": []})
        )
        entry["asked"] += 1
        entry["lastAsked"] = now
        if not a["correct"]:
            entry["missed"] += 1
            entry["lastMissed"] = now
        # Oldest first; True = got it. Capped so it can't grow forever.
        entry["recent"] = (entry["recent"] + [a["correct"]])[-QUIZ_RECENT_KEEP:]
    _write_json_atomic(QUIZ_CARDS_FILE, stats)


def learned_pool(progress, conjugations=False):
    """Every distinct word that's Learned (or Retained) in at least one
    direction, as (category_id, category_name, card, [directions]).
    Retained words are always Learned too, so 'mastered' covers both.
    The conjugation sets are left out unless conjugations=True, in which
    case they're the only ones included."""
    pool = []
    for cid in list_category_ids():
        cat = load_category(cid)
        if not cat:
            continue
        if conjugations:
            if cat.get("group") != CONJUGATION_GROUP:
                continue
        elif cat.get("quiz") is False:
            # e.g. the conjugation sets: lots of easy, pattern-based cards
            # that would crowd out real vocabulary and inflate scores.
            continue
        for card in cat.get("cards", []):
            directions = [
                d
                for d in DIRECTIONS
                if card_progress_entry(progress, cid, d, card["id"]).get("mastered")
            ]
            if directions:
                pool.append((cid, cat.get("name", cid), card, directions))
    return pool


def _deck_item(entry):
    cid, cat_name, card, directions = entry
    return {
        "category": cid,
        "categoryName": cat_name,
        "id": card["id"],
        "fi": card["fi"],
        "en": card["en"],
        "direction": random.choice(directions),
    }


def build_quiz_deck(progress, conjugations=False):
    """QUIZ_SIZE distinct random words (or conjugation cards, with
    conjugations=True), each quizzed in a direction it's already Learned in.
    None if there aren't enough Learned yet."""
    pool = learned_pool(progress, conjugations)
    if len(pool) < QUIZ_SIZE:
        return None
    return [_deck_item(e) for e in random.sample(pool, QUIZ_SIZE)]


def _edit_distance(a, b, limit):
    """Levenshtein distance, giving up early (returning limit + 1) once it
    can't come in at or under `limit` - all we ever need to know."""
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[-1] + 1, prev[j - 1] + (ca != cb)))
        if min(cur) > limit:
            return limit + 1
        prev = cur
    return prev[-1]


@lru_cache(maxsize=200_000)  # same word pairs recur on every status check
def _look_alike(a, b):
    """True when two Finnish words are spelled alike enough to be mixed up:
    one letter apart, or two apart once both are longer than five letters."""
    a, b = a.lower(), b.lower()
    limit = 1 if min(len(a), len(b)) <= 5 else 2
    return abs(len(a) - len(b)) <= limit and _edit_distance(a, b, limit) <= limit


def lookalike_groups(pool):
    """Groups of 2+ Learned words that resemble each other, from a
    learned_pool(). Single words only (phrases aren't compared). Each group is
    ordered so neighbours are the most alike, and groups are capped at
    LOOKALIKE_GROUP_MAX by slicing that order."""
    words = [e for e in pool if " " not in e[2]["fi"].strip()]
    near = {i: [] for i in range(len(words))}
    for i in range(len(words)):
        for j in range(i + 1, len(words)):
            if _look_alike(words[i][2]["fi"], words[j][2]["fi"]):
                near[i].append(j)
                near[j].append(i)

    groups, seen = [], set()
    for start in range(len(words)):
        if start in seen or not near[start]:
            continue
        order, stack = [], [start]
        while stack:  # depth-first, so each word follows one it resembles
            node = stack.pop()
            if node in seen:
                continue
            seen.add(node)
            order.append(node)
            stack.extend(sorted((n for n in near[node] if n not in seen), reverse=True))
        for k in range(0, len(order), LOOKALIKE_GROUP_MAX):
            chunk = order[k : k + LOOKALIKE_GROUP_MAX]
            if len(chunk) >= 2:
                groups.append([words[i] for i in chunk])
    return groups


def build_lookalike_deck(progress):
    """Up to QUIZ_SIZE look-alike words, with each group of confusable words
    kept together so you have to tell them apart back to back. None if fewer
    than LOOKALIKE_MIN_WORDS such words are Learned."""
    groups = lookalike_groups(learned_pool(progress))
    if sum(len(g) for g in groups) < LOOKALIKE_MIN_WORDS:
        return None
    random.shuffle(groups)
    chosen = []
    for group in groups:
        room = QUIZ_SIZE - len(chosen)
        if room < 2:
            break
        # Only a group's leading words if it doesn't fit whole; its order
        # keeps those the most alike.
        chosen.extend(group[:room] if len(group) > room else group)
    return [_deck_item(e) for e in chosen]


def _mode_history(history, mode):
    return [h for h in history if h.get("mode", DEFAULT_QUIZ_MODE) == mode]


def _recent_and_days(history):
    days_since_last = None
    if history:
        last_date = date.fromisoformat(history[-1]["date"])
        days_since_last = (date.today() - last_date).days
    return list(reversed(history[-5:])), days_since_last  # newest first


def quiz_status():
    history = load_quiz_history()
    progress = load_progress()
    pool = learned_pool(progress)
    learned_words = len(pool)
    recent, days_since_last = _recent_and_days(_mode_history(history, "mastery"))
    lookalike_words = sum(len(g) for g in lookalike_groups(pool))
    la_recent, la_days = _recent_and_days(_mode_history(history, "lookalike"))
    conj_cards = len(learned_pool(progress, conjugations=True))
    conj_recent, conj_days = _recent_and_days(_mode_history(history, "conjugation"))
    return {
        "required": QUIZ_SIZE,
        "learnedWords": learned_words,
        "eligible": learned_words >= QUIZ_SIZE,
        "recent": recent,
        "daysSinceLast": days_since_last,
        "lookalike": {
            "required": LOOKALIKE_MIN_WORDS,
            "words": lookalike_words,
            "eligible": lookalike_words >= LOOKALIKE_MIN_WORDS,
            "recent": la_recent,
            "daysSinceLast": la_days,
        },
        "conjugation": {
            "required": QUIZ_SIZE,
            "words": conj_cards,
            "eligible": conj_cards >= QUIZ_SIZE,
            "recent": conj_recent,
            "daysSinceLast": conj_days,
        },
    }


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

        if path == "/api/quiz/status":
            return self._send_json(quiz_status())

        m = re.match(r"^/api/category/([a-zA-Z0-9_-]+)$", path)
        if m:
            return self.handle_get_category(m.group(1), query)

        return self._serve_static(path)

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/api/answer":
            return self.handle_post_answer()

        if path == "/api/quiz/start":
            return self.handle_post_quiz_start()

        if path == "/api/quiz/complete":
            return self.handle_post_quiz_complete()

        self._send_error_json("Not found", status=404)

    def _read_json_body(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        raw = self.rfile.read(length) if length else b""
        return json.loads(raw or b"{}")

    def handle_post_quiz_start(self):
        try:
            payload = self._read_json_body()
        except json.JSONDecodeError:
            return self._send_error_json("Invalid JSON body")
        mode = payload.get("mode", DEFAULT_QUIZ_MODE) if isinstance(payload, dict) else None
        if mode not in QUIZ_MODES:
            return self._send_error_json(f"mode must be one of {', '.join(QUIZ_MODES)}")

        progress = load_progress()
        if mode == "conjugation":
            deck = build_quiz_deck(progress, conjugations=True)
            locked = (
                f"The conjugation quiz unlocks once at least {QUIZ_SIZE} "
                "conjugation cards are Learned."
            )
        elif mode == "lookalike":
            deck = build_lookalike_deck(progress)
            locked = (
                f"The look-alike quiz unlocks once at least {LOOKALIKE_MIN_WORDS} "
                "similar-looking words are Learned."
            )
        else:
            deck = build_quiz_deck(progress)
            locked = f"The quiz unlocks once at least {QUIZ_SIZE} words are Learned."
        if deck is None:
            return self._send_error_json(locked, status=409)
        self._send_json({"mode": mode, "size": len(deck), "deck": deck})

    def handle_post_quiz_complete(self):
        try:
            payload = self._read_json_body()
        except json.JSONDecodeError:
            return self._send_error_json("Invalid JSON body")
        if not isinstance(payload, dict):
            return self._send_error_json("Invalid JSON body")

        mode = payload.get("mode", DEFAULT_QUIZ_MODE)
        correct = payload.get("correct")
        total = payload.get("total")
        ints = (
            isinstance(correct, int)
            and isinstance(total, int)
            and not isinstance(correct, bool)
            and not isinstance(total, bool)
        )
        if mode == "lookalike":
            # The deck is however many look-alike words there were, up to
            # QUIZ_SIZE (never fewer than the unlock minimum).
            size_ok = ints and LOOKALIKE_MIN_WORDS <= total <= QUIZ_SIZE
        else:  # mastery and conjugation decks are always QUIZ_SIZE
            size_ok = ints and total == QUIZ_SIZE
        valid = mode in QUIZ_MODES and size_ok and 0 <= correct <= total
        if not valid:
            return self._send_error_json(
                "Body must include mode, correct (int) and total (int; "
                f"{QUIZ_SIZE} for mastery/conjugation, {LOOKALIKE_MIN_WORDS}-{QUIZ_SIZE} for lookalike)"
            )
        # Per-card results are optional (older pages don't send them), but
        # when present they must be consistent with the score.
        answers = payload.get("answers")
        if answers is not None:
            problem = validate_quiz_answers(answers, total)
            if problem is None and sum(1 for a in answers if a["correct"]) != correct:
                problem = "answers don't add up to the score"
            if problem:
                return self._send_error_json(problem)

        with _DATA_LOCK:
            if answers is not None:
                record_quiz_answers(answers)
            history = load_quiz_history()
            history.append(
                {
                    "completedAt": datetime.now().isoformat(timespec="seconds"),
                    "date": today_str(),
                    "mode": mode,
                    "correct": correct,
                    "total": total,
                    "percent": round(100 * correct / total),
                }
            )
            save_quiz_history(history)
        self._send_json({"ok": True, **quiz_status()})

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
                    "group": cat.get("group", DEFAULT_GROUP),
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
                "group": cat.get("group", DEFAULT_GROUP),
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

        with _DATA_LOCK:
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
    # First thing, so nothing below (e.g. the slow-ish Tailscale lookup) can
    # delay today's backup.
    start_backup_thread()
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
