---
name: unreal-game-tests
description: How to write and trust automated tests that run inside an Unreal Engine game - steps and named checks in C++ that send input through the real engine path, run unattended with no renderer, and are proven to fail before the fix. Use when a bug was found by hand and must not come back, when adding or changing input, movement, combat, menus, pause or any player-facing behaviour, when a scripted run gives a different answer from one run to the next, when a test passes but the bug is still there, or when deciding what a passing run actually proves.
---

# Tests that run inside the game

A bug found by hand is found once. Written as a test it is found every time, in seconds, with nobody watching.
The `game-tests` kit runs tests that are part of the game: `node Tools/gam3/ue_test.mjs --tests all`.

## Rules for writing a test

1. **Every bug found by hand becomes a test before it is fixed.** Write the test, watch it fail, fix the bug,
   watch it pass. In that order.
2. **A test that has never failed proves nothing.** Run each new test once against the code before the fix with
   `--expect-fail`. If it passes there, it does not detect the bug: it is checking something else. The same goes
   for a test written after the fix: turn the fix off (rule 8) and see the test fail.
3. **Input goes in where the player's input goes in.** `Hold(EKeys::W)`, `Click`, `TapTouch`. Never set the
   pawn's velocity, call the ability's function or write the game's state directly: that tests the function and
   skips the bindings, focus and UI where input bugs actually live.
4. **One fact per check, and the name says the fact.** `Check("arrow consumed", ...)`, not `Check("works", ...)`.
   A failure line should tell someone who has not read the test what is broken.
5. **Wait for conditions, not for time.** `WaitUntil("landed", ..., 3)` rather than `WaitSeconds(2)`: it is
   faster when things are quick and its timeout is a named failure when they are not. Use `WaitSeconds` only
   for a hold the test is about (charging an attack for 1.5 s).
6. **Tests do not depend on each other.** Each starts from the level as loaded and leaves nothing held. Give a
   test that needs a place or a state a switch that starts the game there (rule 9).

## Rules for trusting a run

7. **The verdict comes from this run only.** `ue_test.mjs` deletes the old log first and reports
   `no_verdict=1` as FAILED when the game never wrote its summary. Never read a result from a file a previous
   run could have left, and never treat "no failure line" as a pass.
8. **Fixed time step, always.** Scripted runs use it at every profile. Without it a stall (a screenshot, a
   shader compile, a busy machine) drops simulation ticks, and a tap becomes a hold. With it a run on a slow
   machine takes longer and does exactly the same thing.
9. **Check what the run could not test.** The log's note line `input=viewport-client` means there was no
   window: bindings were tested, menus were not. Run UI tests at `--profile agent`.
10. **Keep the pointer off the window** in runs that have one. Stray key and mouse events are swallowed, but a
    cursor resting over a button still makes it hover.

## Rules for the game's code, so it can be tested

11. **Keep a switch for each fix that changes behaviour or cost.** A command-line flag that turns the fix off
    (`-NoEffectPrewarm`, `-OldAim`). It lets the test be proved against the old behaviour, lets the gain be
    measured again later, and makes "did that change break it" a one-run question.
12. **Add test-only switches for big content**: start the player at a given place, start at a given wave, hold
    a given UI state on screen. A test that must play ten minutes to reach its subject will not be run.
13. **Debug text is off by default.** On-screen debug lines, stat overlays and placeholder labels sit behind a
    console variable that defaults to off, so every capture shows what a player sees and a stray debug line in
    a capture is itself a bug.
14. **Diagnostics for packaged builds go to a plain file.** A Shipping build has no log. A problem that only
    happens there (window placement, cursor lock, a device's safe area) needs a switch that appends lines to a
    text file under the game's saved directory.

## A trap in unattended editor runs

An editor started unattended answers **Yes** to modal dialogs. An import that asks "the skeleton does not match,
regenerate it?" then rewrites a shared asset, and everything that used it breaks later, somewhere else. After any
scripted import: read the log for what was matched, and run `git status` to see which assets changed. A shared
asset that changed when you only meant to add a file is the sign.

## What these tests do not replace

- The `walk-bot` kit finds movement problems nobody thought to write a test for.
- `perf-pass` measures cost; a test only says right or wrong.
- Whether something feels good is a person's call.
