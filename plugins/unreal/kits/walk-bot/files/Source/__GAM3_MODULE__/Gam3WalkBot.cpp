#include "Gam3WalkBot.h"

#include "Camera/PlayerCameraManager.h"
#include "Components/SkeletalMeshComponent.h"
#include "Engine/Engine.h"
#include "Engine/LocalPlayer.h"
#include "Engine/World.h"
#include "EnhancedInputComponent.h"
#include "EnhancedInputSubsystems.h"
#include "Gam3ReadyGate.h"
#include "GameFramework/Character.h"
#include "GameFramework/Pawn.h"
#include "GameFramework/PawnMovementComponent.h"
#include "GameFramework/PlayerController.h"
#include "GameFramework/WorldSettings.h"
#include "HAL/PlatformTime.h"
#include "InputAction.h"
#include "Kismet/KismetSystemLibrary.h"
#include "Misc/CommandLine.h"
#include "Misc/FileHelper.h"
#include "Misc/Parse.h"
#include "Misc/Paths.h"
#include "UnrealClient.h"

namespace
{
	const TCHAR* KindNames[] = { TEXT("stuck"), TEXT("fell"), TEXT("slide"), TEXT("speed"), TEXT("nan"), TEXT("camera-inside") };

	bool ParsePoint(const FString& Text, FVector& Out)
	{
		TArray<FString> Parts;
		Text.ParseIntoArray(Parts, TEXT(","));
		if (Parts.Num() < 2) return false;
		Out = FVector(FCString::Atod(*Parts[0]), FCString::Atod(*Parts[1]), Parts.Num() > 2 ? FCString::Atod(*Parts[2]) : 0.0);
		return true;
	}

	FString Where(const FVector& V)
	{
		return FString::Printf(TEXT("(%.0f,%.0f,%.0f)"), V.X, V.Y, V.Z);
	}
}

bool UGam3WalkBot::ShouldCreateSubsystem(UObject* Outer) const
{
#if UE_BUILD_SHIPPING
	return false;
#else
	FString Unused;
	return FParse::Value(FCommandLine::Get(), TEXT("Gam3Bot="), Unused, false);
#endif
}

bool UGam3WalkBot::DoesSupportWorldType(const EWorldType::Type WorldType) const
{
	return WorldType == EWorldType::Game || WorldType == EWorldType::PIE;
}

UGam3WalkBot* UGam3WalkBot::Get(const UObject* WorldContextObject)
{
	const UWorld* World = GEngine ? GEngine->GetWorldFromContextObject(WorldContextObject, EGetWorldErrorMode::ReturnNull) : nullptr;
	return World ? World->GetSubsystem<UGam3WalkBot>() : nullptr;
}

void UGam3WalkBot::Initialize(FSubsystemCollectionBase& Collection)
{
	Super::Initialize(Collection);
	const TCHAR* Cmd = FCommandLine::Get();
	FString Mode;
	FParse::Value(Cmd, TEXT("Gam3Bot="), Mode, false);
	bWander = !Mode.Equals(TEXT("route"), ESearchCase::IgnoreCase);
	FParse::Value(Cmd, TEXT("Gam3BotSeed="), Seed);
	FParse::Value(Cmd, TEXT("Gam3BotSeconds="), Seconds);
	FParse::Value(Cmd, TEXT("Gam3BotMoveAction="), MoveActionName);
	FParse::Value(Cmd, TEXT("Gam3BotJumpAction="), JumpActionName);
	bHasFloor = FParse::Value(Cmd, TEXT("Gam3BotFloorZ="), FloorZ);
	FString Input;
	if (FParse::Value(Cmd, TEXT("Gam3BotInput="), Input)) bForceMovement = Input.Equals(TEXT("movement"), ESearchCase::IgnoreCase);
	bShots = FParse::Param(Cmd, TEXT("Gam3BotShots")) || FParse::Value(Cmd, TEXT("Gam3BotShots="), ShotPrefix);

	FString RouteText;
	FString RouteFile;
	TArray<FString> Points;
	if (FParse::Value(Cmd, TEXT("Gam3BotRoute="), RouteText, false)) RouteText.ParseIntoArray(Points, TEXT(";"));
	else if (FParse::Value(Cmd, TEXT("Gam3BotRouteFile="), RouteFile, false))
	{
		TArray<FString> Lines;
		FFileHelper::LoadFileToStringArray(Lines, *RouteFile);
		for (FString Line : Lines)
		{
			int32 Hash = INDEX_NONE;
			if (Line.FindChar(TEXT('#'), Hash)) Line.LeftInline(Hash);
			Line.TrimStartAndEndInline();
			if (!Line.IsEmpty()) Points.Add(Line);
		}
	}
	for (const FString& Point : Points)
	{
		FVector P;
		if (ParsePoint(Point, P)) Route.Add(P);
		else UE_LOG(LogTemp, Warning, TEXT("GAM3WALK: note bad waypoint '%s' (needs x,y[,z])"), *Point);
	}
	if (!bWander && !Route.Num()) UE_LOG(LogTemp, Warning, TEXT("GAM3WALK: note route mode with no waypoints: nothing to walk"));
	Rand.Initialize(Seed);
}

