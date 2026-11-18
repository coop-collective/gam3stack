// Performance, measured in parts: a prewarm for the game, and a probe with three scenarios for unattended runs.
//
// One fly through a level measures the level. It does not measure what the game does to it: the first time an
// effect, a character or a material is used, the engine loads it, builds its shaders and creates its pipeline
// state, and the player gets a hitch at the moment something exciting happens. So measure in parts:
//   room    each subject (an effect, an actor class, a mesh, a material) spawned alone in front of a fixed camera,
//           once cold and once warm. The gap between the two is the first-use hitch, reported per subject by name.
//   flyby   a camera moved through points in a level: what the world itself costs, one segment per leg.
//   play    the game plays itself (a bot, a demo mode); the probe measures and the game labels what is happening
//           with UGam3PerfProbe::Mark, so a slow stretch has a name.
//
// UGam3Prewarm is the fix for what the room finds, and it is game code that ships: list the assets the game spawns
// during play, and it loads them, draws each once behind the ready gate's cover, and keeps them in memory, so the
// first real use costs what every later use costs.
//   Config/DefaultGame.ini:
//     [/Script/__GAM3_MODULE__.Gam3Prewarm]
//     +Assets=/Game/FX/NS_Hit.NS_Hit
//     +Assets=/Script/MyGame.OrcCharacter
//   or from code, before the gate opens: UGam3Prewarm::Warm(this, Paths);
//
// Probe command line (Tools/gam3/ue_perf.mjs passes these):
//   -Gam3Perf=room|flyby|play   -Gam3PerfData=<file.json>   -Gam3PerfName=<report name>
//   -Gam3PerfSeconds=<n>        play: how long to measure, in real seconds after the level is ready
//   -Gam3PerfHitchMs=<n>        a frame longer than this is listed as a hitch with its time, label, place and
//                               what happened in it: pipeline states created, packages loaded, garbage collection,
//                               shader jobs still queued
//   -Gam3PerfPrewarm            room: hand every subject to UGam3Prewarm first (proves the fix)
// The report is written to Saved/gam3-perf/<name>.json. The probe is never created in Shipping builds, and Mark
// costs one null check when it is not there.
//
// Log lines: GAM3PERF: ...   GAM3WARM: ok assets=<n> seconds=<s> | GAM3WARM: missing <path> | GAM3WARM: TIMEOUT
#pragma once

#include "CoreMinimal.h"
#include "Subsystems/WorldSubsystem.h"
#include "UObject/SoftObjectPath.h"
#include "Gam3Perf.generated.h"

class AActor;
class ACameraActor;

/** Turns an asset of any common kind into something on screen. Shared by the prewarm and the test room. */
struct FGam3Subject
{
	/** Loads the asset now. An actor class is named by its script path: /Script/MyGame.MyEnemy. */
	static UObject* Load(const FString& Path);
	/** Effect, actor class, static or skeletal mesh, or material (shown on a sphere). Null for anything else. */
	static AActor* Spawn(UWorld* World, UObject* Asset, const FTransform& At);
};

UCLASS(Config = Game)
class __GAM3_MODULE_API__ UGam3Prewarm : public UTickableWorldSubsystem
{
	GENERATED_BODY()

public:
	/** Everything the game spawns during play that is not already placed in the level. */
	UPROPERTY(Config, EditAnywhere, Category = "Gam3|Perf")
	TArray<FSoftObjectPath> Assets;

	/**
	 * The assets stay on screen until this many frames in a row have passed with nothing compiling and no new
	 * pipeline state created. An effect whose emitters start late keeps creating them for a while: a fixed short
	 * draw leaves those for the player's first real use.
	 */
	UPROPERTY(Config, EditAnywhere, Category = "Gam3|Perf")
	int32 DrawFrames = 20;

	/** At least this long on screen, in real seconds, so effects reach the emitters that start late. */
	UPROPERTY(Config, EditAnywhere, Category = "Gam3|Perf")
	float DrawSeconds = 1.5f;

	/** Real seconds after which the prewarm gives up, logs it, and lets the level open. */
	UPROPERTY(Config, EditAnywhere, Category = "Gam3|Perf")
	float TimeoutSeconds = 60.f;

	/** Add assets to warm. Call before the ready gate opens (BeginPlay is early enough) so it happens under the cover. */
	static void Warm(const UObject* WorldContextObject, const TArray<FSoftObjectPath>& More);

	bool IsBusy() const { return bBusy; }

