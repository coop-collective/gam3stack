#include "Gam3Perf.h"

#include "Animation/SkeletalMeshActor.h"
#include "AssetCompilingManager.h"
#include "Camera/CameraActor.h"
#include "Camera/CameraComponent.h"
#include "Components/SkeletalMeshComponent.h"
#include "Components/StaticMeshComponent.h"
#include "Dom/JsonObject.h"
#include "DynamicRHI.h"
#include "Engine/Blueprint.h"
#include "Engine/DirectionalLight.h"
#include "Engine/Engine.h"
#include "Engine/GameViewportClient.h"
#include "Engine/SkeletalMesh.h"
#include "Engine/StaticMesh.h"
#include "Engine/StaticMeshActor.h"
#include "Engine/World.h"
#include "EngineUtils.h"
#include "Gam3ReadyGate.h"
#include "GameFramework/PlayerController.h"
#include "HAL/PlatformTime.h"
#include "Kismet/KismetSystemLibrary.h"
#include "Materials/MaterialInterface.h"
#include "Misc/CommandLine.h"
#include "Misc/FileHelper.h"
#include "Misc/Parse.h"
#include "Misc/Paths.h"
#include "NiagaraActor.h"
#include "NiagaraComponent.h"
#include "NiagaraSystem.h"
#include "RenderTimer.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "UnrealClient.h"

// ---------------------------------------------------------------------------------------------------------------
// Subjects

UObject* FGam3Subject::Load(const FString& Path)
{
	UObject* Asset = StaticLoadObject(UObject::StaticClass(), nullptr, *Path, nullptr, LOAD_NoWarn);
	if (UBlueprint* Blueprint = Cast<UBlueprint>(Asset)) Asset = Blueprint->GeneratedClass;
#if WITH_EDITOR
	// An uncooked run compiles an effect's scripts the first time it is asked for. A packaged game never does.
	if (UNiagaraSystem* System = Cast<UNiagaraSystem>(Asset)) System->WaitForCompilationComplete(true, false);
#endif
	return Asset;
}

AActor* FGam3Subject::Spawn(UWorld* World, UObject* Asset, const FTransform& At)
{
	if (!World || !Asset) return nullptr;
	FActorSpawnParameters Params;
	Params.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;
	if (UNiagaraSystem* System = Cast<UNiagaraSystem>(Asset))
	{
		ANiagaraActor* Actor = World->SpawnActor<ANiagaraActor>(ANiagaraActor::StaticClass(), At, Params);
		if (Actor && Actor->GetNiagaraComponent())
		{
			Actor->SetDestroyOnSystemFinish(false);
			Actor->GetNiagaraComponent()->SetAsset(System);
			Actor->GetNiagaraComponent()->Activate(true);
		}
		return Actor;
	}
	if (UClass* Class = Cast<UClass>(Asset))
	{
		return Class->IsChildOf(AActor::StaticClass()) ? World->SpawnActor<AActor>(Class, At, Params) : nullptr;
	}
	if (USkeletalMesh* Skeletal = Cast<USkeletalMesh>(Asset))
	{
		ASkeletalMeshActor* Actor = World->SpawnActor<ASkeletalMeshActor>(ASkeletalMeshActor::StaticClass(), At, Params);
		if (Actor && Actor->GetSkeletalMeshComponent()) Actor->GetSkeletalMeshComponent()->SetSkeletalMeshAsset(Skeletal);
		return Actor;
	}
	UStaticMesh* Mesh = Cast<UStaticMesh>(Asset);
	UMaterialInterface* Material = Cast<UMaterialInterface>(Asset);
	if (Material) Mesh = LoadObject<UStaticMesh>(nullptr, TEXT("/Engine/BasicShapes/Sphere.Sphere"));
	if (Mesh)
	{
		AStaticMeshActor* Actor = World->SpawnActor<AStaticMeshActor>(AStaticMeshActor::StaticClass(), At, Params);
		if (Actor && Actor->GetStaticMeshComponent())
		{
			Actor->GetStaticMeshComponent()->SetMobility(EComponentMobility::Movable);
			Actor->GetStaticMeshComponent()->SetCollisionEnabled(ECollisionEnabled::NoCollision);
			Actor->GetStaticMeshComponent()->SetStaticMesh(Mesh);
			if (Material) Actor->GetStaticMeshComponent()->SetMaterial(0, Material);
		}
		return Actor;
	}
	return nullptr;   // sounds, data assets: loading them is all there is to warm
}