void UGam3WalkBot::Deinitialize()
{
	// A run that something else ended (a performance run's own quit) still reports what the bot saw.
	if (bBegun && !bDonePrinted)
	{
		EndWall = FPlatformTime::Seconds();
		PrintDone();
	}
	Super::Deinitialize();
}

void UGam3WalkBot::Begin(UWorld* World)
{
	bBegun = true;
	BeginWall = FPlatformTime::Seconds();
	Heading = Rand.FRandRange(0.f, 360.f);
	HoldLeft = 0.f;
	UE_LOG(LogTemp, Display, TEXT("GAM3WALK: start mode=%s seed=%d seconds=%.1f waypoints=%d"), bWander ? TEXT("wander") : TEXT("route"), Seed, Seconds, Route.Num());
}

void UGam3WalkBot::FindInput(APlayerController* PC, APawn* Pawn)
{
	MoveAction = nullptr;
	JumpAction = nullptr;
	bEnhanced = false;
	InputYawFix = 0.f;
	SteadyTime = 0.f;
	if (!bForceMovement)
	{
		for (UInputComponent* Component : { ToRawPtr(Pawn->InputComponent), ToRawPtr(PC->InputComponent) })
		{
			const UEnhancedInputComponent* Enhanced = Cast<UEnhancedInputComponent>(Component);
			if (!Enhanced) continue;
			for (const TUniquePtr<FEnhancedInputActionEventBinding>& Binding : Enhanced->GetActionEventBindings())
			{
				const UInputAction* Action = Binding ? Binding->GetAction() : nullptr;
				if (!Action) continue;
				const FString Name = Action->GetName();
				const bool bMove = MoveActionName.IsEmpty() ? (Name.Contains(TEXT("Move")) && Action->ValueType == EInputActionValueType::Axis2D) : Name == MoveActionName;
				const bool bJump = JumpActionName.IsEmpty() ? Name.Contains(TEXT("Jump")) : Name == JumpActionName;
				if (bMove && !MoveAction.IsValid()) MoveAction = Action;
				if (bJump && !JumpAction.IsValid()) JumpAction = Action;
			}
		}
		bEnhanced = MoveAction.IsValid() && PC->GetLocalPlayer() && ULocalPlayer::GetSubsystem<UEnhancedInputLocalPlayerSubsystem>(PC->GetLocalPlayer());
	}
	UE_LOG(LogTemp, Display, TEXT("GAM3WALK: note input=%s pawn=%s move_action=%s jump_action=%s"), bEnhanced ? TEXT("enhanced") : TEXT("movement"), *Pawn->GetClass()->GetName(),
		MoveAction.IsValid() ? *MoveAction->GetName() : TEXT("none"), JumpAction.IsValid() ? *JumpAction->GetName() : TEXT("none"));

	// The slide check reads bone positions. With no renderer nothing is "recently rendered", and by default a mesh
	// that is not rendered does not update its bones: ask this one to.
	SlideMesh = nullptr;
	if (const ACharacter* Character = Cast<ACharacter>(Pawn)) SlideMesh = Character->GetMesh();
	if (!SlideMesh.IsValid() || !SlideMesh->GetSkeletalMeshAsset())
	{
		SlideMesh = nullptr;
		TArray<USkeletalMeshComponent*> Meshes;
		Pawn->GetComponents(Meshes);
		for (USkeletalMeshComponent* Mesh : Meshes) if (Mesh && Mesh->GetSkeletalMeshAsset()) { SlideMesh = Mesh; break; }
	}
	if (SlideMesh.IsValid()) SlideMesh->VisibilityBasedAnimTickOption = EVisibilityBasedAnimTickOption::AlwaysTickPoseAndRefreshBones;
	else if (!bSlideNoted)
	{
		bSlideNoted = true;
		UE_LOG(LogTemp, Display, TEXT("GAM3WALK: note the pawn has no skeletal mesh, so slide is not checked"));
	}
	SlideTime = 0.f;
}

