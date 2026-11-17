// Scripted screenshots for unattended game runs. Part of the game module; costs nothing unless asked for.
//
// Command line (see Tools/gam3/ue_game.mjs, which passes these for you):
//   -Gam3Shots=0,5            take a screenshot at each time, in game seconds after the level is READY (the ready
//                             gate has opened: nothing compiling or loading, the player has a pawn). 0 is the first
//                             frame a player sees, which is the frame most worth checking.
//   -Gam3ShotPrefix=name      file prefix: Saved/Screenshots/<name>_00.png, <name>_01.png ... (default "shot")
//   -Gam3Quit=12              quit the game this many game seconds after it is ready
//   -Gam3Cam=X,Y,Z,Pitch,Yaw[,FOV]
//                             look through a fixed camera instead of the game's own view (for levels with no
//                             player camera yet, or to frame one spot). Omit it to capture what a player sees.
// The subsystem is only created when one of these is on the command line, and never in Shipping builds.
#pragma once

#include "CoreMinimal.h"
#include "Containers/Ticker.h"
#include "Subsystems/GameInstanceSubsystem.h"
#include "Gam3ShotDirector.generated.h"

class ACameraActor;

UCLASS()
class UGam3ShotDirector : public UGameInstanceSubsystem
{
	GENERATED_BODY()

public:
	virtual bool ShouldCreateSubsystem(UObject* Outer) const override;
	virtual void Initialize(FSubsystemCollectionBase& Collection) override;
	virtual void Deinitialize() override;

private:
	bool Tick(float DeltaSeconds);
	void HoldCamera(UWorld* World);

	FTSTicker::FDelegateHandle TickHandle;
	TArray<float> ShotTimes;
	FString Prefix = TEXT("shot");
	float QuitAt = -1.f;
	float Elapsed = 0.f;
	int32 NextShot = 0;
	int32 FramesSinceShot = 1000;
	int32 ReadyFrames = 0;

	bool bFixedCamera = false;
	FVector CamLocation = FVector::ZeroVector;
	FRotator CamRotation = FRotator::ZeroRotator;
	float CamFOV = 0.f;
	TWeakObjectPtr<ACameraActor> Camera;
};
