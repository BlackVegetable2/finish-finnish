# Finish Finnish 🇫🇮

A local flashcard app for learning Finnish vocabulary, with spaced-repetition
tracked long-term mastery.

Runs entirely on your machine — pure Python 3 standard library backend
(no `pip install` needed) and a vanilla HTML/CSS/JS frontend (no build step).

## Running it

```bash
python3 server.py
```

Then open <http://localhost:8420>.

## Features

- **Flashcards** — Finnish on one side, English on the other. Click the card
  or press <kbd>Space</kbd> to flip; <kbd>Space</kbd> again = Got it,
  <kbd>Shift</kbd> = Missed it.
- **Two study directions** — Finnish → English and English → Finnish, tracked
  as completely separate progress.
- **No repeats within a set** — each pass shuffles the deck and shows every
  card once before offering to repeat or switch sets.
- **Two mastery tiers**:
  - **Learned** — three correct answers in a row.
  - **Retained** — correct recall on spaced check-ins (roughly 2, 4, then 8
    days out) spanning about two weeks after being Learned. This is a
    lightweight spaced-repetition schedule, in the spirit of Anki/SRS.
- **Word-trick hints** — every card has an optional mnemonic connecting the
  sound of the Finnish word to its English meaning (e.g. *antaa* ("to give")
  ↔ "ants are giving").
- **Dashboard** — per-category and per-direction progress at a glance, plus a
  badge/banner showing which sets currently owe a retention check-in.