void UGam3WalkBot::Log(const FString& Kind, const FString& Detail)
{
	UE_LOG(LogTemp, Warning, TEXT("GAM3WALK: %s at=%s t=%.2f %s"), *Kind, *Where(LastLocation), GameTime, *Detail);
	if (bShots) ShotQueue.Add(Kind);
}

void UGam3WalkBot::Raise(EKind Kind, const FString& Detail)
{
	const int32 Index = int32(Kind);
	if (bActive[Index]) return;
	bActive[Index] = true;
	++Counts[Index];
	Log(KindNames[Index], Detail);
}

void UGam3WalkBot::ReportIncident(FName Kind, const FString& Detail)
{
	FString Name = Kind.ToString().ToLower();
	for (TCHAR& C : Name) if (!FChar::IsAlnum(C) && C != TEXT('-') && C != TEXT('_')) C = TEXT('-');
	++GameCounts.FindOrAdd(FName(*Name));
	Log(Name, Detail);
}

void UGam3WalkBot::Check(UWorld* World, APlayerController* PC, APawn* Pawn, float Dt)
{
	const FVector Location = Pawn->GetActorLocation();
	const FVector Velocity = Pawn->GetVelocity();
	if (Location.ContainsNaN() || Velocity.ContainsNaN())
	{
		Raise(EKind::Nan, TEXT("the pawn's position or velocity is not a number"));
		return;
	}
	Clear(EKind::Nan);

	const UPawnMovementComponent* Movement = Pawn->GetMovementComponent();
	const float MaxSpeed = Movement ? Movement->GetMaxSpeed() : 0.f;
	const bool bOnGround = Movement ? Movement->IsMovingOnGround() : false;
	const bool bFalling = Movement ? Movement->IsFalling() : false;

	// speed: a jump in position no velocity explains, or ground speed the movement component does not allow.
	if (bHaveLast)
	{
		const double Step = FVector::Dist(Location, LastLocation);
		const double Allowed = FMath::Max3(Velocity.Size(), LastVelocity.Size(), double(MaxSpeed)) * Dt * 3.0 + 50.0;
		if (Step > Allowed && !bTeleportNoted)
		{
			Clear(EKind::Speed);
			LastLocation = Location;
			Raise(EKind::Speed, FString::Printf(TEXT("moved %.0f cm in one frame (its speed allows %.0f)"), Step, Allowed));
			Clear(EKind::Speed);
			StuckAnchor = TrapAnchor = Location;
			StuckTime = TrapTime = 0.f;
		}
		else if (Step <= Allowed) Distance += Step;
	}
	bTeleportNoted = false;
	if (MaxSpeed > 0.f && bOnGround && Velocity.Size2D() > MaxSpeed * SpeedMargin + 10.f)
	{
		OverspeedTime += Dt;
		if (OverspeedTime > 0.25f)
		{
			LastLocation = Location;
			Raise(EKind::Speed, FString::Printf(TEXT("ground speed %.0f cm/s, its movement allows %.0f"), Velocity.Size2D(), MaxSpeed));
		}
	}
	else
	{
		if (OverspeedTime > 0.25f) Clear(EKind::Speed);
		OverspeedTime = 0.f;
	}
	LastLocation = Location;
	LastVelocity = Velocity;
	bHaveLast = true;

	// fell: below the floor, or falling for longer than any jump or drop in the level should take.
	const float KillZ = World->GetWorldSettings() ? World->GetWorldSettings()->KillZ : -HALF_WORLD_MAX;
	FallTime = bFalling ? FallTime + Dt : 0.f;
	if (bHasFloor && Location.Z < FloorZ) Raise(EKind::Fell, FString::Printf(TEXT("below the floor height %.0f"), FloorZ));
	else if (Location.Z < KillZ) Raise(EKind::Fell, FString::Printf(TEXT("below the level's KillZ %.0f"), KillZ));
	else if (FallTime > FallSeconds) Raise(EKind::Fell, FString::Printf(TEXT("falling for %.1f s"), FallTime));
	else Clear(EKind::Fell);

	// stuck: the bot kept pushing and the pawn never left a small circle.
	if (FVector::Dist2D(Location, StuckAnchor) > StuckRadius)
	{
		StuckAnchor = Location;
		StuckTime = 0.f;
		Clear(EKind::Stuck);
	}
	else if (bWantsMove && FallTime < 1.f)   // a jump on the spot is still stuck; a long fall is `fell`
	{
		StuckTime += Dt;
		if (StuckTime > StuckSeconds)
		{
			Raise(EKind::Stuck, FString::Printf(TEXT("input held %.1f s without leaving a %.0f cm circle"), StuckTime, StuckRadius));
			LastStuckAt = Location;
			bHaveStuckAt = true;
		}
	}

	// A pocket bigger than the circle: the wander turns and paces, and still never gets out.
	if (bWander && TrapSeconds > 0.f)
	{
		if (FVector::Dist2D(Location, TrapAnchor) > TrapRadius) { TrapAnchor = Location; TrapTime = 0.f; bTrapped = false; }
		else if (bWantsMove && FallTime < 1.f)
		{
			TrapTime += Dt;
			if (TrapTime > TrapSeconds && !bTrapped && bHaveStuckAt && FVector::Dist2D(Location, LastStuckAt) < TrapRadius) bTrapped = true;   // the same place, already reported
			if (TrapTime > TrapSeconds && !bTrapped)
			{
				bTrapped = true;
				++Counts[int32(EKind::Stuck)];
				Log(KindNames[int32(EKind::Stuck)], FString::Printf(TEXT("wandered %.0f s without leaving a %.0f cm circle"), TrapTime, TrapRadius));
			}
		}
	}

	// slide: travelling over the ground while the skeleton holds still (an idle or frozen pose, or the bind pose).
	if (USkeletalMeshComponent* Mesh = SlideMesh.Get())
	{
		const TArray<FTransform>& Bones = Mesh->GetComponentSpaceTransforms();
		if (bOnGround && Velocity.Size2D() > SlideSpeed && Bones.Num() > 1)
		{
			if (SlideTime <= 0.f || SlideStart.Num() != Bones.Num())
			{
				SlideStart.SetNum(Bones.Num());
				for (int32 i = 0; i < Bones.Num(); ++i) SlideStart[i] = Bones[i].GetLocation();
				SlideMaxBone = 0.f;
				SlideTime = 0.f;
			}
			SlideTime += Dt;
			for (int32 i = 0; i < Bones.Num(); ++i) SlideMaxBone = FMath::Max(SlideMaxBone, float(FVector::Dist(Bones[i].GetLocation(), SlideStart[i])));
			if (SlideTime >= SlideSeconds)
			{
				if (SlideMaxBone < SlideBoneCm) Raise(EKind::Slide, FString::Printf(TEXT("moving at %.0f cm/s for %.2f s while no bone moved more than %.1f cm"), Velocity.Size2D(), SlideTime, SlideMaxBone));
				else Clear(EKind::Slide);
				SlideTime = 0.f;
			}
		}
		else SlideTime = 0.f;
	}

	// camera-inside: the view point is inside something that blocks the camera channel. The pawn itself does not count.
	if (PC->PlayerCameraManager && CameraRadius > 0.f)
	{
		FCollisionQueryParams Params(SCENE_QUERY_STAT(Gam3WalkBotCamera), false, Pawn);
		if (AActor* Target = PC->GetViewTarget()) Params.AddIgnoredActor(Target);
		const FVector Eye = PC->PlayerCameraManager->GetCameraLocation();
		if (World->OverlapBlockingTestByChannel(Eye, FQuat::Identity, ECC_Camera, FCollisionShape::MakeSphere(CameraRadius), Params))
		{
			if (++CameraFrames >= 3) Raise(EKind::Camera, FString::Printf(TEXT("view point %s is inside blocking geometry"), *Where(Eye)));
		}
		else
		{
			CameraFrames = 0;
			Clear(EKind::Camera);
		}
	}
}