	virtual void OnWorldBeginPlay(UWorld& InWorld) override;
	virtual void Tick(float DeltaTime) override;
	virtual TStatId GetStatId() const override { RETURN_QUICK_DECLARE_CYCLE_STAT(UGam3Prewarm, STATGROUP_Tickables); }
	virtual bool DoesSupportWorldType(const EWorldType::Type WorldType) const override;

private:
	void Begin(UWorld* World);
	void Finish(UWorld* World, bool bTimedOut);

	TArray<FSoftObjectPath> Queue;
	/** Held for the life of the level: an asset that is collected has to be loaded again, and that is the hitch. */
	UPROPERTY(Transient)
	TArray<TObjectPtr<UObject>> Keep;
	UPROPERTY(Transient)
	TArray<TObjectPtr<AActor>> Shown;
	bool bBusy = false;
	bool bSpawned = false;
	bool bBlocking = false;
	int32 Drawn = 0;
	int32 Warmed = 0;
	uint32 LastPsoTotal = 0;
	double StartWall = 0.0;
	double SpawnWall = 0.0;
};

UCLASS()
class __GAM3_MODULE_API__ UGam3PerfProbe : public UTickableWorldSubsystem
{
	GENERATED_BODY()

public:
	/** Name what the game is doing from now on ("wave 3", "boss intro"). Frames are reported under this label. */
	static void Mark(const UObject* WorldContextObject, FName Label);

	virtual bool ShouldCreateSubsystem(UObject* Outer) const override;
	virtual void Initialize(FSubsystemCollectionBase& Collection) override;
	virtual void Deinitialize() override;
	virtual void OnWorldBeginPlay(UWorld& InWorld) override;
	virtual void Tick(float DeltaTime) override;
	virtual TStatId GetStatId() const override { RETURN_QUICK_DECLARE_CYCLE_STAT(UGam3PerfProbe, STATGROUP_Tickables); }
	virtual bool DoesSupportWorldType(const EWorldType::Type WorldType) const override;

private:
	struct FSegment
	{
		FString Label;
		TArray<float> Frame, Game, Render, Gpu;
	};
	struct FRoomSubject
	{
		FString Path, Label;
		float Hold = 3.f;
		float LoadMs = 0.f;
		bool bMissing = false;
		bool bLateCompile = false;
		int32 Psos = 0, Loads = 0;
		TArray<float> Cold, Warm;
	};
	struct FPoint
	{
		FVector Location = FVector::ZeroVector;
		FRotator Rotation = FRotator::ZeroRotator;
		float Seconds = 3.f;
	};
	struct FHitch
	{
		float At = 0.f, Ms = 0.f;
		FString Label, Cause;
		FVector Where = FVector::ZeroVector;
	};
	enum class ERoom : uint8 { Empty, Cold, GapA, Warm, GapB };

	void LoadData();
	void SetLabel(const FString& Label);
	void HoldCamera(UWorld* World, const FVector& Location, const FRotator& Rotation);
	void TickRoom(UWorld* World, float Ms, double Now);
	void TickFlyby(UWorld* World, double Now);
	void Finish(UWorld* World);

	FString Scenario, DataFile, Name = TEXT("perf");
	float PlaySeconds = 30.f;
	float HitchMs = 50.f;
	bool bPrewarm = false;

	bool bStarted = false;
	bool bDone = false;
	int32 ReadyFrames = 0;
	double LastWall = 0.0;
	double StartWall = 0.0;
	int32 Current = INDEX_NONE;
	TArray<FSegment> Segments;
	TArray<FHitch> Hitches;

	// room
	TArray<FRoomSubject> Subjects;
	FVector RoomCamLocation = FVector(0.0, 0.0, 300.0);
	FRotator RoomCamRotation = FRotator::ZeroRotator;
	float RoomDistance = 600.f;
	ERoom RoomState = ERoom::Empty;
	int32 RoomIndex = 0;
	int32 RoomFrames = 0;
	double RoomSince = 0.0;
	UPROPERTY(Transient)
	TObjectPtr<UObject> RoomAsset;
	UPROPERTY(Transient)
	TObjectPtr<AActor> RoomActor;

	// flyby
	TArray<FPoint> Points;
	int32 Leg = 0;
	double LegSince = 0.0;

	float CamFOV = 0.f;
	TWeakObjectPtr<ACameraActor> Camera;

	// What happened during the frame that just ended: the usual causes of a slow one.
	uint32 LastPsoTotal = 0;
	TArray<FString> FrameLoads;
	bool bFrameGC = false;
	FDelegateHandle LoadHandle, EndLoadHandle, GCHandle;
};
