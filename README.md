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
