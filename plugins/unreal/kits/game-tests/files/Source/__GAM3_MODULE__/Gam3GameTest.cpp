#include "Gam3GameTest.h"

#include "Engine/Engine.h"
#include "Engine/GameViewportClient.h"
#include "Engine/LocalPlayer.h"
#include "Engine/World.h"
#include "EnhancedInputComponent.h"
#include "EnhancedInputSubsystems.h"
#include "Framework/Application/IInputProcessor.h"
#include "Framework/Application/SlateApplication.h"
#include "Gam3ReadyGate.h"
#include "GameFramework/Pawn.h"
#include "GameFramework/PlayerController.h"
#include "HAL/PlatformTime.h"
#include "InputAction.h"
#include "InputKeyEventArgs.h"
#include "Kismet/KismetSystemLibrary.h"
#include "Misc/App.h"
#include "Misc/CommandLine.h"
#include "Misc/Parse.h"
#include "Misc/Paths.h"
#include "UnrealClient.h"
#include "UObject/UObjectIterator.h"
#include "Widgets/SViewport.h"
#include "Widgets/SWindow.h"

bool UGam3GameTestRunner::bSending = false;

/** Lets the test's own events through and swallows everyone else's while tests run. */
class FGam3TestInputGuard : public IInputProcessor
{
public:
	virtual void Tick(const float DeltaTime, FSlateApplication& SlateApp, TSharedRef<ICursor> Cursor) override {}
	virtual bool HandleKeyDownEvent(FSlateApplication&, const FKeyEvent&) override { return !UGam3GameTestRunner::bSending; }
	virtual bool HandleKeyUpEvent(FSlateApplication&, const FKeyEvent&) override { return !UGam3GameTestRunner::bSending; }
	virtual bool HandleAnalogInputEvent(FSlateApplication&, const FAnalogInputEvent&) override { return !UGam3GameTestRunner::bSending; }
	virtual bool HandleMouseMoveEvent(FSlateApplication&, const FPointerEvent&) override { return !UGam3GameTestRunner::bSending; }
	virtual bool HandleMouseButtonDownEvent(FSlateApplication&, const FPointerEvent&) override { return !UGam3GameTestRunner::bSending; }
	virtual bool HandleMouseButtonUpEvent(FSlateApplication&, const FPointerEvent&) override { return !UGam3GameTestRunner::bSending; }
	virtual bool HandleMouseButtonDoubleClickEvent(FSlateApplication&, const FPointerEvent&) override { return !UGam3GameTestRunner::bSending; }
	virtual bool HandleMouseWheelOrGestureEvent(FSlateApplication&, const FPointerEvent&, const FPointerEvent*) override { return !UGam3GameTestRunner::bSending; }
	virtual const TCHAR* GetDebugName() const override { return TEXT("Gam3TestInputGuard"); }
};

// ---------------------------------------------------------------------------------------------------------------
// Sending input the way hardware does

/**
 * A run with no renderer has no window and no viewport widget, so Slate has nowhere to route an event. There the
 * event is handed to the game viewport client, which is where Slate would have delivered it: the game's bindings
 * are still under test, its Slate UI is not.
 */
static bool Gam3HasWindow()
{
	// A null renderer still makes a window object, but nothing is laid out in it and events sent to it go nowhere.
	return FApp::CanEverRender() && FSlateApplication::IsInitialized() && GEngine && GEngine->GameViewport && GEngine->GameViewport->GetGameViewportWidget().IsValid()
		&& GEngine->GameViewport->GetWindow().IsValid();
}

static void Gam3SendToClient(const FKey& Key, bool bDown)
{
	UGameViewportClient* Client = GEngine ? GEngine->GameViewport : nullptr;
	if (!Client) return;
	Client->InputKey(FInputKeyEventArgs(Client->Viewport, FInputDeviceId::CreateFromInternalId(0), Key, bDown ? IE_Pressed : IE_Released, FPlatformTime::Cycles64()));
}

static void Gam3SendKey(const FKey& Key, bool bDown)
{
	if (!Gam3HasWindow()) { Gam3SendToClient(Key, bDown); return; }
	const uint32* KeyCode = nullptr;
	const uint32* CharCode = nullptr;
	FInputKeyManager::Get().GetCodesFromKey(Key, KeyCode, CharCode);
	const FKeyEvent Event(Key, FModifierKeysState(), 0, false, CharCode ? *CharCode : 0, KeyCode ? *KeyCode : 0);
	TGuardValue<bool> Sending(UGam3GameTestRunner::bSending, true);
	if (bDown) FSlateApplication::Get().ProcessKeyDownEvent(Event);
	else FSlateApplication::Get().ProcessKeyUpEvent(Event);
}

