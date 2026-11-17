// The ready gate: nobody sees the level until it is actually ready, and no character is shown in its bind pose.
//
// A level that has "begun play" is not ready to look at. Shaders and textures are still arriving, streamed levels
// are still loading, the player's pawn may not exist yet, and a skeletal mesh draws in its bind pose (the T or A
// pose) until its animation has been evaluated once. A player who sees those first frames sees a broken game, and
// a screenshot taken then is a picture of loading, not of the game.
//
// What this gives the game, with no code of your own:
//   - a black cover over everything, the HUD and UI included (a full-screen layer on the viewport; audio is
//     muted by a camera fade), from the first frame until the gate opens, then a short fade in;
//   - the gate opens when nothing is still compiling or loading, the player has a pawn, every blocker you added
//     is removed, and that has held for SettleFrames frames in a row;
//   - a timeout, so a stuck condition is logged with its reason instead of holding the player forever.
// What you add where the game needs it:
//   - UGam3ReadyGate::ShowWhenPosed(Mesh) after spawning a character: it is drawn only once it has left its bind pose;
//   - AddBlocker / RemoveBlocker around your own loading (a save file, a procedural level, a server handshake);
//   - bind OnReady to start the match, the music and the intro: time should not pass behind the cover.
// Using your own loading screen: set bCoverWithFade=False and remove the screen in OnReady.
//
// Settings, in Config/DefaultGame.ini under [/Script/__GAM3_MODULE__.Gam3ReadyGate]: bCoverWithFade, FadeInSeconds,
// SettleFrames, TimeoutSeconds, SoftSeconds, bWaitForPlayerPawn.
//
// Log lines (the tools in Tools/gam3 read these):
//   GAM3READY: ok frames=<n> waited=<s>s            or   GAM3READY: TIMEOUT waiting=<reasons> ...
//   GAM3WATCH: bind-pose visible actor=<name> ...   a mesh was drawn in its bind pose before it animated (needs a
//                                                   renderer: not checked under -nullrhi)
//   GAM3WATCH: late-compile assets=<n> ...          something was still compiling after the gate opened
//   GAM3WATCH: hitch <s>s ...                       a frame took over a quarter of a second soon after it opened
// The GAM3WATCH checks run only with -Gam3Watch on the command line and never in Shipping builds.
#pragma once

#include "CoreMinimal.h"
#include "Subsystems/WorldSubsystem.h"
#include "Gam3ReadyGate.generated.h"

class AActor;
class SWidget;
class USkeletalMeshComponent;

DECLARE_DYNAMIC_MULTICAST_DELEGATE(FGam3OnReady);

UCLASS(Config = Game)
class __GAM3_MODULE_API__ UGam3ReadyGate : public UTickableWorldSubsystem
{
	GENERATED_BODY()

public:
	UFUNCTION(BlueprintPure, Category = "Gam3|Ready", meta = (WorldContext = "WorldContextObject"))
	static UGam3ReadyGate* Get(const UObject* WorldContextObject);

	/** True once the gate has opened: the cover is coming off and the level may be judged. */
	UFUNCTION(BlueprintPure, Category = "Gam3|Ready")
	bool IsReady() const { return bReady; }

	/** Keep the gate shut until RemoveBlocker is called with the same name. */
	UFUNCTION(BlueprintCallable, Category = "Gam3|Ready")
	void AddBlocker(FName Reason);

	UFUNCTION(BlueprintCallable, Category = "Gam3|Ready")
	void RemoveBlocker(FName Reason);

	/** Fires once, when the gate opens. Start gameplay time, music and intros here. */
	UPROPERTY(BlueprintAssignable, Category = "Gam3|Ready")
	FGam3OnReady OnReady;
	FSimpleMulticastDelegate OnReadyNative;

	/**
	 * Call right after spawning or re-dressing a character. If its animation can be evaluated now, it is, and the
	 * mesh stays visible. Otherwise the mesh (and what is attached to it) is hidden until it has left its bind
	 * pose, or until the timeout, which is logged.
	 */
	UFUNCTION(BlueprintCallable, Category = "Gam3|Ready")
	static void ShowWhenPosed(USkeletalMeshComponent* Mesh, float TimeoutSeconds = 1.f);

	/** ShowWhenPosed for every skeletal mesh on the actor. */
	UFUNCTION(BlueprintCallable, Category = "Gam3|Ready")
	static void ShowActorWhenPosed(AActor* Actor, float TimeoutSeconds = 1.f);

	/** True when every bone but the root is exactly where the skeleton's bind pose puts it. */
	UFUNCTION(BlueprintPure, Category = "Gam3|Ready")
	static bool IsInReferencePose(USkeletalMeshComponent* Mesh);

	UPROPERTY(Config, EditAnywhere, Category = "Gam3|Ready")
	bool bCoverWithFade = true;
	UPROPERTY(Config, EditAnywhere, Category = "Gam3|Ready")
	float FadeInSeconds = 0.35f;
	/** Frames in a row with nothing pending before the gate opens. Also lets exposure and lighting settle. */
	UPROPERTY(Config, EditAnywhere, Category = "Gam3|Ready")
	int32 SettleFrames = 10;
	/** Real seconds after which the gate opens regardless, logging what it was waiting for. */
	UPROPERTY(Config, EditAnywhere, Category = "Gam3|Ready")
	float TimeoutSeconds = 30.f;
	/** Texture streaming and posing characters hold the gate only this long: they may never fully finish. */
	UPROPERTY(Config, EditAnywhere, Category = "Gam3|Ready")
	float SoftSeconds = 4.f;
	UPROPERTY(Config, EditAnywhere, Category = "Gam3|Ready")
	bool bWaitForPlayerPawn = true;

	virtual void Initialize(FSubsystemCollectionBase& Collection) override;
	virtual void Deinitialize() override;
	virtual void Tick(float DeltaTime) override;
	virtual TStatId GetStatId() const override { RETURN_QUICK_DECLARE_CYCLE_STAT(UGam3ReadyGate, STATGROUP_Tickables); }
	virtual bool DoesSupportWorldType(const EWorldType::Type WorldType) const override;

private:
	struct FPendingPose
	{
		TWeakObjectPtr<USkeletalMeshComponent> Mesh;
		double Deadline = 0.0;
	};

	void Collect(UWorld* World, bool bIncludeSoft, TArray<FString>& Waiting) const;
	void Cover(UWorld* World);
	void Uncover(UWorld* World);
	void Open(UWorld* World, bool bTimedOut, const TArray<FString>& Waiting);
	void UpdatePoses();
	void Watch(UWorld* World, double Now);
	static bool TryPose(USkeletalMeshComponent* Mesh);

	/** The layer above the HUD and UI. A camera fade alone leaves both showing over a black scene. */
	TSharedPtr<SWidget> CoverWidget;
	float CoverAlpha = 1.f;

	bool bReady = false;
	bool bWatch = false;
	int32 Frames = 0;
	int32 Settled = 0;
	int32 LastShotFrame = -1000;
	double StartWall = 0.0;
	double ReadyWall = 0.0;
	double LastWall = 0.0;
	double LastLateCompileLog = 0.0;
	TSet<FName> Blockers;
	TArray<FPendingPose> PendingPoses;
	static constexpr int32 StuckFrames = 30;
	TMap<TWeakObjectPtr<USkeletalMeshComponent>, int32> BindPoseFrames;
	TSet<TWeakObjectPtr<USkeletalMeshComponent>> BindPoseReported;
};
