---
name: unreal-code-first
description: How to write Unreal Engine gameplay as code only - no Blueprint classes, graphs or Blueprint-exposed APIs - with Mass entities (fragments and processors) for anything there are many of, and structured so it survives the engine's next major version. Use when adding or designing any gameplay feature, enemy, projectile, pickup, UI or data in an Unreal project, when tempted to create a Blueprint or expose C++ to Blueprint, when asked about Unreal Engine 6, Verse, Mass, ECS or entities, or when reviewing code for things that will not carry forward.
---

# Code first, entities over actors

Two decisions for every project that uses these kits:

1. **No Blueprints.** Gameplay, UI and data are C++ and text. An agent cannot read, diff, review or merge a
   Blueprint: it is a binary asset edited in a graph. Everything an agent writes must be text.
2. **Entities for anything numerous.** Enemies in a crowd, projectiles, pickups, ambient creatures: data in
   fragments, behaviour in processors (the Mass framework), not one Actor each.

## Why now: where the engine is going

Reported from Epic's Unreal Fest talks in 2026 (secondary sources; Epic's own text was not found, so treat the
details as likely to move): Unreal Engine 6 drops Blueprints and Actors rather than deprecating them slowly,
gameplay moves to Verse on a scene graph of entities and components, and C++ stays for the engine's lower layers.
Early access is planned for the end of 2027. The reports do not name Mass as the replacement.

What follows from that today, on UE 5:

- A Blueprint written now is work with no path forward. C++ at least stays text that tools can read and convert.
- The shape that carries over is **data plus systems**: entities that are data, behaviour that runs over them.
  Mass is that shape in C++ today. Code written as fragments and processors is far closer to an entity-and-
  component world than code written as deep Actor subclasses.
- Nobody can port to an API that is not public. Do not write to guessed UE6 or Verse APIs. Write UE 5 code in the
  shape above and keep the engine-facing layer thin.

**Already moving in UE 5.9:** Cascade, the older particle system, is no longer part of the engine: it lives in
a plugin, and the engine's own spawn functions for it are marked deprecated. New effects are Niagara; a project
that still ships Cascade effects should plan their replacement.

## Rules

**No Blueprint, anywhere:**

- No Blueprint classes, level Blueprints, Blueprint function libraries, widget Blueprints or Blueprint interfaces.
- No `BlueprintCallable`, `BlueprintPure`, `BlueprintAssignable`, `BlueprintImplementableEvent`,
  `BlueprintNativeEvent` or `Blueprintable` specifiers. Delegates are native (`DECLARE_MULTICAST_DELEGATE`), bound
  with `AddUObject` or `AddWeakLambda`.
- Classes are referenced by script path, `/Script/MyGame.OrcCharacter`, never by a `BP_..._C` asset path.
- UI is Slate in C++ (the `ready-gate` cover is a small example). HUD text and bars do not need a widget asset.
- Tunable data lives in config (`UCLASS(Config=Game)` and `DefaultGame.ini`), in C++ data asset classes, or in a
  JSON file the game reads. Not in Blueprint defaults.
- Levels are built from data and script (`world-landscape`, editor Python), so they can be rebuilt and reviewed.
- Animation is the one place an asset graph is still hard to avoid. Keep it to a pose graph with no event graph:
  every variable is set from a C++ `UAnimInstance` subclass. Prefer playing sequences from code or motion
  matching assets where the game allows.
- Do not enable the engine's `BlueprintToolsets` tool plugin; nothing here should be editing Blueprints.

**Entities with Mass:**

- A **fragment** is a plain struct of data per entity. A **tag** is a fragment with no data. A **processor** runs
  a query over every entity that has the fragments it asks for, a chunk at a time.
- Use entities when there are many of a thing or it has no need of a full Actor: more than a few dozen of
  anything, anything spawned and destroyed constantly. The player's pawn, controller and game mode stay Actors
  on UE 5; keep them thin.
- One fact per fragment, small and flat. Behaviour never lives in the fragment.
- Processors do not reach into other gameplay objects mid-loop. Read what they need into fragments first, write
  results out after.
- Give an entity an Actor or a mesh only for what the player can see up close (Mass representation and LOD).

**Keep the rules of the game out of engine classes:**

- Damage formulas, cooldowns, loot tables, wave schedules: plain C++ structs and free functions that take and
  return data. No `AActor*`, no `UWorld*` in their signatures. These are the parts worth carrying to any engine
  version, and they can be tested without starting the engine.
- Engine classes (subsystems, processors, the pawn) are adapters: they gather data, call the plain code, apply the
  result.
- Prefer subsystems (`UWorldSubsystem`, `UGameInstanceSubsystem`) to manager Actors placed in levels.

## Lessons from a game built on Mass

From one project whose whole combat simulation is Mass fragments (read from its notes and code, not measured
here):

- **Fragments hold plain data and a stable small id, never object pointers.** Then the state can be copied for a
  replay or rollback and sent to a server as it is.
