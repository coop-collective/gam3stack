// The walk bot: plays the player's pawn unattended and reports what a tester walking around would have found.
//
// Command line (Tools/gam3/ue_walk.mjs passes these for you):
//   -Gam3Bot=wander|route       wander: seeded random headings, pauses and jumps, turning away from what blocks it.
//                               route: walk the waypoints in order, in straight lines.
//   -Gam3BotSeed=N              the wander's random seed (default 1). Same seed, same run, on a fixed time step.
//   -Gam3BotSeconds=N           stop after N game seconds, print the result and quit. Without it the bot keeps
//                               playing until something else ends the run (a performance run does this).
//   -Gam3BotRoute=x,y,z;x,y,z   waypoints in world units. Or -Gam3BotRouteFile=path: one "x,y,z" per line, # comments.
//   -Gam3BotInput=movement      skip the Enhanced Input path and call AddMovementInput.
//   -Gam3BotMoveAction=IA_Move  the Enhanced Input move action by asset name, when it is not found by itself.
//   -Gam3BotJumpAction=IA_Jump  the same for jump.
//   -Gam3BotFloorZ=Z            anything below this height counts as fallen (default: the level's KillZ).
//   -Gam3BotShots[=prefix]      take a picture at each incident: Saved/Screenshots/<prefix>_NN_<kind>.png
// The bot starts when the ready gate opens. It is created only with -Gam3Bot= on the command line, and never in
// Shipping builds.
//
// How it moves the pawn: the way a player does where it can. It looks through the pawn's and the controller's
// Enhanced Input bindings for a 2D action with "Move" in its name and injects values into it, so the game's own
// input code runs. With no such action it calls AddMovementInput. The log says which: input=enhanced|movement.
//
// What it checks, every frame. Each incident is logged once, when it begins:
//   GAM3WALK: stuck at=(x,y,z) t=12.3 ...           input held, and the pawn has not left a small circle (or, when
//                                                   wandering, a 3 m circle for 20 s: a pocket with room to pace in)
//   GAM3WALK: fell ...                              below the floor, falling too long, or the pawn was destroyed
//   GAM3WALK: slide ...                             moving over the ground while no bone of its mesh moves
//   GAM3WALK: speed ...                             faster than its movement allows, or a jump in position
//   GAM3WALK: nan ...                               a position or velocity that is not a number
//   GAM3WALK: camera-inside ...                     the view point is inside blocking geometry
// and at the end:
//   GAM3WALK: done mode= seed= game_s= sim_wall_s= distance_m= end=(x,y,z) input= route=a/b stuck= fell= ...
//
// Making the bot play the game, not only walk: bind OnBotTick. It fires every frame the bot
// drives the pawn. Do the game's actions there (attack, interact, use Random() so the run stays repeatable), and
// call ReportIncident for the game's own rules (health below zero, an enemy outside the arena).
#pragma once

#include "CoreMinimal.h"
#include "Math/RandomStream.h"
#include "Subsystems/WorldSubsystem.h"
#include "Gam3WalkBot.generated.h"

class APawn;
class APlayerController;
class UGam3WalkBot;
class UInputAction;
class USkeletalMeshComponent;

DECLARE_MULTICAST_DELEGATE_ThreeParams(FGam3BotTickNative, UGam3WalkBot&, APawn*, float);
DECLARE_DELEGATE_ThreeParams(FGam3BotDrive, APawn* /*Pawn*/, const FVector& /*WorldDirection, zero to stop*/, bool /*bJump*/);

UCLASS(Config = Game)
class __GAM3_MODULE_API__ UGam3WalkBot : public UTickableWorldSubsystem
{
	GENERATED_BODY()

public:
	/** The bot of this world, or null when the run was not started with -Gam3Bot=. */
	static UGam3WalkBot* Get(const UObject* WorldContextObject);

	/** Fires every frame the bot is driving a pawn. Add the game's own actions and checks here. */
	FGam3BotTickNative OnBotTick;

	/**
	 * For a game whose pawn does not move from engine input (its own input struct, a custom movement system):
	 * bind this and feed the direction into the game's input the way its own controls do. When bound, the bot
	 * injects nothing itself. A run that could not move the pawn at all reports `no-control`, not `stuck`.
	 */
	FGam3BotDrive OnBotDrive;
	/** The older name for OnBotTick. Both fire. */
	FGam3BotTickNative OnBotTickNative;

	/** A rule of the game was broken. Logged once per call as `GAM3WALK: <Kind> at=... t=... <Detail>` and counted. */
	void ReportIncident(FName Kind, const FString& Detail);

	/** The game moved the pawn on purpose (a respawn, a door, a cutscene): the next frame's jump is not a `speed` incident. */
	void NoteTeleport() { TeleportNotedUntil = GameTime + 0.5f; }

	/** Game seconds since the bot started. */
	float GetGameSeconds() const { return GameTime; }

	/** The run's seeded random stream. Use it for the game's own bot actions so a seed replays exactly. */
	FRandomStream& Random() { return Rand; }