static void Gam3SendMouse(const FVector2D& Screen, const FVector2D& Last, const TSet<FKey>& Pressed, const FKey& Button, int32 Kind)
{
	if (!Gam3HasWindow())
	{
		if (Kind != 0) Gam3SendToClient(Button, Kind == 1);   // with no window there is no cursor to move
		return;
	}
	const FPointerEvent Event(0u, Screen, Last, Pressed, Button, 0.f, FModifierKeysState());
	TGuardValue<bool> Sending(UGam3GameTestRunner::bSending, true);
	FSlateApplication& Slate = FSlateApplication::Get();
	if (Kind == 0) Slate.ProcessMouseMoveEvent(Event);
	else if (Kind == 1)
	{
		const TSharedPtr<SWindow> Window = GEngine && GEngine->GameViewport ? GEngine->GameViewport->GetWindow() : nullptr;
		Slate.ProcessMouseButtonDownEvent(Window.IsValid() ? Window->GetNativeWindow() : nullptr, Event);
	}
	else Slate.ProcessMouseButtonUpEvent(Event);
}

static void Gam3SendTouch(int32 Finger, ETouchType::Type Type, const FVector2D& Pixels)
{
	UGameViewportClient* Client = GEngine ? GEngine->GameViewport : nullptr;
	if (!Client || !Client->Viewport) return;
	// Device 0 is the default input device (asking the device mapper for it would need the ApplicationCore module).
	const FTouchId Id(FInputDeviceId::CreateFromInternalId(0), ETouchIndex::Type(FMath::Clamp(Finger, 0, int32(ETouchIndex::Touch10))));
	TGuardValue<bool> Sending(UGam3GameTestRunner::bSending, true);
	Client->InputTouch(Client->Viewport, Id, Type, Pixels, 1.f, FPlatformTime::Cycles64());
}

// ---------------------------------------------------------------------------------------------------------------
// The test

UGam3GameTest::FStep& UGam3GameTest::Add(EKind Kind, const TCHAR* Name)
{
	FStep& Step = Steps.AddDefaulted_GetRef();
	Step.Kind = Kind;
	Step.Name = Name;
	return Step;
}

void UGam3GameTest::Step(const TCHAR* Name, TFunction<void()> Do) { Add(EKind::Do, Name).Do = MoveTemp(Do); }
void UGam3GameTest::WaitSeconds(float Seconds) { Add(EKind::Seconds, TEXT("wait")).Seconds = Seconds; }
void UGam3GameTest::WaitFrames(int32 Frames) { Add(EKind::Frames, TEXT("wait")).Frames = Frames; }

void UGam3GameTest::WaitUntil(const TCHAR* Name, TFunction<bool()> Condition, float TimeoutSeconds)
{
	FStep& Step = Add(EKind::Until, Name);
	Step.Condition = MoveTemp(Condition);
	Step.Seconds = TimeoutSeconds;
}

void UGam3GameTest::Check(const TCHAR* Name, TFunction<bool()> Condition, const TCHAR* Why)
{
	FStep& Step = Add(EKind::Check, Name);
	Step.Condition = MoveTemp(Condition);
	Step.Why = Why;
}

void UGam3GameTest::TapKey(FKey Key, float HoldSeconds)
{
	Step(TEXT("key down"), [this, Key] { Hold(Key); });
	WaitSeconds(HoldSeconds);
	Step(TEXT("key up"), [this, Key] { Release(Key); });
}

void UGam3GameTest::Click(FVector2D Where, float HoldSeconds, FKey Button)
{
	Step(TEXT("mouse down"), [this, Where, Button] { MoveMouse(Where); MouseDown(Button); });
	WaitSeconds(HoldSeconds);
	Step(TEXT("mouse up"), [this, Button] { MouseUp(Button); });
}

void UGam3GameTest::TapTouch(FVector2D Where, float HoldSeconds)
{
	Step(TEXT("touch down"), [this, Where] { TouchBegin(0, Where); });
	WaitSeconds(HoldSeconds);
	Step(TEXT("touch up"), [this] { TouchEnd(0); });
}

void UGam3GameTest::Hold(FKey Key)
{
	if (Key.IsMouseButton()) { MouseDown(Key); return; }
	HeldKeys.Add(Key);
	Gam3SendKey(Key, true);
}

void UGam3GameTest::Release(FKey Key)
{
	if (Key.IsMouseButton()) { MouseUp(Key); return; }
	if (HeldKeys.Remove(Key)) Gam3SendKey(Key, false);
}