static bool Gam3ViewPoint(UWorld* World, FVector& Location, FRotator& Rotation)
{
	if (APlayerController* PC = World->GetFirstPlayerController())
	{
		PC->GetPlayerViewPoint(Location, Rotation);
		return true;
	}
	return false;
}

// ---------------------------------------------------------------------------------------------------------------
// Prewarm

bool UGam3Prewarm::DoesSupportWorldType(const EWorldType::Type WorldType) const
{
	return WorldType == EWorldType::Game || WorldType == EWorldType::PIE;
}

void UGam3Prewarm::Warm(const UObject* WorldContextObject, const TArray<FSoftObjectPath>& More)
{
	UWorld* World = GEngine ? GEngine->GetWorldFromContextObject(WorldContextObject, EGetWorldErrorMode::ReturnNull) : nullptr;
	UGam3Prewarm* Self = World ? World->GetSubsystem<UGam3Prewarm>() : nullptr;
	if (!Self || !More.Num()) return;
	Self->Queue.Append(More);
	if (!Self->bBusy) Self->Begin(World);
}

void UGam3Prewarm::OnWorldBeginPlay(UWorld& InWorld)
{
	Super::OnWorldBeginPlay(InWorld);
	if (Assets.Num())
	{
		Queue.Append(Assets);
		if (!bBusy) Begin(&InWorld);
	}
}

void UGam3Prewarm::Begin(UWorld* World)
{
	bBusy = true;
	bSpawned = false;
	Drawn = 0;
	StartWall = FPlatformTime::Seconds();
	UGam3ReadyGate* Gate = World->GetSubsystem<UGam3ReadyGate>();
	if (Gate && !Gate->IsReady())
	{
		Gate->AddBlocker(TEXT("prewarm"));
		bBlocking = true;
	}
	else
	{
		// Still worth doing, but the player is already looking: say so, because it should have been asked for earlier.
		UE_LOG(LogTemp, Warning, TEXT("GAM3WARM: started after the level was shown (or with no ready gate); the assets are drawn in view"));
	}
}

void UGam3Prewarm::Tick(float DeltaTime)
{
	if (!bBusy) return;
	UWorld* World = GetWorld();
	if (!World) return;
	const double Waited = FPlatformTime::Seconds() - StartWall;

	if (!bSpawned)
	{
		// In front of the player's camera, so each asset is really drawn: that is what creates its pipeline state.
		FVector Location;
		FRotator Rotation;
		if (!Gam3ViewPoint(World, Location, Rotation) && Waited < 5.0) return;
		const FVector Forward = Rotation.Vector();
		const FVector Right = FRotationMatrix(Rotation).GetScaledAxis(EAxis::Y);
		const int32 Count = Queue.Num();
		for (int32 i = 0; i < Count; ++i)
		{
			const FString Path = Queue[i].ToString();
			UObject* Asset = FGam3Subject::Load(Path);
			if (!Asset)
			{
				UE_LOG(LogTemp, Warning, TEXT("GAM3WARM: missing %s"), *Path);
				continue;
			}
			Keep.AddUnique(Asset);
			++Warmed;
			const float Side = (i - (Count - 1) * 0.5f) * 120.f;
			if (AActor* Actor = FGam3Subject::Spawn(World, Asset, FTransform(Rotation, Location + Forward * 900.f + Right * Side)))
			{
				Actor->SetActorEnableCollision(false);
				Shown.Add(Actor);
			}
		}
		Queue.Reset();
		bSpawned = true;
		return;
	}

	const bool bCompiling = FAssetCompilingManager::Get().GetNumRemainingAssets() > 0;
	if (!bCompiling) ++Drawn;
	if (Waited > TimeoutSeconds) Finish(World, true);
	else if (Drawn >= DrawFrames) Finish(World, false);
}