	/** Seconds of held input without leaving StuckRadius before the pawn is called stuck. */
	UPROPERTY(Config, EditAnywhere, Category = "Gam3|Bot")
	float StuckSeconds = 3.f;
	UPROPERTY(Config, EditAnywhere, Category = "Gam3|Bot")
	float StuckRadius = 50.f;
	/** Wandering this long without ever leaving TrapRadius is also `stuck`: a pocket with room to pace in. 0 turns it off. */
	UPROPERTY(Config, EditAnywhere, Category = "Gam3|Bot")
	float TrapSeconds = 20.f;
	UPROPERTY(Config, EditAnywhere, Category = "Gam3|Bot")
	float TrapRadius = 300.f;
	/** Seconds of continuous falling before the pawn is called fallen. */
	UPROPERTY(Config, EditAnywhere, Category = "Gam3|Bot")
	float FallSeconds = 3.f;
	/** Ground speed over the movement component's maximum times this is a `speed` incident. */
	UPROPERTY(Config, EditAnywhere, Category = "Gam3|Bot")
	float SpeedMargin = 1.5f;
	/** Moving faster than SlideSpeed for SlideSeconds while no bone moves more than SlideBoneCm is a `slide`. */
	UPROPERTY(Config, EditAnywhere, Category = "Gam3|Bot")
	float SlideSeconds = 0.75f;
	UPROPERTY(Config, EditAnywhere, Category = "Gam3|Bot")
	float SlideSpeed = 100.f;
	UPROPERTY(Config, EditAnywhere, Category = "Gam3|Bot")
	float SlideBoneCm = 5.f;
	/** Radius of the sphere tested at the view point for `camera-inside`. */
	UPROPERTY(Config, EditAnywhere, Category = "Gam3|Bot")
	float CameraRadius = 4.f;
	/** How close to a waypoint counts as reaching it. */
	UPROPERTY(Config, EditAnywhere, Category = "Gam3|Bot")
	float RouteRadius = 60.f;

	virtual bool ShouldCreateSubsystem(UObject* Outer) const override;
	virtual void Initialize(FSubsystemCollectionBase& Collection) override;
	virtual void Deinitialize() override;
	virtual void Tick(float DeltaTime) override;
	virtual TStatId GetStatId() const override { RETURN_QUICK_DECLARE_CYCLE_STAT(UGam3WalkBot, STATGROUP_Tickables); }
	virtual bool DoesSupportWorldType(const EWorldType::Type WorldType) const override;

private:
	enum class EKind : uint8 { Stuck, Fell, Slide, Speed, Nan, Camera, Count };

	void Begin(UWorld* World);
	void FindInput(APlayerController* PC, APawn* Pawn);
	void Check(UWorld* World, APlayerController* PC, APawn* Pawn, float Dt);
	void Drive(APlayerController* PC, APawn* Pawn, float Dt);
	void Apply(APlayerController* PC, APawn* Pawn, const FVector& WorldDir, bool bJump);
	void Raise(EKind Kind, const FString& Detail);
	void Clear(EKind Kind) { bActive[int32(Kind)] = false; }
	void Log(const FString& Kind, const FString& Detail);
	void Finish(UWorld* World, const TCHAR* Why);
	void PrintDone();

	// Run
	bool bWander = true;
	int32 Seed = 1;
	float Seconds = 0.f;
	bool bForceMovement = false;
	FString MoveActionName;
	FString JumpActionName;
	bool bHasFloor = false;
	float FloorZ = 0.f;
	bool bShots = false;
	FString ShotPrefix = TEXT("walk");
	TArray<FVector> Route;

	// State
	FRandomStream Rand;
	bool bBegun = false;
	bool bFinished = false;
	bool bDonePrinted = false;
	bool bQuitSent = false;
	float GameTime = 0.f;
	float FinishedAt = 0.f;
	double BeginWall = 0.0;
	double EndWall = 0.0;
	double Distance = 0.0;
	bool bNoControlReported = false;
	FVector LastLocation = FVector::ZeroVector;
	FVector LastVelocity = FVector::ZeroVector;
	bool bHaveLast = false;
	bool bHadPawn = false;
	float NoPawnTime = 0.f;
	float TeleportNotedUntil = -1.f;
	TWeakObjectPtr<APawn> LastPawn;

	// Input
	TWeakObjectPtr<const UInputAction> MoveAction;
	TWeakObjectPtr<const UInputAction> JumpAction;
	bool bEnhanced = false;
	float InputYawFix = 0.f;
	float SteadyTime = 0.f;
	float DirHeldTime = 0.f;
	float LastOff = 0.f;
	FVector LastDir = FVector::ZeroVector;
	int32 JumpFrames = 0;

	// Wander and route
	float Heading = 0.f;
	float HoldLeft = 0.f;
	bool bPaused = false;
	bool bWantsMove = false;
	FVector BumpAnchor = FVector::ZeroVector;
	float BumpTime = 0.f;
	int32 Bumps = 0;
	int32 NextWaypoint = 0;

	// Checks
	bool bActive[int32(EKind::Count)] = {};
	int32 Counts[int32(EKind::Count)] = {};
	TMap<FName, int32> GameCounts;
	FVector StuckAnchor = FVector::ZeroVector;
	float StuckTime = 0.f;
	FVector TrapAnchor = FVector::ZeroVector;
	float TrapTime = 0.f;
	bool bTrapped = false;
	bool bHaveStuckAt = false;
	FVector LastStuckAt = FVector::ZeroVector;
	float FallTime = 0.f;
	float OverspeedTime = 0.f;
	int32 CameraFrames = 0;
	TWeakObjectPtr<USkeletalMeshComponent> SlideMesh;
	bool bSlideNoted = false;
	TArray<FVector> SlideStart;
	float SlideTime = 0.f;
	float SlideMaxBone = 0.f;

	// Pictures
	TArray<FString> ShotQueue;
	int32 ShotIndex = 0;
	int32 FramesSinceShot = 1000;
};
