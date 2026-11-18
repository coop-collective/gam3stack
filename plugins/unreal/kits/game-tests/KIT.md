# game-tests

Tests that run inside the real game and press the real buttons. A test is a C++ class in your game module; its
steps and checks read top to bottom, and one command runs them with no renderer and gives a verdict:

    node Tools/gam3/ue_test.mjs --tests WalkForwardTest,PauseMenuTest
    node Tools/gam3/ue_test.mjs --tests all --map L_Level
    # -> GAM3TEST: FAIL PauseMenuTest.game_paused the world kept ticking with the menu open
    #    GAM3TEST: FAILED tests=2 passed=5 failed=1 no_verdict=0 profile=blind ready=ok log=...

## Writing a test

    #include "Gam3GameTest.h"

    UCLASS()
    class UWalkForwardTest : public UGam3GameTest
    {
        GENERATED_BODY()
        double StartX = 0.0;
        virtual void Build() override
        {
            Step(TEXT("remember where we are"), [this] { StartX = Pawn()->GetActorLocation().X; });
            Step(TEXT("walk forward"), [this] { Hold(EKeys::W); });
            WaitSeconds(1.f);
            Step(TEXT("stop"), [this] { Release(EKeys::W); });
            Check(TEXT("moved"), [this] { return Pawn()->GetActorLocation().X > StartX + 100.0; }, TEXT("the pawn did not move forward"));
            WaitUntil(TEXT("stopped"), [this] { return Pawn()->GetVelocity().IsNearlyZero(1.0); }, 3.f);
        }
    };

Nothing to register: the runner finds every class derived from `UGam3GameTest`. The name on the command line is
the class name without its `U`.

| In `Build()` | Does |
| --- | --- |
| `Step(name, code)` | Runs the code once |
| `WaitSeconds(s)`, `WaitFrames(n)` | Game time; the same number of frames on every run |
| `Check(name, condition, why)` | One named fact. A failure is logged and the test goes on |
| `WaitUntil(name, condition, timeout)` | Passes when the condition comes true; the timeout is a failure and ends the test |
| `TapKey(key)`, `Click(where)`, `TapTouch(where)` | Down, hold, up |

| Inside a step | Goes in through |
| --- | --- |
| `Hold(key)`, `Release(key)` | Slate's key events, as a keyboard does |
| `MoveMouse(where)`, `MouseDown()`, `MouseUp()` | Slate's pointer events. `where` is 0,0 top left to 1,1 bottom right of the game picture |
| `TouchBegin(finger, where)`, `TouchMove`, `TouchEnd` | The game viewport's touch input |
| `HoldAction(name, value)`, `ReleaseAction(name)` | Enhanced Input, injected every frame. Skips the key mapping: use it for analogue values only |
| `Fail(name, why)` | Reports a failure found in a step |

Whatever a test still holds when it ends, pass or fail, is released, so one test cannot leave a key down for the
next.

## Running

- **Default profile is `blind`**: no renderer, a fixed time step. Seven test classes of the test project ran
  in one start of the engine.
- **`--shots-on-fail`** writes `Saved/Screenshots/test_<Test>_<check>.png` at each failing check. From a blind
  run the failing tests are run again at the `agent` profile; runs repeat exactly, so it is the same failure.
- **`--expect-fail`** is ok only when a check fails. Run every new test once this way against the code before
  the fix. A test that is not found or checks nothing does not count as that failure.
- **The verdict is this run's log.** The log is deleted before the run. No `SUMMARY` line (a crash, a hang, the
  level never starting, the kit not compiled in) is `FAILED ... no_verdict=1`.

## What a run without a window cannot test

With no renderer there is no window for Slate to route events to. The runner then hands keys and buttons to the
game viewport client directly (the log says `input=viewport-client`):

- Key and button bindings, touch presses and Enhanced Input actions work.
- **Menus and other Slate UI are not exercised**, and the mouse and touch positions mean nothing (the picture
  is 0 by 0). Run UI tests with `--profile agent`.

With a window (`input=slate`):

- An uncaptured game window spends its first click on capturing the mouse, as it does for a player. Start a
  test that clicks in the world with one `Click` to take capture.
- Key and mouse events that do not come from the test are swallowed while tests run. A real cursor **resting**
  over the window still makes UI under it hover: keep the pointer off the window.

## Limits

- Needs a C++ game module, `ready-gate`, and `EnhancedInput` in the module's dependencies.
- Tests run in one world. A test that travels to another level ends the run without a summary, which is
  reported as no verdict: start each such test on its own map with `--map`.
- The runner is never created in Shipping builds.
- Gamepad input has no helper yet: `Hold` with a gamepad key works for buttons, sticks need `HoldAction`.