void UGam3Prewarm::Finish(UWorld* World, bool bTimedOut)
{
	for (AActor* Actor : Shown) if (IsValid(Actor)) Actor->Destroy();
	Shown.Reset();
	const double Seconds = FPlatformTime::Seconds() - StartWall;
	if (bTimedOut)
	{
		UE_LOG(LogTemp, Warning, TEXT("GAM3WARM: TIMEOUT after %.1fs, something was still compiling; assets=%d"), Seconds, Warmed);
	}
	else
	{
		UE_LOG(LogTemp, Display, TEXT("GAM3WARM: ok assets=%d seconds=%.2f"), Warmed, Seconds);
	}
	if (bBlocking)
	{
		if (UGam3ReadyGate* Gate = World->GetSubsystem<UGam3ReadyGate>()) Gate->RemoveBlocker(TEXT("prewarm"));
		bBlocking = false;
	}
	bBusy = false;
	if (Queue.Num()) Begin(World);   // more arrived while these were being drawn
}

// ---------------------------------------------------------------------------------------------------------------
// Probe

bool UGam3PerfProbe::DoesSupportWorldType(const EWorldType::Type WorldType) const
{
	return WorldType == EWorldType::Game || WorldType == EWorldType::PIE;
}

bool UGam3PerfProbe::ShouldCreateSubsystem(UObject* Outer) const
{
#if UE_BUILD_SHIPPING
	return false;
#else
	FString Unused;
	return FParse::Value(FCommandLine::Get(), TEXT("Gam3Perf="), Unused, false);
#endif
}

void UGam3PerfProbe::Initialize(FSubsystemCollectionBase& Collection)
{
	Super::Initialize(Collection);
	Collection.InitializeDependency<UGam3Prewarm>();
	const TCHAR* Cmd = FCommandLine::Get();
	FParse::Value(Cmd, TEXT("Gam3Perf="), Scenario);
	FParse::Value(Cmd, TEXT("Gam3PerfData="), DataFile, false);
	if (!DataFile.IsEmpty() && FPaths::IsRelative(DataFile)) DataFile = FPaths::ProjectDir() / DataFile;
	FParse::Value(Cmd, TEXT("Gam3PerfName="), Name);
	FParse::Value(Cmd, TEXT("Gam3PerfSeconds="), PlaySeconds);
	FParse::Value(Cmd, TEXT("Gam3PerfHitchMs="), HitchMs);
	bPrewarm = FParse::Param(Cmd, TEXT("Gam3PerfPrewarm"));
	LoadData();
}

static bool Gam3Numbers(const TSharedPtr<FJsonObject>& Object, const TCHAR* Field, TArray<double>& Out)
{
	const TArray<TSharedPtr<FJsonValue>>* Values = nullptr;
	if (!Object.IsValid() || !Object->TryGetArrayField(Field, Values)) return false;
	Out.Reset();
	for (const TSharedPtr<FJsonValue>& Value : *Values) Out.Add(Value->AsNumber());
	return true;
}