void UGam3WalkBot::Apply(APlayerController* PC, APawn* Pawn, const FVector& WorldDir, bool bJump)
{
	bWantsMove = !WorldDir.IsNearlyZero();
	ACharacter* Character = Cast<ACharacter>(Pawn);
	UEnhancedInputLocalPlayerSubsystem* Input = bEnhanced && PC->GetLocalPlayer() ? ULocalPlayer::GetSubsystem<UEnhancedInputLocalPlayerSubsystem>(PC->GetLocalPlayer()) : nullptr;
	if (bJump) JumpFrames = 3;
	const bool bHoldJump = JumpFrames > 0;
	if (JumpFrames > 0) --JumpFrames;

	if (Input && MoveAction.IsValid())
	{
		// The usual mapping: X is right and Y is forward, relative to where the controller looks. InputYawFix
		// absorbs a game that maps its axes another way (measured from how the pawn actually moves, in Drive).
		const FVector Local = WorldDir.RotateAngleAxis(-(PC->GetControlRotation().Yaw + InputYawFix), FVector::UpVector);
		if (bWantsMove) Input->InjectInputForAction(MoveAction.Get(), FInputActionValue(FVector2D(Local.Y, Local.X)), {}, {});
		if (bHoldJump)
		{
			if (JumpAction.IsValid()) Input->InjectInputForAction(JumpAction.Get(), FInputActionValue(true), {}, {});
			else if (Character) Character->Jump();
		}
		else if (Character && !JumpAction.IsValid()) Character->StopJumping();
		return;
	}
	if (bWantsMove) Pawn->AddMovementInput(WorldDir, 1.f);
	if (Character)
	{
		if (bHoldJump) Character->Jump();
		else Character->StopJumping();
	}
}