FVector2D UGam3GameTest::ToScreen(FVector2D Where) const
{
	const TSharedPtr<SViewport> Widget = GEngine && GEngine->GameViewport ? GEngine->GameViewport->GetGameViewportWidget() : nullptr;
	if (!Widget.IsValid()) return Where;
	const FGeometry& Geometry = Widget->GetTickSpaceGeometry();
	return FVector2D(Geometry.LocalToAbsolute(Geometry.GetLocalSize() * FVector2f(Where)));
}

FVector2D UGam3GameTest::ToViewportPixels(FVector2D Where) const
{
	const FViewport* Viewport = GEngine && GEngine->GameViewport ? GEngine->GameViewport->Viewport : nullptr;
	return Viewport ? FVector2D(Viewport->GetSizeXY()) * Where : Where;
}

void UGam3GameTest::MoveMouse(FVector2D Where)
{
	const FVector2D Last = MouseScreen;
	MouseScreen = ToScreen(Where);
	Gam3SendMouse(MouseScreen, Last, HeldButtons, FKey(), 0);
}

void UGam3GameTest::MouseDown(FKey Button)
{
	HeldButtons.Add(Button);
	Gam3SendMouse(MouseScreen, MouseScreen, HeldButtons, Button, 1);
}

void UGam3GameTest::MouseUp(FKey Button)
{
	if (!HeldButtons.Remove(Button)) return;
	Gam3SendMouse(MouseScreen, MouseScreen, HeldButtons, Button, 2);
}

void UGam3GameTest::TouchBegin(int32 Finger, FVector2D Where)
{
	HeldTouches.Add(Finger, Where);
	Gam3SendTouch(Finger, ETouchType::Began, ToViewportPixels(Where));
}

void UGam3GameTest::TouchMove(int32 Finger, FVector2D Where)
{
	if (!HeldTouches.Contains(Finger)) return;
	HeldTouches[Finger] = Where;
	Gam3SendTouch(Finger, ETouchType::Moved, ToViewportPixels(Where));
}

void UGam3GameTest::TouchEnd(int32 Finger)
{
	FVector2D Where;
	if (HeldTouches.RemoveAndCopyValue(Finger, Where)) Gam3SendTouch(Finger, ETouchType::Ended, ToViewportPixels(Where));
}

bool UGam3GameTest::HoldAction(FName ActionName, FVector Value)
{
	if (!Runner.IsValid() || !Runner->FindAction(ActionName)) return false;
	HeldActions.Add(ActionName, Value);
	return true;
}

void UGam3GameTest::ReleaseAction(FName ActionName) { HeldActions.Remove(ActionName); }

void UGam3GameTest::Fail(const TCHAR* Name, const FString& Why) { Report(false, Name, Why); }

void UGam3GameTest::ReleaseEverything()
{
	for (const FKey& Key : HeldKeys.Array()) Release(Key);
	for (const FKey& Button : HeldButtons.Array()) MouseUp(Button);
	TArray<int32> Fingers;
	HeldTouches.GetKeys(Fingers);
	for (const int32 Finger : Fingers) TouchEnd(Finger);
	HeldActions.Reset();
}

void UGam3GameTest::Report(bool bPassed, const FString& Name, const FString& Why)
{
	const FString Label = Name.Replace(TEXT(" "), TEXT("_"));
	if (bPassed)
	{
		++Passed;
		UE_LOG(LogTemp, Display, TEXT("GAM3TEST: PASS %s.%s"), *GetTestName(), *Label);
		return;
	}
	++Failed;
	UE_LOG(LogTemp, Error, TEXT("GAM3TEST: FAIL %s.%s %s"), *GetTestName(), *Label, *Why);
	if (Runner.IsValid() && Runner->bShotOnFail && !FScreenshotRequest::IsScreenshotRequested())
	{
		FString File = FString::Printf(TEXT("test_%s_%s"), *GetTestName(), *Label);
		for (TCHAR& Char : File) if (!FChar::IsAlnum(Char) && Char != TEXT('_') && Char != TEXT('-')) Char = TEXT('_');
		// With the UI: a failing menu test is a picture of the menu.
		FScreenshotRequest::RequestScreenshot(FPaths::ProjectSavedDir() / TEXT("Screenshots") / (File + TEXT(".png")), true, false);
	}
}

