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
- **Dashboard** — per-category and per-direction progress at a glance.

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
card file changes (only for changes to `server.py` itself).

## Data

Progress is stored locally in `data/progress.json` (not committed to this
repo — it's your personal learning data, not part of the app).