void UGam3WalkBot::Drive(APlayerController* PC, APawn* Pawn, float Dt)
{
	const FVector Location = Pawn->GetActorLocation();
	const UPawnMovementComponent* Movement = Pawn->GetMovementComponent();
	const bool bCanJump = Cast<ACharacter>(Pawn) != nullptr;
	FVector Dir = FVector::ZeroVector;
	bool bJump = false;

	if (bWander)
	{
		HoldLeft -= Dt;
		if (HoldLeft <= 0.f)
		{
			bPaused = Rand.FRand() < 0.1f;
			HoldLeft = bPaused ? Rand.FRandRange(0.3f, 1.f) : Rand.FRandRange(0.8f, 3.f);
			if (!bPaused)
			{
				Heading = Rand.FRandRange(0.f, 360.f);
				bJump = bCanJump && Rand.FRand() < 0.15f;
			}
		}
		// A player who walks into a wall turns. Half a second without progress is a bump: pick a way out, and try
		// a jump every second time (a low ledge).
		if (!bPaused)
		{
			BumpTime += Dt;
			if (FVector::Dist2D(Location, BumpAnchor) > 15.f) { BumpAnchor = Location; BumpTime = 0.f; }
			else if (BumpTime > 0.5f)
			{
				Heading = FMath::Fmod(Heading + Rand.FRandRange(110.f, 250.f), 360.f);
				HoldLeft = Rand.FRandRange(0.8f, 2.f);
				BumpTime = 0.f;
				if (bCanJump && (++Bumps % 2) == 0) bJump = true;
			}
			Dir = FRotator(0.f, Heading, 0.f).Vector();
		}
	}
	else if (NextWaypoint < Route.Num())
	{
		FVector To = Route[NextWaypoint] - Location;
		To.Z = 0.0;
		if (To.Size() <= RouteRadius)
		{
			UE_LOG(LogTemp, Display, TEXT("GAM3WALK: note waypoint %d/%d reached t=%.2f"), NextWaypoint + 1, Route.Num(), GameTime);
			++NextWaypoint;
			if (NextWaypoint < Route.Num()) { To = Route[NextWaypoint] - Location; To.Z = 0.0; }
		}
		if (NextWaypoint < Route.Num()) Dir = To.GetSafeNormal();

		// A game may map its move axes to something other than the controller's view. When the pawn runs steadily
		// in a direction other than the one asked for, turn the input by the difference. Routes need this;
		// wandering does not care which way is which.
		const FVector Velocity = Pawn->GetVelocity();
		const float MaxSpeed = Movement ? Movement->GetMaxSpeed() : 0.f;
		// Only a steady state counts: the same direction asked for a second, and the pawn's heading no longer changing
		// (a pawn rounding a corner is still turning, not mis-mapped).
		DirHeldTime = (Dir | LastDir) > 0.996f ? DirHeldTime + Dt : 0.f;
		LastDir = Dir;
		if (bEnhanced && DirHeldTime > 1.f && MaxSpeed > 0.f && Velocity.Size2D() > 0.9f * MaxSpeed)
		{
			const float Off = FMath::FindDeltaAngleDegrees(FMath::RadiansToDegrees(FMath::Atan2(Dir.Y, Dir.X)), FMath::RadiansToDegrees(FMath::Atan2(Velocity.Y, Velocity.X)));
			SteadyTime = FMath::Abs(Off - LastOff) < 2.f ? SteadyTime + Dt : 0.f;
			LastOff = Off;
			if (SteadyTime > 0.3f && FMath::Abs(Off) > 10.f)
			{
				InputYawFix = FMath::UnwindDegrees(InputYawFix + Off);
				SteadyTime = 0.f;
				DirHeldTime = 0.f;
				UE_LOG(LogTemp, Display, TEXT("GAM3WALK: note the move action is turned %.0f degrees from the controller's view; corrected"), InputYawFix);
			}
		}
		else SteadyTime = 0.f;
	}
	Apply(PC, Pawn, Dir, bJump);
}