UWorld* UGam3GameTest::World() const { return Runner.IsValid() ? Runner->GetWorld() : nullptr; }
APlayerController* UGam3GameTest::PC() const { const UWorld* W = World(); return W ? W->GetFirstPlayerController() : nullptr; }
APawn* UGam3GameTest::Pawn() const { const APlayerController* Controller = PC(); return Controller ? Controller->GetPawn() : nullptr; }

// ---------------------------------------------------------------------------------------------------------------
// The runner

bool UGam3GameTestRunner::DoesSupportWorldType(const EWorldType::Type WorldType) const
{
	return WorldType == EWorldType::Game || WorldType == EWorldType::PIE;
}

bool UGam3GameTestRunner::ShouldCreateSubsystem(UObject* Outer) const
{
#if UE_BUILD_SHIPPING
	return false;
#else
	FString Unused;
	return FParse::Value(FCommandLine::Get(), TEXT("Gam3Test="), Unused, false);
#endif
}

void UGam3GameTestRunner::Initialize(FSubsystemCollectionBase& Collection)
{
	Super::Initialize(Collection);
	FString List;
	FParse::Value(FCommandLine::Get(), TEXT("Gam3Test="), List, false);
	List.ParseIntoArray(Wanted, TEXT(","));
	bAll = Wanted.Num() == 1 && Wanted[0].Equals(TEXT("all"), ESearchCase::IgnoreCase);
	bShotOnFail = FParse::Param(FCommandLine::Get(), TEXT("Gam3TestShotOnFail"));
}

void UGam3GameTestRunner::Deinitialize()
{
	if (Guard.IsValid() && FSlateApplication::IsInitialized()) FSlateApplication::Get().UnregisterInputPreProcessor(Guard);
	Guard.Reset();
	Super::Deinitialize();
}

const UInputAction* UGam3GameTestRunner::FindAction(FName Name) const
{
	const UWorld* World = GetWorld();
	APlayerController* PC = World ? World->GetFirstPlayerController() : nullptr;
	if (!PC) return nullptr;
	for (UInputComponent* Component : { PC->GetPawn() ? ToRawPtr(PC->GetPawn()->InputComponent) : nullptr, ToRawPtr(PC->InputComponent) })
	{
		const UEnhancedInputComponent* Enhanced = Cast<UEnhancedInputComponent>(Component);
		if (!Enhanced) continue;
		for (const TUniquePtr<FEnhancedInputActionEventBinding>& Binding : Enhanced->GetActionEventBindings())
		{
			const UInputAction* Action = Binding ? Binding->GetAction() : nullptr;
			if (Action && Action->GetFName() == Name) return Action;
		}
	}
	return nullptr;
}

void UGam3GameTestRunner::Begin(UWorld* World)
{
	TMap<FString, UClass*> Known;
	for (TObjectIterator<UClass> It; It; ++It)
	{
		if (!It->IsChildOf(UGam3GameTest::StaticClass()) || It->HasAnyClassFlags(CLASS_Abstract | CLASS_NewerVersionExists)) continue;
		Known.Add(It->GetDefaultObject<UGam3GameTest>()->GetTestName().ToLower(), *It);
	}
	if (bAll)
	{
		Known.GetKeys(Wanted);
		Wanted.Sort();
	}
	for (const FString& Name : Wanted)
	{
		UClass* const* Class = Known.Find(Name.ToLower());
		if (!Class)
		{
			++Missing;
			UE_LOG(LogTemp, Error, TEXT("GAM3TEST: FAIL %s.found there is no test class with this name"), *Name);
			continue;
		}
		UGam3GameTest* Test = NewObject<UGam3GameTest>(this, *Class);
		Test->Runner = this;
		Test->Build();
		Tests.Add(Test);
	}
	if (FSlateApplication::IsInitialized())
	{
		// Keys go to whatever has keyboard focus; an unattended window may never have been given it.
		FSlateApplication::Get().SetAllUserFocusToGameViewport();
		Guard = MakeShared<FGam3TestInputGuard>();
		FSlateApplication::Get().RegisterInputPreProcessor(Guard, 0);
	}
	UE_LOG(LogTemp, Display, TEXT("GAM3TEST: note input=%s"), Gam3HasWindow() ? TEXT("slate (keys, mouse and UI go through the window)")
		: TEXT("viewport-client (no window in this run: keys and buttons reach the game, its UI and the mouse position are not exercised)"));
	UE_LOG(LogTemp, Display, TEXT("GAM3TEST: started tests=%d shot_on_fail=%d"), Wanted.Num(), bShotOnFail ? 1 : 0);
}

