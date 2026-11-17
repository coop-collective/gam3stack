// Scripted screenshots for unattended game runs. Part of the game module; costs nothing unless asked for.
//
// Command line (see Tools/gam3/ue_game.mjs, which passes these for you):
//   -Gam3Shots=5,9            take a screenshot at each time, in seconds after the level begins play
//   -Gam3ShotPrefix=name      file prefix: Saved/Screenshots/<name>_00.png, <name>_01.png ... (default "shot")
//   -Gam3Quit=12              quit the game after this many seconds
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

	bool bFixedCamera = false;
	FVector CamLocation = FVector::ZeroVector;
	FRotator CamRotation = FRotator::ZeroRotator;
	float CamFOV = 0.f;
	TWeakObjectPtr<ACameraActor> Camera;
};