void UGam3WalkBot::PrintDone()
{
	bDonePrinted = true;
	int32 Other = 0;
	FString Games;
	for (const TPair<FName, int32>& Pair : GameCounts)
	{
		Other += Pair.Value;
		Games += FString::Printf(TEXT(" %s=%d"), *Pair.Key.ToString(), Pair.Value);
	}
	UE_LOG(LogTemp, Display, TEXT("GAM3WALK: done mode=%s seed=%d game_s=%.1f sim_wall_s=%.2f distance_m=%.2f end=%s input=%s route=%d/%d stuck=%d fell=%d slide=%d speed=%d nan=%d camera_inside=%d other=%d%s"),
		bWander ? TEXT("wander") : TEXT("route"), Seed, GameTime, EndWall - BeginWall, Distance / 100.0, *Where(LastLocation), bEnhanced ? TEXT("enhanced") : TEXT("movement"),
		FMath::Min(NextWaypoint, Route.Num()), Route.Num(), Counts[0], Counts[1], Counts[2], Counts[3], Counts[4], Counts[5], Other, *Games);
}

void UGam3WalkBot::Finish(UWorld* World, const TCHAR* Why)
{
	if (bFinished) return;
	bFinished = true;
	FinishedAt = GameTime;
	EndWall = FPlatformTime::Seconds();
	UE_LOG(LogTemp, Display, TEXT("GAM3WALK: note finished: %s"), Why);
}

