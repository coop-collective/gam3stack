---
name: unreal-movement-qa
description: Find movement bugs in an Unreal Engine game without a person at the controls - a bot plays the player's pawn and reports where it got stuck, fell out of the level, slid without animating, moved impossibly fast or put the camera inside a wall. Use when changing character movement, collision, level geometry, spawn points or the camera, when the user reports getting stuck, falling through the floor, sliding, jitter or camera clipping, before calling a level playable, or when a run needs the game to play itself.
---

# Movement QA: let a bot walk it before a person has to

Movement bugs are found by walking: into corners, off edges, along walls, through doors. A person does that
slowly and only where they think to go. The `walk-bot` kit does it at a few hundred times real time with no
renderer, the same way every time, and names what it found. Install it (it needs `ue-driver` and `ready-gate`)
in any project with a C++ module and a player pawn.

    node Tools/gam3/ue_walk.mjs --map L_Level --seconds 600 --seed 1

One line comes back: `GAM3WALK: ok ...` or `GAM3WALK: FAILED ... stuck=1 ...`, with an `incident:` line for each
problem giving the kind, the position and the game time.

## First run in a new game

- `no-control`: the bot's input does not reach this pawn (the game has its own input struct or movement
  system). Bind `OnBotDrive` where the player's controls feed the game; the summary then says `input=game`.
- Many `speed` incidents all landing on one spot are respawns: call `NoteTeleport()` where the game respawns
  or moves the player on purpose.
- A wandering bot walks off open edges and dies. That is information (how often, where), not a bot fault; use
  routes, or the game's own edge guard in the drive hook, when the question is about something else.

## Rules while developing

1. **Walk after every change to movement, collision, level geometry, spawn points or the camera.** Wander at
   three or more seeds, at least 300 game seconds each, at the default `blind` profile. It costs seconds.
   Different seeds walk different paths; one seed is one tester.
2. **Read the first note line.** `input=enhanced` means the bot is pressing the game's own move action, so the
   game's input code is under test. `input=movement` means it is not: pass `--move-action` with the action's
   asset name, or accept that input handling is untested and say so.
3. **A failure is a place, not a flake.** Runs repeat exactly: the same seed fails at the same spot every time.
   Do not re-run hoping for a pass. Repeat the failing command with `--replay`, open the picture, go to the
   coordinates.
4. **Every movement bug found by hand becomes a test.** A place that trapped the player becomes a route through
   it (`--route FILE`, kept in the repository). A rule the game broke becomes a `ReportIncident` in the game's
   bot hook. Then it cannot come back unnoticed.
5. **Keep a route file for every path a player must be able to walk**: spawn to the first objective, through
   each door, up each ramp. Run them all after any level change. A route that is blocked or not finished fails.
6. **Fix the cause where the bot found it, then walk again at the same seed and at new ones.** A fix that moves
   the wall often opens a gap somewhere else.
7. **Do not tune a check until it passes.** Raise `StuckSeconds` or `SlideBoneCm` only when you have looked at
   the replay and the game is right. Say in the change what you looked at.

## Reading an incident

| Incident | Usual cause | Fix |
| --- | --- | --- |
| `stuck`, small circle | A gap the capsule fits into but not out of; two collision shapes meeting at a sharp inner angle; a step higher than the pawn's step height | Close or widen the gap; simplify the collision; lower the step or raise `MaxStepHeight` |
| `stuck`, pacing in 3 m | A closed pocket: fallen behind scenery, a room whose door does not open for the bot | Block the way in, or add the way out |
| `fell` | A hole in the floor collision, an edge with no blocker, a mesh with no collision, spawning before the floor exists | Add collision or a blocking volume; spawn the player only once the level is ready |
| `slide` | The animation graph does not see the speed: variables not set, wrong movement mode, the mesh swapped without its animation class | Fix the graph's inputs; set the animation class with the mesh |
| `speed`, one frame | An unannounced teleport: a respawn, a physics push out of overlap, a moving platform | Call `NoteTeleport()` if it is meant; otherwise fix the overlap |
| `speed`, sustained | A boost or a slope that adds velocity past the cap | Clamp it, or raise the cap if it is the design |
| `camera-inside` | No camera collision, or a boom that does not shorten | Use a spring arm with its collision test on, or pull the camera in near walls |

## Rules for the game you are building

| Rule | How |
| --- | --- |
| Every level has a floor to fall to | Set KillZ just under the lowest walkable ground, and respawn or end the run there. Never leave the engine default, which is a fall of kilometres |
| No gap the capsule fits into but not out of | Blocking volumes over decorative clutter; keep walkable collision simple and convex |
| Every edge is either a designed drop or blocked | Walk the edges with the bot; a drop the player cannot climb back from needs a way back or a kill floor |
| The camera never enters geometry | A spring arm with collision, tested by the bot against walls and ceilings |
| A moving pawn is an animating pawn | Drive the animation graph from the movement component's velocity, and set mesh and animation class together |
| Deliberate moves are announced | Respawns, doors and cutscenes call `NoteTeleport()`; then every other jump in position is a bug |
| The game can play itself | Put the game's actions and rules in the bot's tick (`OnBotTick`), drawing chance from the bot's seeded `Random()`. Performance and effects runs need a game that plays without a person |

## When the game must play itself

Runs that measure or look at gameplay (frame time during a fight, effects firing) need input with nobody there.
Add `-Gam3Bot=wander -Gam3BotSeed=1` after `--` on any game run; without `-Gam3BotSeconds` the bot drives until
the run ends and never quits it. The game's own `OnBotTick` hook is what turns walking into playing.

## What the bot cannot judge

How movement feels: acceleration, turn rate, jump arc, camera lag, whether a slope is annoying. And anything it
did not walk into. A clean bot run means "nothing obviously broken where it went", not "movement is done". Sign
off feel at `--profile human`, in real time, by a person.
