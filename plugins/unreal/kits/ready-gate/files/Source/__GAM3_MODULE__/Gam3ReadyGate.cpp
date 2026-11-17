#include "Gam3ReadyGate.h"

#include "AssetCompilingManager.h"
#include "Camera/PlayerCameraManager.h"
#include "Components/SkeletalMeshComponent.h"
#include "ContentStreaming.h"
#include "Engine/GameViewportClient.h"
#include "Engine/SkeletalMesh.h"
#include "Engine/World.h"
#include "Framework/Application/SlateApplication.h"
#include "GameFramework/GameModeBase.h"
#include "GameFramework/PlayerController.h"
#include "HAL/PlatformTime.h"
#include "Misc/App.h"
#include "Misc/CommandLine.h"
#include "Misc/Parse.h"
#include "ShaderPipelineCache.h"
#include "UnrealClient.h"
#include "Widgets/Colors/SColorBlock.h"
#include "UObject/Package.h"
#include "UObject/UObjectIterator.h"
#include "WorldPartition/WorldPartitionSubsystem.h"

bool UGam3ReadyGate::DoesSupportWorldType(const EWorldType::Type WorldType) const
{
	return WorldType == EWorldType::Game || WorldType == EWorldType::PIE;
}

void UGam3ReadyGate::Initialize(FSubsystemCollectionBase& Collection)
{
	Super::Initialize(Collection);
#if !UE_BUILD_SHIPPING
	// Unattended runs wait as long as a first shader compile takes, and watch for what a player would have seen.
	FParse::Value(FCommandLine::Get(), TEXT("Gam3ReadyTimeout="), TimeoutSeconds);
	bWatch = FParse::Param(FCommandLine::Get(), TEXT("Gam3Watch"));
#endif
}

UGam3ReadyGate* UGam3ReadyGate::Get(const UObject* WorldContextObject)
{
	const UWorld* World = GEngine ? GEngine->GetWorldFromContextObject(WorldContextObject, EGetWorldErrorMode::ReturnNull) : nullptr;
	return World ? World->GetSubsystem<UGam3ReadyGate>() : nullptr;
}

void UGam3ReadyGate::AddBlocker(FName Reason)
{
	if (bReady)
	{
		UE_LOG(LogTemp, Warning, TEXT("GAM3READY: blocker '%s' added after the gate opened; it holds nothing"), *Reason.ToString());
		return;
	}
	Blockers.Add(Reason);
}

void UGam3ReadyGate::RemoveBlocker(FName Reason)
{
	Blockers.Remove(Reason);
}

void UGam3ReadyGate::Collect(UWorld* World, bool bIncludeSoft, TArray<FString>& Waiting) const
{
	// Shaders, textures, meshes: everything the engine builds in the background (uncooked runs).
	if (const int32 Compiling = FAssetCompilingManager::Get().GetNumRemainingAssets(); Compiling > 0)
	{
		Waiting.Add(FString::Printf(TEXT("compiling:%d"), Compiling));
	}
	// Pipeline state objects from the shipped cache (packaged runs): drawing before these are done is what hitches.
	if (const uint32 Pso = FShaderPipelineCache::NumPrecompilesRemaining(); Pso > 0)
	{
		Waiting.Add(FString::Printf(TEXT("pso:%u"), Pso));
	}
	if (IsAsyncLoading()) Waiting.Add(TEXT("async-loading"));
	if (World->IsVisibilityRequestPending()) Waiting.Add(TEXT("level-streaming"));
	if (World->IsPartitionedWorld())
	{
		UWorldPartitionSubsystem* Partition = World->GetSubsystem<UWorldPartitionSubsystem>();
		if (Partition && !Partition->IsAllStreamingCompleted()) Waiting.Add(TEXT("world-partition"));
	}
	if (bWaitForPlayerPawn && World->GetNetMode() != NM_DedicatedServer)
	{
		const AGameModeBase* Mode = World->GetAuthGameMode();
		const APlayerController* PC = World->GetFirstPlayerController();
		// A game with no default pawn, or a player who starts as a spectator, is not waiting for one.
		const bool bExpectsPawn = Mode && Mode->DefaultPawnClass && PC && !PC->IsInState(NAME_Spectating);
		if (!PC) Waiting.Add(TEXT("player-controller"));
		else if (bExpectsPawn && !PC->GetPawn()) Waiting.Add(TEXT("player-pawn"));
	}
	for (const FName& Blocker : Blockers) Waiting.Add(FString::Printf(TEXT("blocker:%s"), *Blocker.ToString()));

	if (!bIncludeSoft) return;
	if (FApp::CanEverRender())
	{
		if (const int32 Textures = IStreamingManager::Get().GetNumWantingResources(); Textures > 0)
		{
			Waiting.Add(FString::Printf(TEXT("textures:%d"), Textures));
		}
	}
	if (PendingPoses.Num() > 0) Waiting.Add(FString::Printf(TEXT("poses:%d"), PendingPoses.Num()));
}