- **Mastery Quiz** — once at least 40 distinct words are Learned or Retained,
  a **Quiz** tab appears. It deals 40 random such words (each in a direction
  you've already learned it), self-graded like the flashcards, and ends with a
  % score. It is deliberately isolated from progress: answers stay in the
  browser and only the finished score is saved, so a miss never costs
  anything. The Dashboard tracks your last 5 scores and the days since your
  last *completed* quiz. Words are shown without their set name, and leaving
  the Quiz tab partway abandons the quiz without recording anything.
- **Look-alike Quiz** — a second quiz mode for words that are easy to mix up
  (*ottaa* / *ostaa*, *veli* / *vesi*, *Tanska* / *Ranska*). It looks at your
  Learned single words and groups the ones spelled alike (one letter apart, or
  two for longer words), then deals each group back to back so you have to tell
  them apart straight away. It holds up to 40 words — fewer while you have few
  look-alikes — and unlocks at 10. Like the Mastery Quiz it never changes any
  progress, and it keeps its own last-5 scores and days-since on the Dashboard.
  Quiz history entries carry a `mode` (`mastery` or `lookalike`); older entries
  without one count as mastery.

## Adding your own word sets

Drop a new JSON file in `cards/`, e.g. `cards/animals.json`:

```json
{
  "name": "Animals",
  "cards": [
    { "id": "a01", "fi": "karhu", "en": "bear", "hint": "\"car-hoo\" — a bear honking a car horn" }
  ]
}
```

It shows up in the category picker automatically — no restart required for
card file changes (only for changes to `server.py` itself). `hint` is optional;
a card without one just doesn't show the Word trick button.

Two optional top-level fields control how a set is treated:

- `"group": "Conjugations"` — sets are grouped under this heading in the
  category picker and on the Dashboard (each group gets its own totals and
  table). Sets without a `group` are listed as "Vocabulary".
- `"quiz": false` — keeps the set out of the Mastery Quiz's word pool.

### Conjugation sets

`cards/conjugations_i1.json` … `iv4` drill the present tense of the 80 verbs
in Common Verbs I–IV, 8 forms each (minä, sinä, hän, me formal/written, me
spoken, te/y'all, he formal/written, ne spoken) — 5 verbs / 40 cards per set,
four sets per book (`I-1` … `IV-4`), ordered within each book from the most
regular verbs to the trickiest (consonant changes last). The Finnish side
includes the pronoun (`me mennään`, `ne menee`), so each card is unambiguous.
They're in the `Conjugations` group, excluded from the quiz, and have no
hints. Both "we" and "they" have a spoken alternative alongside the
formal/written one — spoken "we" is the passive (`mennään`), and spoken
"they" is `ne` + the same singular form as `hän` (`ne menee`, not `ne
menevät`). The forms were written by hand and checked for internal
consistency, not against an authoritative source, so check a set against a
textbook or dictionary before drilling it.

## Data

Progress is stored locally in `data/progress.json`, and completed quiz scores
in `data/quiz_history.json` (neither is committed to this repo — it's your
personal learning data, not part of the app).

### Backups

Once a day (checked at startup and every 15 minutes after, so a server left
running across midnight still takes the new day's backup) the server copies
both files into `data/backups/` as `progress-YYYY-MM-DD.json` and
`quiz_history-YYYY-MM-DD.json`, and keeps only the newest 5 of each — older
ones are deleted. Backups are gitignored, like the data itself. Each one is a
validated snapshot, so it's always a readable file.

Two rules keep a bad file from pushing good backups out of the five:

- A data file that isn't valid JSON is **not** backed up.
- A file that has lost more than half the entries of the latest backup is
  **not** backed up either (progress only ever grows, so a big drop means data
  loss). Restoring an older backup is fine — it's nowhere near that drop.

In both cases nothing is deleted, and a `WARNING: not backing up …` line is
written to the server log (`~/Library/Logs/finish-finnish/server.log` if you
use the launchd agent). If you ever deliberately start over from scratch,
clear `data/backups/` so the old snapshots don't trip that second rule.

To restore, copy the backup you want over the live file — ideally while
you're not mid-session, since a restore overwrites whatever's there:

```bash
cp data/backups/progress-2026-10-03.json data/progress.json
```

To try things out without touching your real data, run a scratch copy on
another port against a throwaway data folder:

```bash
FINNISH_DATA_DIR=/path/to/scratch PORT=8421 python3 server.py
```

## Using it on your phone

The server binds to all network interfaces (`0.0.0.0`), not just
`localhost`, so it's reachable from other devices — but nothing is exposed
to the public internet unless you explicitly port-forward, which this setup
doesn't need.

1. **Install [Tailscale](https://tailscale.com/)** on this machine and on
   your phone, signed into the same account. It's a private mesh VPN: your
   phone and this Mac get a stable address that only reach each other,
   with no router configuration and no public exposure.
2. **Find the URL** — either your Mac's Tailscale IP (`tailscale ip -4`) or,
   better, its stable MagicDNS hostname (`tailscale status --json` →
   `Self.DNSName`), since the hostname doesn't change even if the
   underlying IP does.
3. **Add it to your phone's home screen** — open that URL in your phone's
   browser, then use "Add to Home Screen" / "Install app" from the browser
   menu. The app ships a PWA manifest and icon (`public/manifest.json`,
   `public/icons/`) so this gets a real home-screen icon. Note: a fully
   standalone (chrome-less) install typically requires HTTPS, which plain
   `http://<tailscale-ip>` doesn't have — the icon and app still work fine,
   it may just open inside a normal browser tab rather than a standalone
   window.
4. **Keep it running** — see `launchd/` below so you don't have to manually
   start the server every time.

### Auto-starting the server (`launchd/`)

`launchd/com.devinekins.finish-finnish.plist` is a macOS LaunchAgent that
starts the server automatically at login and restarts it if it ever
crashes. To install it on a Mac (adjust the hardcoded paths inside first if
your username/path differs):

```bash
cp launchd/com.devinekins.finish-finnish.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.devinekins.finish-finnish.plist
```

Logs land in `~/Library/Logs/finish-finnish/`. This starts the server at
*login*, not at raw power-on before anyone logs in — a true boot-time
LaunchDaemon needs `sudo` and isn't set up here.
