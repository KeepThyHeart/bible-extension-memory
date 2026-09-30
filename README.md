# Scripture Memory

  > Thy word have I hid in mine heart, that I might not sin against thee. (Psalms 119:11)

_Note: This extension is not ready for a real package quite yet; it is in the final stages of development for a beta release.  Stay tuned for updates!_

An extension to assist in memorizing Bible verses and passages, inside of the Keep Thy Heart Bible desktop app.

## Loading it in the app

For development:

```
npm install
npm run build
```

Then in the app: **Preferences → Extensions → Developer Mode → Load unpacked extension...** and pick this folder. `npm run watch` in a terminal rebuilds on save and the host re-reads the output.

### Permissions

"Load unpacked" opens a consent dialog listing everything the manifest asks for, all ticked. Click **Install**, then **Enable** (an unpacked extension arrives disabled) and **Activate** it, or restart the app.

If you untick anything, the extension cannot open its database and comes up **inert**. In **Preferences → Extensions → Details…**, grant Scripture Memory:

- `storage:database` — its plan, schedule and history
- `ui:contribute-pane` — the panel
- `ui:context-menu` — "Add to memorization plan" on a verse
- `ui:status-bar` — the due count
- `ui:notification` — confirmations

Then **reload the extension**. It does not pick up a new grant on its own.

If you skip this it fails legibly rather than mysteriously: the extension log names the exact permissions to grant, and the panel says the same thing instead of showing an empty plan as though you had never added anything.

To produce the installable archive instead:

```
npm run package      # builds, then writes build/<id>-<version>.zip
```

### If you re-pack the SDK

`@bible/core` here resolves to a **local tarball** (`npm run pack:sdk` in the Bible repo). Re-packing rewrites that tarball but does not change its version, so npm happily serves the previous copy from its cache — and any later `npm install` in this project silently reverts you to it. The symptom is compile errors about API that demonstrably exists, e.g. `Property 'listChapters' does not exist on type 'IBibleApi'`.  You can force it to install this way, *after* any other `npm install`, not before:

```
npm install --no-save --force ../bible/build/sdk/bible-core-0.1.0.tgz
```

## What it does

**Add a passage.** Right-click any verse → *Add to memorization plan*, or open **Manage Passages** from the home screen and type a reference into the field there ("John 3:16-18", "Psalm 23", "Phil 4:13"). Whole chapters resolve to their real extent. Passages are capped at 25 verses, because the exercises stop being useful past that and the panel message cap is finite. With nothing in your plan yet, the home screen offers a one-press "Add \<verse> and start" using whatever you are currently reading - that is the one add-passage shortcut that still lives there; every other way of adding is on Manage Passages.