void UGam3GameTestRunner::Advance(UGam3GameTest* Test, float DeltaTime)
{
	Test->Elapsed += DeltaTime;
	Test->StepElapsed += DeltaTime;
	++Test->StepFrames;
	while (Test->Next < Test->Steps.Num() && !Test->bAborted)
	{
		UGam3GameTest::FStep& Step = Test->Steps[Test->Next];
		switch (Step.Kind)
		{
		case UGam3GameTest::EKind::Do:
			if (Step.Do) Step.Do();
			break;
		case UGam3GameTest::EKind::Seconds:
			if (Test->StepElapsed < Step.Seconds) return;
			break;
		case UGam3GameTest::EKind::Frames:
			if (Test->StepFrames <= Step.Frames) return;
			break;
		case UGam3GameTest::EKind::Until:
			if (Step.Condition && Step.Condition()) Test->Report(true, Step.Name, FString());
			else if (Test->StepElapsed >= Step.Seconds)
			{
				Test->Report(false, Step.Name, FString::Printf(TEXT("did not happen within %.1f s"), Step.Seconds));
				Test->bAborted = true;   // what follows was written for a state the game never reached
			}
			else return;
			break;
		case UGam3GameTest::EKind::Check:
			Test->Report(Step.Condition && Step.Condition(), Step.Name, Step.Why);
			break;
		}
		++Test->Next;
		Test->StepElapsed = 0.f;
		Test->StepFrames = 0;
		if (FScreenshotRequest::IsScreenshotRequested()) return;   // hold this frame for the picture of the failure
	}
}

void UGam3GameTestRunner::Tick(float DeltaTime)
{
	UWorld* World = GetWorld();
	if (!World || !World->HasBegunPlay()) return;
	// A picture is written a few frames after it is asked for: nothing moves on, and the game does not quit, until then.
	if (FScreenshotRequest::IsScreenshotRequested()) { ShotWait = 6; return; }
	if (ShotWait > 0) { --ShotWait; return; }
	if (bDone)
	{
		if (QuitWait >= 0 && --QuitWait < 0) UKismetSystemLibrary::QuitGame(World, World->GetFirstPlayerController(), EQuitPreference::Quit, false);
		return;
	}
	if (!bStarted)
	{
		if (UGam3ReadyGate* Gate = World->GetSubsystem<UGam3ReadyGate>())
		{
			Gate->FadeInSeconds = 0.f;
			if (!Gate->IsReady()) return;
		}
		if (++ReadyFrames <= 2) return;
		bStarted = true;
		Begin(World);
		return;
	}
	if (!Tests.IsValidIndex(Current)) { Finish(World); return; }

	UGam3GameTest* Test = Tests[Current];
	if (Test->HeldActions.Num())
	{
		APlayerController* PC = World->GetFirstPlayerController();
		UEnhancedInputLocalPlayerSubsystem* Input = PC && PC->GetLocalPlayer() ? ULocalPlayer::GetSubsystem<UEnhancedInputLocalPlayerSubsystem>(PC->GetLocalPlayer()) : nullptr;
		for (const TPair<FName, FVector>& Held : Test->HeldActions)
		{
			if (const UInputAction* Action = Input ? FindAction(Held.Key) : nullptr) Input->InjectInputForAction(Action, FInputActionValue(Held.Value), {}, {});
		}
	}
	Advance(Test, DeltaTime);
	if (FScreenshotRequest::IsScreenshotRequested()) return;   // the failing state stays on screen until it is captured
	if (Test->Next >= Test->Steps.Num() || Test->bAborted)
	{
		Test->ReleaseEverything();
		if (Test->Passed + Test->Failed == 0) Test->Report(false, TEXT("no checks"), TEXT("the test finished without checking anything"));
		UE_LOG(LogTemp, Display, TEXT("GAM3TEST: end %s passed=%d failed=%d game_s=%.2f"), *Test->GetTestName(), Test->Passed, Test->Failed, Test->Elapsed);
		++Current;
	}
}

void UGam3GameTestRunner::Finish(UWorld* World)
{
	bDone = true;
	int32 Passed = 0;
	int32 Failed = Missing;
	for (const UGam3GameTest* Test : Tests)
	{
		Passed += Test->Passed;
		Failed += Test->Failed;
	}
	if (Guard.IsValid() && FSlateApplication::IsInitialized()) FSlateApplication::Get().UnregisterInputPreProcessor(Guard);
	Guard.Reset();
	UE_LOG(LogTemp, Display, TEXT("GAM3TEST: SUMMARY passed=%d failed=%d tests=%d"), Passed, Failed, Wanted.Num());
	QuitWait = 2;
}
