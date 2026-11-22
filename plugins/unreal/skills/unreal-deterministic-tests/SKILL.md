---
name: unreal-deterministic-tests
description: Tests must be deterministic. Never assert on the wall clock, never sleep or count frames to wait, share no state between tests, assert no order the code does not guarantee, seed randomness, and never retry until green or weaken an assertion. In Unreal this means a fixed time step and fixed seeds, waiting on ready signals and conditions, and no dependence on frame rate or machine speed. Use when writing, reviewing or changing any test in an Unreal Engine project (game tests, automation tests, scripted runs, tool tests), or when a test or scripted run fails intermittently, passes only alone, or gives a different answer on another machine.
---

# Deterministic tests in Unreal

The rule is in every session (`rules/deterministic-tests.md` in this plugin, added at session start): the same
code gives the same result on every run, on any machine, in parallel with other tests. This skill is how to keep
it in an Unreal project. The `unreal-game-tests` skill covers what to test and how to trust a run; read it too.

## In the engine

1. **Fixed time step.** Run scripted tests through the `game-tests` kit (`node Tools/gam3/ue_test.mjs`) or the
   `ue-driver` profiles: they run the game on a fixed time step, so each frame advances game time by the same
   amount however long the frame took. A busy machine makes the run longer and changes nothing in it. A test
   that only passes at real-time speed depends on the machine.
2. **Fixed seeds.** Draw every random number the test depends on from a seeded stream (`FRandomStream(Seed)`, the
   walk bot's `Random()`), never from `FMath::Rand` or the unseeded global stream. Take the seed from the command
   line, default it to a fixed value, and print it in the failure line so the run can be replayed
   (`ue_walk.mjs --seed 1` does this).
3. **Wait on ready signals and conditions.** Start a test from the ready gate's `OnReady` (kit `ready-gate`),
   not after a number of frames or seconds. Inside a test use `WaitUntil("landed", ..., 3)`: it ends as soon as
   the condition holds and its timeout is a named failure. `WaitSeconds` is only for a hold the test is about
   (charging for 1.5 s); `WaitFrames` is never a way to wait for something to finish.
4. **Game time for gameplay, real time for loading.** Gameplay waits count game time, which the fixed step
   makes repeatable. Loading, shader compiles and editor jobs do not speed up with the fixed step: poll the
   thing itself (an instance count that stopped changing, a file that exists, the ready signal) against a
   real-clock deadline. Never sleep a fixed time for either.
5. **No dependence on frame rate or machine speed.** Do not assert a frame count, a frame time or "it took
   less than N ms" in a test: that is a measurement, and belongs to `perf-pass` against a budget. Movement and
   timers under test must use delta time, so the result is the same at any frame rate.
6. **Order.** Do not assert the order of `GetAllActorsOfClass`, overlap results, `TMap`/`TSet` iteration or
   asynchronous load callbacks. Sort by a stable key (name, a test-assigned index) or compare as sets.
7. **Each test starts clean.** A test starts from the level as loaded and leaves nothing held: no input left
   down, no spawned actor, no changed console variable, no save file. Output goes under the run's own directory;
   a run deletes the old log before it starts and reads its verdict only from this run.
8. **One engine per workspace.** Two runs sharing a project directory share `Saved/` and `Intermediate/` and
   break each other. Parallel runs need a workspace each (skill `unreal-parallel`), and wait for an engine slot
   rather than failing when the machine cap is reached.

## Tool and script tests (Node, Python)

The general rules apply unchanged: a private temp directory per test (`fs.mkdtempSync(path.join(os.tmpdir(), ...))`),
port 0, no shared environment, no fixed delays, sorted comparisons.

## Before review

Run each new or changed test ten times and require ten passes: `for i in $(seq 10); do node Tools/gam3/ue_test.mjs
--tests NAME || break; done`. Run it once more while the machine is busy (a build, another engine). For a seeded
test, run at least three seeds. Report the command and the count.

## When a test is flaky

Reproduce it by repeating it under load and record the seed. The usual causes, in order: a delay or frame count
standing in for a signal, a run off the fixed time step, an unseeded random source, an assumed order, state left
by an earlier test or run. Fix the cause. If it cannot be fixed now, take the test out of the gating run with
the reason written next to it and open a tracking issue. Never raise a timeout as the fix, retry until it
passes, or loosen the check.
