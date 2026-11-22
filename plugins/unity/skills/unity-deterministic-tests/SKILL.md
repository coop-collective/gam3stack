---
name: unity-deterministic-tests
description: Tests must be deterministic. Never assert on the wall clock, never sleep or count frames to wait, share no state between tests, assert no order the code does not guarantee, seed randomness, and never retry until green or weaken an assertion. In Unity this means a fixed time step and fixed seeds, waiting on ready signals and conditions, and no dependence on frame rate or machine speed. Use when writing, reviewing or changing any test in a Unity project (EditMode, PlayMode, editor methods, tool tests), or when a test or batch run fails intermittently, passes only alone, or gives a different answer on another machine.
---

# Deterministic tests in Unity

The rule is in every session (`rules/deterministic-tests.md` in this plugin, added at session start): the same
code gives the same result on every run, on any machine, in parallel with other tests. This skill is how to keep
it in a Unity project. The `unity-batch-loop` skill covers how to run tests and read the result; read it too.

## In the engine

1. **Fixed time step.** Run PlayMode tests of logic with `node Tools/gam3/unity_run.mjs test --platform PlayMode
   --profile blind` (kit `unity-driver`). The `blind` and `agent` profiles set `Time.captureDeltaTime`, so each
   frame advances game time by the same amount however long the frame took. A busy machine makes the run longer
   and changes nothing in it. A test that only passes at real-time speed depends on the machine.
2. **Fixed seeds.** Seed every random source the test depends on: `Random.InitState(seed)` for `UnityEngine.Random`,
   or better a `new System.Random(seed)` owned by the system under test, so another test cannot move its state.
   Use a fixed default seed and put it in the assertion message so a failure can be replayed.
3. **Wait on ready signals and conditions.** Start from the ready gate (`ReadyGate.IsReady`, its `Ready` event,
   kit `ready-gate`), not after a number of frames or seconds. In a `[UnityTest]`, wait for the condition with a
   bound and a message: loop `yield return null` until the condition holds or the bound is reached, then assert
   the condition. `WaitForSeconds` and a bare frame count are never a way to wait for something to finish.
4. **Game time for gameplay, real time for loading.** Gameplay waits use `Time.time`, which the fixed step makes
   repeatable; `Time.realtimeSinceStartup` in a gameplay wait makes a fast run slow and a slow machine fail.
   Asset loads, imports and compiles do not speed up with the fixed step: wait on their own completion (the
   handle's `isDone`, the ready signal) against a real-clock deadline. Never sleep a fixed time for either.
5. **No dependence on frame rate or machine speed.** Do not assert a frame count, a frame time or "it took
   less than N ms" in a test: that is a measurement, and belongs to `perf-pass` against a budget. Code under
   test moves by `Time.deltaTime`, or runs in `FixedUpdate`, so the result is the same at any frame rate.
6. **Order.** Do not assert the order of `FindObjectsByType`, physics query results, `Dictionary`/`HashSet`
   iteration, or the `Awake`/`Start` order of unrelated objects. Sort by a stable key or compare as sets.
7. **Each test starts clean.** Create what the test needs in `[SetUp]` and destroy it in `[TearDown]`: objects,
   scenes, `PlayerPrefs` keys, static fields, `Time.timeScale`. Files go in a private temp directory, never
   under `Assets/` or a fixed path. A test must pass alone and in any order with the others.
8. **Pixels need a renderer.** A PlayMode test that reads pixels skips itself under `blind`
   (`SystemInfo.graphicsDeviceType == GraphicsDeviceType.Null`) instead of failing.
9. **One editor per workspace.** A project directory can have one editor. Parallel runs need a workspace each
   (skill `unity-parallel`), and wait for an engine slot rather than failing when the machine cap is reached.

## Tool and script tests (Node)

The general rules apply unchanged: a private temp directory per test (`fs.mkdtempSync(path.join(os.tmpdir(), ...))`),
port 0, no shared environment, no fixed delays, sorted comparisons.

## Before review

Run each new or changed test ten times and require ten passes: `for i in $(seq 10); do node Tools/gam3/unity_run.mjs
test --platform PlayMode --profile blind --filter NAME || break; done`. Run it once more while the machine is busy (a build,
another editor in its own workspace). Report the command and the count.

## When a test is flaky

Reproduce it by repeating it under load and record the seed. The usual causes, in order: a delay or frame count
standing in for a signal, a run off the fixed time step, an unseeded random source, an assumed order, state left
by an earlier test. Fix the cause. If it cannot be fixed now, take the test out of the gating run with the
reason written next to it (`[Ignore("...")]` or a non-gating category) and open a tracking issue. Never raise a
timeout as the fix, retry until it passes, or loosen the check.