void UGam3WalkBot::Tick(float DeltaTime)
{
	UWorld* World = GetWorld();
	if (!World || !World->HasBegunPlay() || bQuitSent) return;
	if (const UGam3ReadyGate* Gate = World->GetSubsystem<UGam3ReadyGate>()) { if (!Gate->IsReady()) return; }
	if (!bBegun) Begin(World);

	APlayerController* PC = World->GetFirstPlayerController();
	APawn* Pawn = PC ? PC->GetPawn() : nullptr;

	if (!bFinished)
	{
		GameTime += DeltaTime;
		if (Pawn)
		{
			if (LastPawn.Get() != Pawn)
			{
				// A new pawn (the first, or a respawn): find its input again, and do not call the move a teleport.
				if (bHadPawn) bHaveLast = false;
				LastPawn = Pawn;
				bHadPawn = true;
				StuckAnchor = BumpAnchor = TrapAnchor = Pawn->GetActorLocation();
				FindInput(PC, Pawn);
			}
			NoPawnTime = 0.f;
			Check(World, PC, Pawn, DeltaTime);
			Drive(PC, Pawn, DeltaTime);
			OnBotTickNative.Broadcast(*this, Pawn, DeltaTime);
			OnBotTick.Broadcast(Pawn, DeltaTime);
		}
		else if (bHadPawn)
		{
			// The engine destroys an actor that drops below KillZ. A player with no pawn for this long has lost it.
			NoPawnTime += DeltaTime;
			if (NoPawnTime > 1.f) Raise(EKind::Fell, TEXT("the player's pawn was destroyed and not replaced (below KillZ, or killed)"));
		}

		// Nothing more can be learned from a pawn that is gone, or from a route that cannot be walked.
		if (bActive[int32(EKind::Fell)]) Finish(World, TEXT("the pawn fell"));
		else if (!bWander && bActive[int32(EKind::Stuck)]) Finish(World, TEXT("the route is blocked"));
		else if (!bWander && Route.Num() && NextWaypoint >= Route.Num()) Finish(World, TEXT("the route was walked"));
		else if (Seconds > 0.f && GameTime >= Seconds) Finish(World, TEXT("time is up"));
	}

	// Pictures of incidents, one request at a time: a second request replaces one that has not been written yet.
	++FramesSinceShot;
	const bool bShotPending = FScreenshotRequest::IsScreenshotRequested();
	if (bShotPending) FramesSinceShot = 0;
	if (!bShotPending && ShotQueue.Num() && FramesSinceShot > 2)
	{
		const FString Name = FPaths::ProjectSavedDir() / TEXT("Screenshots") / FString::Printf(TEXT("%s_%02d_%s.png"), *ShotPrefix, ShotIndex++, *ShotQueue[0]);
		ShotQueue.RemoveAt(0);
		FScreenshotRequest::RequestScreenshot(Name, false, false);
		UE_LOG(LogTemp, Display, TEXT("GAM3WALK: note picture %s"), *Name);
		FramesSinceShot = 0;
	}

	if (bFinished && !ShotQueue.Num() && !bShotPending && FramesSinceShot > 8)
	{
		if (!bDonePrinted) PrintDone();
		if (Seconds > 0.f)
		{
			bQuitSent = true;
			UKismetSystemLibrary::QuitGame(World, PC, EQuitPreference::Quit, false);
		}
	}
}