void UGam3ReadyGate::Deinitialize()
{
	Uncover(GetWorld());
	Super::Deinitialize();
}

void UGam3ReadyGate::Uncover(UWorld* World)
{
	if (!CoverWidget.IsValid()) return;
	if (UGameViewportClient* Viewport = World ? World->GetGameViewport() : nullptr)
	{
		Viewport->RemoveViewportWidgetContent(CoverWidget.ToSharedRef());
	}
	CoverWidget.Reset();
}

void UGam3ReadyGate::Cover(UWorld* World)
{
	if (!bCoverWithFade) return;
	const float Amount = 1.f;
	if (!CoverWidget.IsValid() && FSlateApplication::IsInitialized())
	{
		if (UGameViewportClient* Viewport = World->GetGameViewport())
		{
			TWeakObjectPtr<UGam3ReadyGate> Weak(this);
			CoverWidget = SNew(SColorBlock)
				.Visibility(EVisibility::HitTestInvisible)   // it hides; it does not take input away from the game
				.Color(TAttribute<FLinearColor>::CreateLambda([Weak]() { return FLinearColor(0.f, 0.f, 0.f, Weak.IsValid() ? Weak->CoverAlpha : 0.f); }));
			Viewport->AddViewportWidgetContent(CoverWidget.ToSharedRef(), 100000);
		}
	}
	for (FConstPlayerControllerIterator It = World->GetPlayerControllerIterator(); It; ++It)
	{
		const APlayerController* PC = It->Get();
		if (PC && PC->IsLocalController() && PC->PlayerCameraManager)
		{
			PC->PlayerCameraManager->SetManualCameraFade(Amount, FLinearColor::Black, true);
		}
	}
}

void UGam3ReadyGate::Open(UWorld* World, bool bTimedOut, const TArray<FString>& Waiting)
{
	bReady = true;
	ReadyWall = FPlatformTime::Seconds();
	const double Waited = ReadyWall - StartWall;
	if (bTimedOut)
	{
		UE_LOG(LogTemp, Warning, TEXT("GAM3READY: TIMEOUT waiting=%s frames=%d waited=%.1fs"), *FString::Join(Waiting, TEXT(",")), Frames, Waited);
	}
	else
	{
		UE_LOG(LogTemp, Display, TEXT("GAM3READY: ok frames=%d waited=%.1fs"), Frames, Waited);
	}
	if (bCoverWithFade)
	{
		for (FConstPlayerControllerIterator It = World->GetPlayerControllerIterator(); It; ++It)
		{
			const APlayerController* PC = It->Get();
			if (!PC || !PC->IsLocalController() || !PC->PlayerCameraManager) continue;
			// The layer above does the visible fade; this one only brings the sound back with it.
			if (FadeInSeconds > 0.f) PC->PlayerCameraManager->StartCameraFade(0.f, 0.f, FadeInSeconds, FLinearColor::Black, true, false);
			PC->PlayerCameraManager->SetManualCameraFade(0.f, FLinearColor::Black, false);
		}
		if (FadeInSeconds <= 0.f) Uncover(World);
	}
	OnReadyNative.Broadcast();
	OnReady.Broadcast();
}

