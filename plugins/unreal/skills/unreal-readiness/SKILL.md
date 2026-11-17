---
name: unreal-readiness
description: Rules for "is it ready" in an Unreal Engine game - never capture or judge a level that is still loading, and never ship a level that shows its loading to the player or a character in its T-pose before it animates. Use when taking or reading screenshots of an Unreal game, when a run reports ready=timeout, ready=none or bind_pose, when building level loading, spawning, respawning or character setup, or when the user reports pop-in, a broken-looking first few seconds, grey materials at start, or a T-pose on spawn.
---

# Ready means ready: for the capture and for the player

A level that has begun play is not ready. For a few seconds shaders and textures are still arriving, streamed
levels are loading, the pawn may not exist, and a skeletal mesh stands in its bind pose until its animation has
been evaluated. Two failures come from ignoring this, and they are the same failure:

- **You** capture those seconds, see a broken picture, and "fix" something that was not wrong (or see a fine
  picture later and miss what the player saw first).
- **The player** sees those seconds.

One mechanism covers both: the `ready-gate` kit. The game holds a cover until the gate opens, and every unattended
run counts time from that same moment. Install it in any project with a C++ module before judging anything by eye.

## Rules while developing

1. **Never capture on a timer.** No "give it a few seconds". `ue_game.mjs --shots` counts from the gate, and the
   summary line says `ready=ok`. Treat anything else as no result:
   - `ready=timeout`: the `GAM3READY: TIMEOUT waiting=...` line names what never finished. Fix that.
   - `ready=none`: no gate in the project, or the level never began play. Install `ready-gate`, or read the log.
2. **Always capture frame 0** after changing a level, its loading, or what spawns at start: `--shots 0,3`. Frame 0
   is the first thing the player sees. Read both pictures; a difference between them is something still arriving.
3. **`bind_pose` above 0 is a bug, not noise.** The line names the actor and how many frames it stood there.
4. **Read the `after-ready:` lines.** A hitch or a late compile after the gate opened is what the player would
   feel. In an uncooked run a late compile is usually a material first drawn late: load or draw it behind the cover.
5. **Do not move a shot later to make it pass.** If frame 0 is wrong, the gate opened too early for this game: add
   a blocker around the loading the gate cannot see.
6. **Jobs in the editor finish on later frames too** (PCG generation, asset compiles, exports). Start the job, then
   poll the thing itself for completion (an instance count that stops changing, a file that exists) before saving
   or capturing. Never sleep a fixed time.
7. **Readiness is measured in real time, gameplay in game time.** Compiles and disk loads do not speed up when the
   game runs on a fixed time step, so the gate uses a real clock. Your own waits for loading must as well.

## Rules for the game you are building

Build these in from the first playable level; they are cheap then and expensive to retrofit.

| Rule | How |
| --- | --- |
| Nothing is shown until the level is ready | The gate's cover does it, HUD and UI included. With your own loading screen: `bCoverWithFade=False`, remove the screen in `OnReady` |
| No time passes behind the cover | Start the match clock, music, intro, AI and spawners from `OnReady`, not `BeginPlay` |
| The gate knows about your loading | `AddBlocker` / `RemoveBlocker` around save files, procedural generation, server handshakes, async asset loads |
| A character is never drawn in its bind pose | Call `UGam3ReadyGate::ShowActorWhenPosed(Character)` right after every spawn, respawn, mesh swap or re-dress |
| First use does not hitch | Load, and where needed draw once, behind the cover: the effects, sounds and materials the first seconds use |
| Every way into a level is covered | New game, continue, respawn, level travel, returning from a menu. Each is a separate path: test each |

### Why a character shows its bind pose, and the fix

| Cause | Fix |
| --- | --- |
| The animation or animation blueprint is loaded async (a soft reference) and arrives after the mesh is visible | Load it before spawning, or spawn then `ShowActorWhenPosed` |
| The mesh or animation class is set in code after the actor is spawned and shown | Set it before the component registers (deferred spawn), or `ShowActorWhenPosed` after setting it |
| The mesh is swapped at run time (character select, equipment) | `ShowActorWhenPosed` after every swap |
| The animation blueprint's first state waits on a variable that is not set on the first frame | Give the state machine a valid entry pose; set the variables before the first update |
| The actor spawns outside the view; by default such a mesh does not animate, then it enters view un-posed | `ShowActorWhenPosed`, or set the mesh to always tick its pose if it must be right the moment it appears |

### Why a level looks broken at first, and the fix

| What the player sees | Cause | Fix |
| --- | --- | --- |
| Grey or default-checker surfaces, then they pop | Shaders compiling (uncooked) or pipeline states compiling (packaged) | The gate waits for both; ship a pipeline state cache for packaged builds |
| Blurry textures sharpening | Texture streaming | The gate waits `SoftSeconds`; force full mips on hero assets near the start point |
| Pieces of the level appearing | Level streaming, World Partition cells | The gate waits for both; for your own streaming use a blocker |
| The camera somewhere wrong, then snapping | No pawn yet, or the view target set late | The gate waits for the pawn; set the view target before `OnReady` |
| Brightness swinging in the first second | Auto exposure and lighting settling | Raise `SettleFrames`, or fix the exposure range |
| A freeze just after control is given | Something loaded or compiled on first use | Read the `after-ready:` lines; preload it behind the cover |

## Proving it

    node Tools/gam3/ue_game.mjs --profile agent --map L_Level --shots 0,0.5,3 --quit 4 --prefix first

Pass means: `ready=ok`, `bind_pose=0`, no `after-ready:` lines you cannot explain, and frame 0 looks like frame 3
apart from things that are meant to move. Then run the same at `--profile human` before calling the look done.
Do the same for every way into the level. An uncooked run is not a packaged build: before release, check the
first seconds of a packaged build too.