- **Things that fly or fall in numbers are entities drawn by one instanced mesh**, not an Actor each.
- **A simulation that must replay exactly runs its queries by hand, in a fixed order, at a fixed step**, not as
  automatically scheduled processors. Processors are the right default for everything else.
- **Tick the simulation before physics, with the pawns' ticks as prerequisites.** Ticked after, what the player
  sees is a frame late.
- **Presentation reads fragments and events and never writes them.** Anything the visuals move that the rules
  depend on (a collider, a door) is a hidden input and breaks replay.
- **One small quantized input command per entity per step**, with press and release worked out inside the
  simulation, is what makes input replayable and makes a test bot the same as a player.
- **The simulation itself was cheap** (well under a millisecond a frame for a small fight). The costs were in
  what draws it. Still unmeasured there, and worth watching as entity counts grow: creating and destroying
  entities every event, arrays allocated every step, and copying several fragments to read one value.
- **Lighting at scale follows the same rule:** many entities must not mean many lights. Give a light to the few
  that need one, pool the flashes, and count lights in every measured run (`unreal-performance`).

## A minimal Mass set-up (compiled and run on UE 5.9)

Module dependencies in `<Module>.Build.cs`: `"MassCore"`, `"MassEntity"`. Enable the `MassGameplay` plugin in the
`.uproject`: without it the entities are created but **no processor ever runs** (this was observed, with no
warning in the log).

```cpp
#include "Mass/EntityElementTypes.h"   // in MassCore. The old MassEntityElementTypes.h warns that it moved.
#include "MassEntityQuery.h"
#include "MassProcessor.h"

USTRUCT() struct FPositionFragment : public FMassFragment { GENERATED_BODY() FVector Value = FVector::ZeroVector; };
USTRUCT() struct FVelocityFragment : public FMassFragment { GENERATED_BODY() FVector Value = FVector::ZeroVector; };

UCLASS() class UMoveProcessor : public UMassProcessor
{
	GENERATED_BODY()
public:
	UMoveProcessor() : Query(*this)
	{
		bAutoRegisterWithProcessingPhases = true;
		ExecutionFlags = int32(EProcessorExecutionFlags::All);
	}
protected:
	virtual void ConfigureQueries(const TSharedRef<FMassEntityManager>& EntityManager) override
	{
		Query.AddRequirement<FPositionFragment>(EMassFragmentAccess::ReadWrite);
		Query.AddRequirement<FVelocityFragment>(EMassFragmentAccess::ReadOnly);
	}
	virtual void Execute(FMassEntityManager& EntityManager, FMassExecutionContext& Context) override
	{
		Query.ForEachEntityChunk(Context, [](FMassExecutionContext& Chunk)
		{
			const float Dt = Chunk.GetDeltaTimeSeconds();
			const TArrayView<FPositionFragment> Positions = Chunk.GetMutableFragmentView<FPositionFragment>();
			const TConstArrayView<FVelocityFragment> Velocities = Chunk.GetFragmentView<FVelocityFragment>();
			for (int32 i = 0; i < Chunk.GetNumEntities(); ++i) Positions[i].Value += Velocities[i].Value * Dt;
		});
	}
private:
	FMassEntityQuery Query;
};

// Creating entities (for example in a world subsystem's OnWorldBeginPlay):
FMassEntityManager& Manager = World.GetSubsystem<UMassEntitySubsystem>()->GetMutableEntityManager();
const FMassArchetypeHandle Archetype = Manager.CreateArchetype({ FPositionFragment::StaticStruct(), FVelocityFragment::StaticStruct() });
TArray<FMassEntityHandle> Entities;
Manager.BatchCreateEntities(Archetype, {}, 10000, Entities);
Manager.GetFragmentDataChecked<FVelocityFragment>(Entities[0]).Value = FVector(100.0, 0.0, 0.0);
```

Check it without a renderer: `ue_game.mjs --profile blind --quit 5` and log a fragment's value after some frames.
In the test, 10,000 entities at 100 units a second had moved 396.7 units after 119 fixed 1/30 s frames.

Mass headers and names have changed between 5.x versions and will again. When a snippet does not compile, read
the engine's own headers under `Engine/Source/Runtime/MassEntity` and `MassCore` rather than guessing.

## With the other kits

- `perf-pass`: the test room spawns effects, meshes, materials and actor classes. Entities are measured in a
  `play` run: call `UGam3PerfProbe::Mark` when a wave of entities spawns, and compare the `game` column.
- `walk-bot`: drives the player's pawn. Put the game's own rules in its tick hook to check entity behaviour
  (nothing overlapping the player, counts that add up).
- `ready-gate`: hold the gate with a blocker while entities are being created, as for any other loading.

## Not covered here

Mass representation and LOD, Mass AI (StateTree, ZoneGraph, smart objects) and replication exist in the engine
and were not run for this skill. Verse is not used: its gameplay APIs for the engine are not public.
