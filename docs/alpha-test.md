# MemoryAnchor — alpha sideload test

Thanks for trying this. It is a very early build: the goal is to find out
whether it **installs and runs on real hardware**, not whether it is useful
yet. It is not useful yet. Five minutes of your time is plenty.

MemoryAnchor is an Anki client for iPhone. It embeds Anki's actual engine
rather than reimplementing it, so the interesting question is whether that
engine survives being compiled for iOS and run inside Apple's sandbox. It has
only ever been tested on a simulator and in a desktop browser.

You can import a deck and review cards. Scheduling is Anki's own, so reviews
behave the way you would expect.

## Installing

You will need **AltStore** or **SideStore** set up with your Apple ID
(https://altstore.io). Sideloadly works too.

Download `MemoryAnchor.ipa` from the link you were sent, then install it
through AltStore.

Two things to expect, both normal:

- **The app is unsigned.** AltStore signs it with your own Apple ID during
  install. That is how sideloading works.
- **On a free Apple ID it stops working after 7 days** unless AltStore
  refreshes it. You can delete it after testing; nothing is left behind.

On the home screen it appears as **Anchor** (the short name fits better).

## What to check

Please note what you see for each of these.

1. **Does the install finish?** If AltStore errors, the exact message helps.
2. **Does the home screen label read "Anchor", or is it cut off** like
   "Anchor…"? This is a real question I need answered.
3. **Does it launch without crashing?** This is the main thing being tested.
4. **On the first screen, under "Backend":** does Status say `running`, and is
   there a short code next to "Anki" (something like `4383a70`)? If Status is
   missing or the screen says "MemoryAnchor could not start", that is the most
   useful possible result — please send the message.
5. **Tap "Open collection".** A deck called **Default** should appear
   underneath. This proves the engine can create its database on your phone.
6. **Press Home, wait a minute, reopen the app.** Does it still work, or does
   it hang or crash? iOS suspends apps aggressively and I expect this to be
   the most fragile part.

## If the basics work, try a real deck

5. **Tap "Import deck"** and pick a `.apkg` file. The system file picker opens;
   Files and iCloud Drive both work. A shared deck from
   https://ankiweb.net/shared/decks is a good test. Does the import finish, and
   does the deck appear with a count beside it?
6. **Tap the deck** to study. Does a card appear? Tap "Show answer", then grade
   it. The counts at the top right should change.
7. **If you use AnkiWeb**, tap "Connect AnkiWeb" and sign in. Only do this if
   you are comfortable; see the warning below.

## Please be careful with sync

Sync is new and barely tested. If your AnkiWeb collection matters to you,
**do not sign in on this build**, or make sure you have a backup first
(Anki desktop: File → Export → Anki Collection Package).

If the app says one collection has to replace the other, it will ask which to
keep. That choice is permanent and discards the other side. If you are unsure,
cancel and tell me what it said.

## What does NOT work yet

Please don't report these as bugs — none of it is built:

- Creating or editing decks, notes or cards
- Deck options, custom study, statistics, the card browser
- Audio playback and text-to-speech

## Reporting back

Most useful:

- iPhone model and iOS version
- Which tool you installed with (AltStore, SideStore, Sideloadly)
- What happened at each of the six steps
- A screenshot of the first screen
- Any crash: Settings → Privacy & Security → Analytics & Improvements →
  Analytics Data, look for an entry starting `MemoryAnchor`

A plain "it installed, launched, Status said running, Default showed up" is a
genuinely valuable result. So is "it crashed on launch".