void UGam3PerfProbe::LoadData()
{
	if (DataFile.IsEmpty()) return;
	FString Text;
	TSharedPtr<FJsonObject> Root;
	if (!FFileHelper::LoadFileToString(Text, *DataFile) || !FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Text), Root) || !Root.IsValid())
	{
		UE_LOG(LogTemp, Error, TEXT("GAM3PERF: cannot read %s"), *DataFile);
		return;
	}
	TArray<double> Numbers;
	const TSharedPtr<FJsonObject>* Room = nullptr;
	if (Root->TryGetObjectField(TEXT("room"), Room))
	{
		if (Gam3Numbers(*Room, TEXT("camera"), Numbers) && Numbers.Num() >= 5)
		{
			RoomCamLocation = FVector(Numbers[0], Numbers[1], Numbers[2]);
			RoomCamRotation = FRotator(Numbers[3], Numbers[4], 0.0);
			if (Numbers.Num() >= 6) CamFOV = Numbers[5];
		}
		double Value = 0.0;
		if ((*Room)->TryGetNumberField(TEXT("distance"), Value)) RoomDistance = Value;
		double DefaultHold = 3.0;
		(*Room)->TryGetNumberField(TEXT("hold"), DefaultHold);
		const TArray<TSharedPtr<FJsonValue>>* List = nullptr;
		if ((*Room)->TryGetArrayField(TEXT("subjects"), List))
		{
			for (const TSharedPtr<FJsonValue>& Item : *List)
			{
				FRoomSubject Subject;
				Subject.Hold = DefaultHold;
				const TSharedPtr<FJsonObject>* Object = nullptr;
				if (Item->TryGetObject(Object))
				{
					(*Object)->TryGetStringField(TEXT("asset"), Subject.Path);
					(*Object)->TryGetStringField(TEXT("label"), Subject.Label);
					if ((*Object)->TryGetNumberField(TEXT("hold"), Value)) Subject.Hold = Value;
				}
				else Subject.Path = Item->AsString();
				if (Subject.Path.IsEmpty()) continue;
				if (Subject.Label.IsEmpty()) Subject.Label = FPaths::GetBaseFilename(Subject.Path);
				Subject.Hold = FMath::Max(Subject.Hold, 1.5f);
				Subjects.Add(MoveTemp(Subject));
			}
		}
	}
	const TSharedPtr<FJsonObject>* Flyby = nullptr;
	if (Root->TryGetObjectField(TEXT("flyby"), Flyby))
	{
		double DefaultSeconds = 3.0;
		(*Flyby)->TryGetNumberField(TEXT("seconds"), DefaultSeconds);
		const TArray<TSharedPtr<FJsonValue>>* List = nullptr;
		if ((*Flyby)->TryGetArrayField(TEXT("points"), List))
		{
			for (const TSharedPtr<FJsonValue>& Item : *List)
			{
				const TArray<TSharedPtr<FJsonValue>>* Values = nullptr;
				if (!Item->TryGetArray(Values) || Values->Num() < 5) continue;
				FPoint Point;
				Point.Location = FVector((*Values)[0]->AsNumber(), (*Values)[1]->AsNumber(), (*Values)[2]->AsNumber());
				Point.Rotation = FRotator((*Values)[3]->AsNumber(), (*Values)[4]->AsNumber(), 0.0);
				Point.Seconds = Values->Num() >= 6 ? (*Values)[5]->AsNumber() : DefaultSeconds;
				Points.Add(Point);
			}
		}
	}
}

void UGam3PerfProbe::OnWorldBeginPlay(UWorld& InWorld)
{
	Super::OnWorldBeginPlay(InWorld);
	if (Scenario == TEXT("room") && bPrewarm && Subjects.Num())
	{
		TArray<FSoftObjectPath> Paths;
		for (const FRoomSubject& Subject : Subjects) Paths.Add(FSoftObjectPath(Subject.Path));
		UGam3Prewarm::Warm(&InWorld, Paths);
	}
}

void UGam3PerfProbe::Mark(const UObject* WorldContextObject, FName Label)
{
	const UWorld* World = GEngine ? GEngine->GetWorldFromContextObject(WorldContextObject, EGetWorldErrorMode::ReturnNull) : nullptr;
	UGam3PerfProbe* Self = World ? World->GetSubsystem<UGam3PerfProbe>() : nullptr;
	if (Self) Self->SetLabel(Label.ToString());
}

void UGam3PerfProbe::SetLabel(const FString& Label)
{
	Current = Segments.IndexOfByPredicate([&Label](const FSegment& Segment) { return Segment.Label == Label; });
	if (Current == INDEX_NONE)
	{
		Current = Segments.AddDefaulted();
		Segments[Current].Label = Label;
	}
}

void UGam3PerfProbe::HoldCamera(UWorld* World, const FVector& Location, const FRotator& Rotation)
{
	APlayerController* PC = World->GetFirstPlayerController();
	if (!PC) return;
	if (!Camera.IsValid())
	{
		ACameraActor* NewCamera = World->SpawnActor<ACameraActor>(Location, Rotation);
		if (!NewCamera) return;
		if (UCameraComponent* Lens = NewCamera->GetCameraComponent())
		{
			Lens->bConstrainAspectRatio = false;
			if (CamFOV > 0.f) Lens->SetFieldOfView(CamFOV);
		}
		Camera = NewCamera;
	}
	Camera->SetActorLocationAndRotation(Location, Rotation);
	if (PC->GetViewTarget() != Camera.Get()) PC->SetViewTarget(Camera.Get());
}

