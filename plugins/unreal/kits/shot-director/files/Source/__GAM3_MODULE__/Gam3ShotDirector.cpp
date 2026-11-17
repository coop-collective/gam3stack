#include "Gam3ShotDirector.h"

#include "Camera/CameraActor.h"
#include "Camera/CameraComponent.h"
#include "Engine/GameInstance.h"
#include "Engine/World.h"
#include "Gam3ReadyGate.h"
#include "GameFramework/PlayerController.h"
#include "Kismet/KismetSystemLibrary.h"
#include "Misc/CommandLine.h"
#include "Misc/Parse.h"
#include "Misc/Paths.h"
#include "UnrealClient.h"

bool UGam3ShotDirector::ShouldCreateSubsystem(UObject* Outer) const
{
#if UE_BUILD_SHIPPING
	return false;
#else
	const TCHAR* Cmd = FCommandLine::Get();
	FString Unused;
	return FParse::Value(Cmd, TEXT("Gam3Shots="), Unused, false) || FParse::Value(Cmd, TEXT("Gam3Quit="), Unused, false)
		|| FParse::Value(Cmd, TEXT("Gam3Cam="), Unused, false);
#endif
}

void UGam3ShotDirector::Initialize(FSubsystemCollectionBase& Collection)
{
	Super::Initialize(Collection);
	const TCHAR* Cmd = FCommandLine::Get();

	FString Shots;
	if (FParse::Value(Cmd, TEXT("Gam3Shots="), Shots, false))
	{
		TArray<FString> Parts;
		Shots.ParseIntoArray(Parts, TEXT(","));
		for (const FString& Part : Parts) ShotTimes.Add(FCString::Atof(*Part));
		ShotTimes.Sort();
	}
	FParse::Value(Cmd, TEXT("Gam3ShotPrefix="), Prefix);
	FParse::Value(Cmd, TEXT("Gam3Quit="), QuitAt);

	FString Cam;
	if (FParse::Value(Cmd, TEXT("Gam3Cam="), Cam, false))
	{
		TArray<FString> Parts;
		Cam.ParseIntoArray(Parts, TEXT(","));
		if (Parts.Num() >= 5)
		{
			bFixedCamera = true;
			CamLocation = FVector(FCString::Atod(*Parts[0]), FCString::Atod(*Parts[1]), FCString::Atod(*Parts[2]));
			CamRotation = FRotator(FCString::Atod(*Parts[3]), FCString::Atod(*Parts[4]), 0.0);
			CamFOV = Parts.Num() >= 6 ? FCString::Atof(*Parts[5]) : 0.f;
		}
		else
		{
			UE_LOG(LogTemp, Warning, TEXT("GAM3SHOT: -Gam3Cam needs X,Y,Z,Pitch,Yaw[,FOV]; got '%s'"), *Cam);
		}
	}
	TickHandle = FTSTicker::GetCoreTicker().AddTicker(FTickerDelegate::CreateUObject(this, &UGam3ShotDirector::Tick));
}

void UGam3ShotDirector::Deinitialize()
{
	FTSTicker::GetCoreTicker().RemoveTicker(TickHandle);
	Super::Deinitialize();
}

void UGam3ShotDirector::HoldCamera(UWorld* World)
{
	APlayerController* PC = World->GetFirstPlayerController();
	if (!PC) return;
	if (!Camera.IsValid())
	{
		ACameraActor* NewCamera = World->SpawnActor<ACameraActor>(CamLocation, CamRotation);
		if (!NewCamera) return;
		if (UCameraComponent* Lens = NewCamera->GetCameraComponent())
		{
			Lens->bConstrainAspectRatio = false;
			if (CamFOV > 0.f) Lens->SetFieldOfView(CamFOV);
		}
		Camera = NewCamera;
	}
	// Game code may take the view back (a pawn spawning, a cutscene): hold it every frame.
	if (PC->GetViewTarget() != Camera.Get()) PC->SetViewTarget(Camera.Get());
}

bool UGam3ShotDirector::Tick(float DeltaSeconds)
{
	UWorld* World = GetGameInstance() ? GetGameInstance()->GetWorld() : nullptr;
	if (!World || !World->HasBegunPlay()) return true;

	if (bFixedCamera) HoldCamera(World);
	// The clock starts when the level is ready to be looked at, not when it begins play: a capture of a level that
	// is still compiling shaders or streaming in is a picture of loading.
	UGam3ReadyGate* Gate = World->GetSubsystem<UGam3ReadyGate>();
	if (Gate)
	{
		Gate->FadeInSeconds = 0.f;   // a capture at 0 must show the first frame, not a fade
		if (!Gate->IsReady()) return true;
	}
	if (++ReadyFrames <= 2) return true;   // the cover comes off on the camera's next update
	// A long hitch (shader compiles on a first run) must not swallow the timeline: no frame counts for more than this.
	Elapsed += FMath::Min(DeltaSeconds, 0.25f);
	++FramesSinceShot;

	if (NextShot < ShotTimes.Num() && Elapsed >= ShotTimes[NextShot])
	{
		const FString Name = FPaths::ProjectSavedDir() / TEXT("Screenshots") / FString::Printf(TEXT("%s_%02d.png"), *Prefix, NextShot);
		FScreenshotRequest::RequestScreenshot(Name, false, false);
		UE_LOG(LogTemp, Display, TEXT("GAM3SHOT: %s at %.1fs"), *Name, Elapsed);
		++NextShot;
		FramesSinceShot = 0;
	}
	// The image is written a few frames after it is requested: never quit on top of a pending shot.
	const bool bShotsDone = NextShot >= ShotTimes.Num() || ShotTimes[NextShot] > QuitAt;
	if (QuitAt > 0.f && Elapsed >= QuitAt && bShotsDone && FramesSinceShot > 8)
	{
		QuitAt = -1.f;
		UE_LOG(LogTemp, Display, TEXT("GAM3SHOT: quitting at %.1fs"), Elapsed);
		UKismetSystemLibrary::QuitGame(World, World->GetFirstPlayerController(), EQuitPreference::Quit, false);
	}
	return true;
}