bool UGam3ReadyGate::IsInReferencePose(USkeletalMeshComponent* Mesh)
{
	const USkeletalMesh* Asset = Mesh ? Mesh->GetSkeletalMeshAsset() : nullptr;
	if (!Asset) return false;
	const TArray<FTransform>& Ref = Asset->GetRefSkeleton().GetRefBonePose();
	const TArrayView<const FTransform> Local = Mesh->GetBoneSpaceTransformsView();
	if (Local.Num() != Ref.Num() || Ref.Num() < 2) return false;
	for (int32 Bone = 1; Bone < Ref.Num(); ++Bone)   // the root moves with the actor, so it proves nothing
	{
		if (!Local[Bone].Equals(Ref[Bone], 1.e-3f)) return false;
	}
	return true;
}

bool UGam3ReadyGate::TryPose(USkeletalMeshComponent* Mesh)
{
	const USkeletalMesh* Asset = Mesh->GetSkeletalMeshAsset();
	if (!Asset || Asset->IsCompiling() || !Mesh->IsRegistered()) return false;
	// A hidden mesh is not "recently rendered", and by default such a mesh does not animate: evaluate it by hand.
	Mesh->TickAnimation(0.f, false);
	Mesh->RefreshBoneTransforms();
	return !IsInReferencePose(Mesh);
}

void UGam3ReadyGate::ShowWhenPosed(USkeletalMeshComponent* Mesh, float TimeoutSeconds)
{
	UGam3ReadyGate* Gate = Get(Mesh);
	if (!Mesh || !Gate) return;
	if (Mesh->LeaderPoseComponent.IsValid()) return;   // it copies its leader's pose; gate the leader instead
	if (TryPose(Mesh)) return;
	Mesh->SetVisibility(false, true);
	Gate->PendingPoses.Add({ Mesh, FPlatformTime::Seconds() + FMath::Max(TimeoutSeconds, 0.f) });
}

void UGam3ReadyGate::ShowActorWhenPosed(AActor* Actor, float TimeoutSeconds)
{
	if (!Actor) return;
	TInlineComponentArray<USkeletalMeshComponent*> Meshes(Actor);
	for (USkeletalMeshComponent* Mesh : Meshes) ShowWhenPosed(Mesh, TimeoutSeconds);
}

void UGam3ReadyGate::UpdatePoses()
{
	const double Now = FPlatformTime::Seconds();
	for (int32 Index = PendingPoses.Num() - 1; Index >= 0; --Index)
	{
		USkeletalMeshComponent* Mesh = PendingPoses[Index].Mesh.Get();
		if (!Mesh)
		{
			PendingPoses.RemoveAtSwap(Index);
			continue;
		}
		const bool bPosed = TryPose(Mesh);
		if (!bPosed && Now < PendingPoses[Index].Deadline) continue;
		if (!bPosed)
		{
			UE_LOG(LogTemp, Warning, TEXT("GAM3POSE: TIMEOUT actor=%s mesh=%s still in its bind pose; shown anyway. Does it have an animation to play?"),
				*GetNameSafe(Mesh->GetOwner()), *Mesh->GetName());
		}
		Mesh->SetVisibility(true, true);
		PendingPoses.RemoveAtSwap(Index);
	}
}