void UGam3PerfProbe::Tick(float DeltaTime)
{
	UWorld* World = GetWorld();
	if (bDone || !World || !World->HasBegunPlay()) return;
	const double Now = FPlatformTime::Seconds();

	if (Scenario == TEXT("room")) HoldCamera(World, RoomCamLocation, RoomCamRotation);
	else if (Scenario == TEXT("flyby") && Points.Num() && !bStarted) HoldCamera(World, Points[0].Location, Points[0].Rotation);

	if (!bStarted)
	{
		if (UGam3ReadyGate* Gate = World->GetSubsystem<UGam3ReadyGate>())
		{
			Gate->FadeInSeconds = 0.f;
			if (!Gate->IsReady()) return;
		}
		if (++ReadyFrames <= 2) return;   // the cover comes off on the camera's next update
		bStarted = true;
		StartWall = LastWall = RoomSince = LegSince = Now;
		if (Scenario == TEXT("room"))
		{
			// An empty level has no light, and an unlit subject costs less than it will in the game.
			if (!TActorIterator<ADirectionalLight>(World))
			{
				World->SpawnActor<ADirectionalLight>(FVector::ZeroVector, FRotator(-45.0, 30.0, 0.0));
			}
			SetLabel(TEXT("empty"));
		}
		else if (Scenario == TEXT("flyby")) SetLabel(TEXT("leg 1"));
		else SetLabel(TEXT("play"));
		UE_LOG(LogTemp, Display, TEXT("GAM3PERF: started scenario=%s subjects=%d points=%d"), *Scenario, Subjects.Num(), Points.Num());
		return;
	}

	// This frame's delta is the cost of the frame that just ended, including whatever was spawned during it.
	const float Ms = (Now - LastWall) * 1000.0;
	LastWall = Now;
	if (Segments.IsValidIndex(Current))
	{
		FSegment& Segment = Segments[Current];
		Segment.Frame.Add(Ms);
		Segment.Game.Add(FPlatformTime::ToMilliseconds(GGameThreadTime));
		Segment.Render.Add(FPlatformTime::ToMilliseconds(GRenderThreadTime));
		Segment.Gpu.Add(FPlatformTime::ToMilliseconds(RHIGetGPUFrameCycles()));
		if (Ms > HitchMs && Hitches.Num() < 200)
		{
			FHitch Hitch;
			Hitch.At = Now - StartWall;
			Hitch.Ms = Ms;
			Hitch.Label = Segment.Label;
			FRotator Unused;
			Gam3ViewPoint(World, Hitch.Where, Unused);
			Hitches.Add(Hitch);
		}
	}

	if (Scenario == TEXT("room")) TickRoom(World, Ms, Now);
	else if (Scenario == TEXT("flyby")) TickFlyby(World, Now);
	else if (Now - StartWall >= PlaySeconds) Finish(World);
}