**Adding several at once.** On Manage Passages, paste a list into the add-passage field - one reference per line, or several references sprinkled through a paragraph of ordinary text ("check out John 3:16 and also Romans 8:28 today") - and the parsed list is shown back to you for an "Add N passages" / Cancel confirmation before anything is sent to the worker. Confirming adds every one in turn, reported as "Added 12 passages" (or the mix of successes and failures, each with the worker's own reason, if some do not parse). A batch that names both a range and one of its own verses ("John 3:16-17" and "John 3:16") collapses to the one that actually covers the practice - the narrower one is added and then removed again, and the announcement says so ("... already covered by another passage in this batch"). This is the answer to a plan with more passages than anyone is going to type in one at a time; there is no importer or file format yet, just the paste.

**Suggested lists.** Manage Passages also offers a gallery of built-in lists - ten to twelve verses apiece, each with a one-line description of what it is for: a starter set that carries most of the gospel, the Romans Road, a psalm or the Beatitudes in full, promises for anxious days, the fruit of the Spirit, the Ten Commandments, and a few others (see `src/suggestedLists.ts` for the exact set and references). "Copy references" from a suggested list drops its verses straight into the add-passage field's paste-batch confirmation, so adding one is the same "Add N passages" flow as pasting your own list - nothing is added silently.

**Several memorization lists.** A passage belongs to exactly one list. A new plan starts with a single list named "Default"; Manage Passages lets you create more, rename or delete any of them (deleting a list that still holds passages asks where to move them first, defaulting to Default), and move an existing passage from one list to another. The home screen's title bar shows a list picker once you have more than one list, offering "All Lists" alongside each one by name; Manage Passages shows the same picker unconditionally, since choosing which list to manage is that screen's whole job. Whichever list (or "All Lists") is currently selected is the scope for practically everything else - what the plan screen lists, what "Practice" and the shuffle draw from, what counts toward the 25-verse reference-activity threshold below, and what the Analytics screen's counts are drawn from.

**Removing a passage.** "Remove…" on a passage's row in Manage Passages asks for a second confirming click only if the passage has actually been practiced - removing deletes its attempt history, which is the one thing worth protecting. A passage that was added but never practiced is removed on the first click, with nothing to confirm.

**Practice it. Mostly nothing is locked.** Each passage has up to five activities:

| Activity | What you do | Applies to |
|---|---|---|
| `ordering` | "Which verse comes next?" — pick from four | multi-verse passages |
| `refmatch` | "Which reference is this?" — choose from four, in three difficulty tiers (any book, same genre, same book) | a single verse, when there are others to confuse it with, and the list has 25 verses or more |
| `blanks` | Type the missing words, in an easier and a harder tier | everything |
| `firstletters` | Every word is hidden; type the whole verse, in an easier and a harder tier | everything |
| `refprovide` | Given the words, type the reference from memory | any passage, once the list has 25 verses or more |

They are a *suggested* order, not a promotion gate — v1 dropped the four-state ladder (`locked → learning → review → mastered`) that v0 had, and every activity a passage's material allows is practisable at any time; every attempt counts and reschedules, and the passage screen just badges whichever one is due, or otherwise most worth doing next, as "Suggested". *Which* activities a passage's material allows is a separate question, and two things genuinely gate an activity rather than merely suggesting an order: `ordering` needs more than one verse, and `refmatch`/`refprovide` - "the reference activities" - need the current list (or, viewing "All Lists," the whole plan) to hold **25 verses or more**, so a picker or a recall prompt always has enough real references to be a meaningful question rather than the only guess available. Below that threshold, the plan screen's activity picker shows the reference activities as unavailable with a running count of verses still needed, and the passage screen's own row explains the same thing. A lone verse in an empty plan cannot be ordered and has no sibling to be confused with, so it starts on `blanks` - that is the state of every plan on the day it is created.

**Difficulty tiers, and completeness-based levels.** Every activity now has one or more difficulty tiers - harder renderings of the same exercise, not a different one: `refmatch` goes any-book → same-genre → same-book, and `ordering`/`blanks`/`firstletters` each go an easier and a harder round; `refprovide` has just the one. An activity's level (the five boxes below) is **not** just "how did the last attempt go" - it is completeness (how many of its tiers have ever been passed) multiplied by accuracy (the best score on any attempt), so acing the easy tier alone reads as "half done well," not "mastered." Passing every tier, well, is what fills all five boxes. Crucially, **a level cannot fall on its own**: every number that feeds it is a best-ever or a count since the passage's history began (or since it was last reset), so a bad session shortens the review interval but never erases progress already shown. The only way a level goes down is an explicit **"Reset progress for this passage"**, behind a confirmation, in the settings modal on the passage screen.

**Levels, not states.** On a passage's own screen, each activity shows five boxes: grey for not yet reached, yellow at levels 1–3, green at 4–5, and faded green when a mastered activity has come due for review again. A level earned on a *harder* activity in the recall chain (`ordering` → `blanks` → `firstletters`) counts for the whole passage - acing `firstletters` alone satisfies `ordering` and `blanks` too, without implying they were themselves worked through. (The reference activities are deliberately not part of that chain: knowing a passage's words cold says nothing about being able to name its address, and the reverse doesn't hold either.) A passage is marked **"Well learned"** once *every one of its applicable activities* is satisfied this way - not just its single best one - which is stricter than "something hit level 4" and is never true of a passage with nothing applicable to test yet. The plan list shows the same idea more compactly, one small square per activity: grey (never tried), orange (tried, not yet mastered), green (mastered), or light green (not mastered itself, but carried by a harder one).

**One button that decides.** Both the home screen and each passage's own screen lead with a single "Practice" (or "Resume practicing") button that starts whichever activity is due or otherwise most worth doing next. The home screen also offers a shuffle control and an activity picker beside it, for practicing a specific kind of exercise on purpose rather than whatever comes up next. The per-activity rows on a passage's own screen are still there to pick something else on purpose, but nobody has to read five of them just to start.

**Answering.** By default you type only the first letter of each hidden word; a correct letter reveals the whole word, and there is no partial reveal before that. Typing the whole word, spelled out, is an option - set globally in Settings, or per passage behind the gear icon on that passage's own screen, which opens a small settings modal (the answer-mode override and "Reset progress" live there together) rather than revealing controls inline - tucked away rather than shown open, since these are rarely-touched preferences and not what the screen needs to lead with.

**Keyboard shortcuts.** The ordering, "Match the reference" and "Provide the reference" pickers all support pressing a candidate's own letter (A, B, C…) instead of clicking it, so a whole round can be answered without leaving the keyboard.

**It comes back.** Passing an activity schedules it at 1, 3, 7, 16, 35, 90 then 180 days. Failing badly sends it back to the start; failing mildly steps back one. That interval - not the level - is the only thing one bad session can move.

Due dates carry ±15% jitter. That is not decoration: the schedule is deterministic, so without it everything you add on one Sunday afternoon comes due together *forever*.

**Leaving and coming back.** Every screen has a Back arrow, including mid-activity - your position is written to disk after each verse, so Back genuinely picks up later rather than discarding the attempt. The passage screen offers Restart alongside Resume for anything left mid-way.

**A plan bigger than one screen.** Finishing an activity offers "Next due", which jumps straight to whatever else in the whole scope is due - another activity on the same passage, or a different passage entirely - without a trip back through the list. Useful the moment a plan holds more passages than fit on one screen.

**Analytics.** A streak of consecutive practice days, a running total of verses genuinely learned, a five-week practice calendar, a list of recently reached milestones, and the next round number of verses to aim for. "Verses learned" and "passages well learned" both use the same "well learned" rule as the passage screen's badge, and both are scoped to whichever list (or "All Lists") is currently selected - switch lists on the home screen and this screen's numbers switch with it.

## Known limitations

- **Module choice.** New passages are recorded against the translation you are reading, which the host reports with the active verse and with each context-menu click. Until it has reported one (a reference typed before any verse was chosen), the first installed module is used. The module is stored per passage, so a passage keeps its translation.
- **Right-click adds what you clicked.** The host passes the clicked verse - or a contiguous selection within one chapter, up to 25 verses - to the command. The palette command "Add this verse to my plan" uses the active verse instead.
- **Verse labels** ("3:16") are derived from the host's verse-id arithmetic, which is inferred rather than contracted. It is checked once at activation against real host data; if it ever stops holding, labels degrade to bare ids rather than showing a wrong address.
- **Status bar limitation.** There is no `ui.updateStatusBarItem` on the platform (yet), so changing the due count means disposing and re-registering the item.

## Layout

```
src/
  main.ts        worker entry: activation, host contributions, panel protocol
  types.ts       domain types and the panel <-> worker contract
  db.ts          schema and migrations (no PRAGMA — the SQL guard rejects it)
  store.ts       every read and write; the only SQL in the extension
  ladder.ts      which activities apply, tiers, and the 0-5 completeness-based level
  scheduler.ts   the interval ladder and jitter
  session.ts     the in-flight exercise; lives in the worker, not the panel
  verses.ts      host verse DTOs -> renderable text, tokenised once
  reference.ts   "John 3" -> a verse-id range
  suggestedLists.ts  the built-in verse lists offered on Manage Passages
  exercises/     scoring: ordering, blanks, first letters, references, word normalisation
  ui/            panel views (browser DOM; separate tsconfig and bundle)
    planView.ts             home: "Practice", the activity picker and the plan list
    managePassagesView.ts   add/remove passages, lists, and the suggested-lists gallery
    passageView.ts          one passage's activities, levels and resume/restart
    analyticsView.ts        streaks, verses learned, the practice calendar
    settingsView.ts         the global answer-mode default and its overrides
    practiceView.ts         the exercise runner itself
test/
  sqliteHarness.ts   a REAL in-memory SQLite, not a fake
```

The worker and the panel are bundled separately and have different rules: the worker targets a QuickJS realm with no DOM and no Node built-ins, the panel targets a browser iframe under a CSP that forbids inline scripts.

## Technical Details
  * Written using Claude Code