void UGam3ReadyGate::Watch(UWorld* World, double Now)
{
	const double SinceReady = Now - ReadyWall;
	if (const int32 Compiling = FAssetCompilingManager::Get().GetNumRemainingAssets(); Compiling > 0 && Now - LastLateCompileLog > 1.0)
	{
		LastLateCompileLog = Now;
		UE_LOG(LogTemp, Warning, TEXT("GAM3WATCH: late-compile assets=%d t=%.2fs"), Compiling, SinceReady);
	}
	// Writing a screenshot stalls its own frame: that is the capture's cost, not the game's.
	if (FScreenshotRequest::IsScreenshotRequested()) LastShotFrame = Frames;
	if (SinceReady < 10.0 && Frames > 1 && Now - LastWall > 0.25 && Frames - LastShotFrame > 3)
	{
		UE_LOG(LogTemp, Warning, TEXT("GAM3WATCH: hitch %.2fs t=%.2fs"), Now - LastWall, SinceReady);
	}
	// Bind pose: only what was drawn counts. A mesh nobody can see does not animate by default, so it sits in its
	// bind pose legitimately; and with no renderer (-nullrhi) nothing is drawn at all, so this check needs a picture.
	if (!FApp::CanEverRender()) return;
	for (TObjectIterator<USkeletalMeshComponent> It; It; ++It)
	{
		USkeletalMeshComponent* Mesh = *It;
		if (Mesh->GetWorld() != World || !Mesh->IsRegistered() || Mesh->LeaderPoseComponent.IsValid()) continue;
		if (!Mesh->IsVisible() || !Mesh->WasRecentlyRendered(0.1f)) continue;
		const bool bAnimated = Mesh->GetAnimInstance() != nullptr || Mesh->AnimClass != nullptr || Mesh->AnimationData.AnimToPlay != nullptr;
		if (IsInReferencePose(Mesh))
		{
			// A mesh with nothing to play may be a prop that is meant to stand in this pose: it is only reported
			// if it starts animating later, which shows the pose was a wait, not a choice.
			const int32 Count = ++BindPoseFrames.FindOrAdd(Mesh);
			if (bAnimated && Count == StuckFrames)
			{
				BindPoseReported.Add(Mesh);
				UE_LOG(LogTemp, Warning, TEXT("GAM3WATCH: bind-pose visible actor=%s mesh=%s frames=%d+ (still in it) t=%.2fs"), *GetNameSafe(Mesh->GetOwner()), *Mesh->GetName(), Count, SinceReady);
			}
		}
		else if (const int32* Count = BindPoseFrames.Find(Mesh))
		{
			if (!BindPoseReported.Contains(Mesh))
			{
				UE_LOG(LogTemp, Warning, TEXT("GAM3WATCH: bind-pose visible actor=%s mesh=%s frames=%d before it animated t=%.2fs"), *GetNameSafe(Mesh->GetOwner()), *Mesh->GetName(), *Count, SinceReady);
			}
			BindPoseFrames.Remove(Mesh);
			BindPoseReported.Remove(Mesh);
		}
	}
}

void UGam3ReadyGate::Tick(float DeltaTime)
{
	Super::Tick(DeltaTime);
	UWorld* World = GetWorld();
	if (!World || !World->HasBegunPlay()) return;
	const double Now = FPlatformTime::Seconds();   // real time: compiles and loads do not follow game time
	if (StartWall == 0.0) StartWall = Now;
	++Frames;
	UpdatePoses();

	if (!bReady)
	{
		Cover(World);
		const double Waited = Now - StartWall;
		TArray<FString> Waiting;
		Collect(World, Waited < SoftSeconds, Waiting);
		Settled = Waiting.Num() == 0 ? Settled + 1 : 0;
		const bool bTimedOut = Waited > TimeoutSeconds;
		if (bTimedOut && Waiting.Num() == 0) Waiting.Add(TEXT("settling"));
		if (Settled >= FMath::Max(SettleFrames, 1) || bTimedOut) Open(World, bTimedOut && Settled < FMath::Max(SettleFrames, 1), Waiting);
	}
	else if (CoverWidget.IsValid())
	{
		CoverAlpha = 1.f - static_cast<float>((Now - ReadyWall) / FMath::Max(FadeInSeconds, 0.01f));
		if (CoverAlpha <= 0.f) Uncover(World);
	}
#if !UE_BUILD_SHIPPING
	if (bReady && bWatch)
	{
		Watch(World, Now);
	}
#endif
	LastWall = Now;
}