void UGam3PerfProbe::TickRoom(UWorld* World, float Ms, double Now)
{
	++RoomFrames;
	const FTransform At(FRotator::ZeroRotator, RoomCamLocation + RoomCamRotation.Vector() * RoomDistance);
	const auto Enter = [this, Now](ERoom State) { RoomState = State; RoomFrames = 0; RoomSince = Now; };
	const auto Remove = [this]() { if (IsValid(RoomActor)) RoomActor->Destroy(); RoomActor = nullptr; };

	if (RoomState == ERoom::Empty)
	{
		if (Now - RoomSince < 1.0) return;
		if (!Subjects.Num()) { Finish(World); return; }
		Enter(ERoom::GapB);   // falls through to the first subject on the next frames
		RoomIndex = -1;
		return;
	}
	if (RoomState == ERoom::GapB)
	{
		if (RoomFrames < 10) return;
		if (++RoomIndex >= Subjects.Num()) { Finish(World); return; }
		FRoomSubject& Subject = Subjects[RoomIndex];
		SetLabel(Subject.Label);
		const double T0 = FPlatformTime::Seconds();
		RoomAsset = FGam3Subject::Load(Subject.Path);
		Subject.LoadMs = (FPlatformTime::Seconds() - T0) * 1000.0;
		Subject.bMissing = RoomAsset == nullptr;
		if (Subject.bMissing)
		{
			UE_LOG(LogTemp, Warning, TEXT("GAM3PERF: missing subject %s"), *Subject.Path);
			Enter(ERoom::GapB);
			return;
		}
		RoomActor = FGam3Subject::Spawn(World, RoomAsset, At);
		Enter(ERoom::Cold);
		return;
	}
	FRoomSubject& Subject = Subjects[RoomIndex];
	if (RoomState == ERoom::Cold)
	{
		// The first frame carries the load as well as the first draw; the load is reported on its own.
		Subject.Cold.Add(Subject.Cold.Num() ? Ms : FMath::Max(0.f, Ms - Subject.LoadMs));
		if (FAssetCompilingManager::Get().GetNumRemainingAssets() > 0) Subject.bLateCompile = true;
		if (Now - RoomSince >= Subject.Hold) { Remove(); Enter(ERoom::GapA); }
	}
	else if (RoomState == ERoom::GapA)
	{
		if (RoomFrames < 20) return;
		RoomActor = FGam3Subject::Spawn(World, RoomAsset, At);
		Enter(ERoom::Warm);
	}
	else if (RoomState == ERoom::Warm)
	{
		Subject.Warm.Add(Ms);
		if (Now - RoomSince >= 1.5) { Remove(); RoomAsset = nullptr; SetLabel(TEXT("empty")); Enter(ERoom::GapB); }
	}
}

void UGam3PerfProbe::TickFlyby(UWorld* World, double Now)
{
	if (Points.Num() < 2) { Finish(World); return; }
	const FPoint& From = Points[Leg];
	const FPoint& To = Points[Leg + 1];
	const float Alpha = FMath::Clamp((Now - LegSince) / FMath::Max(0.1, double(To.Seconds)), 0.0, 1.0);
	HoldCamera(World, FMath::Lerp(From.Location, To.Location, Alpha), FQuat::Slerp(From.Rotation.Quaternion(), To.Rotation.Quaternion(), Alpha).Rotator());
	if (Alpha < 1.f) return;
	if (++Leg >= Points.Num() - 1) { Finish(World); return; }
	LegSince = Now;
	SetLabel(FString::Printf(TEXT("leg %d"), Leg + 1));
}

static float Gam3Average(const TArray<float>& Values)
{
	double Sum = 0.0;
	for (const float Value : Values) Sum += Value;
	return Values.Num() ? Sum / Values.Num() : 0.f;
}

/** The value at a fraction of the sorted list: 0.5 is the median, 1 the worst. */
static float Gam3Rank(TArray<float> Values, float Fraction)
{
	if (!Values.Num()) return 0.f;
	Values.Sort();
	return Values[FMath::Clamp(FMath::CeilToInt32(Fraction * Values.Num()) - 1, 0, Values.Num() - 1)];
}

/** The worst frame in the first second of a spawn: where a first-use cost lands. */
static float Gam3FirstSecond(const TArray<float>& Values)
{
	float Worst = 0.f;
	float Elapsed = 0.f;
	for (const float Value : Values)
	{
		Worst = FMath::Max(Worst, Value);
		Elapsed += Value;
		if (Elapsed >= 1000.f) break;
	}
	return Worst;
}

void UGam3PerfProbe::Finish(UWorld* World)
{
	bDone = true;
	const TSharedRef<FJsonObject> Root = MakeShared<FJsonObject>();
	Root->SetStringField(TEXT("name"), Name);
	Root->SetStringField(TEXT("scenario"), Scenario);
	Root->SetStringField(TEXT("map"), World->GetOutermost()->GetName());
	Root->SetNumberField(TEXT("seconds"), FPlatformTime::Seconds() - StartWall);
	if (GEngine && GEngine->GameViewport && GEngine->GameViewport->Viewport)
	{
		const FIntPoint Size = GEngine->GameViewport->Viewport->GetSizeXY();
		Root->SetStringField(TEXT("resolution"), FString::Printf(TEXT("%dx%d"), Size.X, Size.Y));
	}

	TArray<TSharedPtr<FJsonValue>> SegmentList;
	for (const FSegment& Segment : Segments)
	{
		if (!Segment.Frame.Num()) continue;
		const TSharedRef<FJsonObject> Object = MakeShared<FJsonObject>();
		Object->SetStringField(TEXT("label"), Segment.Label);
		Object->SetNumberField(TEXT("frames"), Segment.Frame.Num());
		Object->SetNumberField(TEXT("avg_ms"), Gam3Average(Segment.Frame));
		Object->SetNumberField(TEXT("p50_ms"), Gam3Rank(Segment.Frame, 0.5f));
		Object->SetNumberField(TEXT("p99_ms"), Gam3Rank(Segment.Frame, 0.99f));
		Object->SetNumberField(TEXT("max_ms"), Gam3Rank(Segment.Frame, 1.f));
		Object->SetNumberField(TEXT("game_ms"), Gam3Average(Segment.Game));
		Object->SetNumberField(TEXT("render_ms"), Gam3Average(Segment.Render));
		Object->SetNumberField(TEXT("gpu_ms"), Gam3Average(Segment.Gpu));
		SegmentList.Add(MakeShared<FJsonValueObject>(Object));
	}
	Root->SetArrayField(TEXT("segments"), SegmentList);

	TArray<TSharedPtr<FJsonValue>> SubjectList;
	for (const FRoomSubject& Subject : Subjects)
	{
		const TSharedRef<FJsonObject> Object = MakeShared<FJsonObject>();
		Object->SetStringField(TEXT("label"), Subject.Label);
		Object->SetStringField(TEXT("asset"), Subject.Path);
		Object->SetBoolField(TEXT("missing"), Subject.bMissing);
		Object->SetBoolField(TEXT("late_compile"), Subject.bLateCompile);
		Object->SetNumberField(TEXT("load_ms"), Subject.LoadMs);
		Object->SetNumberField(TEXT("first_use_ms"), Gam3FirstSecond(Subject.Cold));
		Object->SetNumberField(TEXT("warm_ms"), Gam3FirstSecond(Subject.Warm));
		Object->SetNumberField(TEXT("steady_ms"), Gam3Rank(Subject.Cold, 0.5f));
		SubjectList.Add(MakeShared<FJsonValueObject>(Object));
	}
	Root->SetArrayField(TEXT("subjects"), SubjectList);

	TArray<TSharedPtr<FJsonValue>> HitchList;
	for (const FHitch& Hitch : Hitches)
	{
		const TSharedRef<FJsonObject> Object = MakeShared<FJsonObject>();
		Object->SetNumberField(TEXT("at_s"), Hitch.At);
		Object->SetNumberField(TEXT("ms"), Hitch.Ms);
		Object->SetStringField(TEXT("label"), Hitch.Label);
		Object->SetStringField(TEXT("where"), FString::Printf(TEXT("%.0f,%.0f,%.0f"), Hitch.Where.X, Hitch.Where.Y, Hitch.Where.Z));
		HitchList.Add(MakeShared<FJsonValueObject>(Object));
	}
	Root->SetArrayField(TEXT("hitches"), HitchList);

	FString Text;
	FJsonSerializer::Serialize(Root, TJsonWriterFactory<>::Create(&Text));
	const FString File = FPaths::ConvertRelativePathToFull(FPaths::ProjectSavedDir() / TEXT("gam3-perf") / (Name + TEXT(".json")));
	const bool bSaved = FFileHelper::SaveStringToFile(Text, *File);
	UE_LOG(LogTemp, Display, TEXT("GAM3PERF: %s file=%s"), bSaved ? TEXT("done") : TEXT("WRITE FAILED"), *File);
	UKismetSystemLibrary::QuitGame(World, World->GetFirstPlayerController(), EQuitPreference::Quit, false);
}
