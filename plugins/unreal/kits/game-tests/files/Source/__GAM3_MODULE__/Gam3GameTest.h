// Scripted tests that run inside the real game and press the real buttons.
//
// A test is a class. Its Build() lists what happens, top to bottom; the runner plays the list one step at a time
// across frames, so a test reads like the instructions you would give a person:
//
//     UCLASS() class UWalkForwardTest : public UGam3GameTest
//     {
//         GENERATED_BODY()
//         double StartX = 0.0;
//         virtual void Build() override
//         {
//             Step(TEXT("remember where we are"), [this] { StartX = Pawn()->GetActorLocation().X; });
//             Step(TEXT("walk forward"), [this] { Hold(EKeys::W); });
//             WaitSeconds(1.f);
//             Step(TEXT("stop"), [this] { Release(EKeys::W); });
//             Check(TEXT("moved"), [this] { return Pawn()->GetActorLocation().X > StartX + 100.0; }, TEXT("the pawn did not move forward"));
//             WaitUntil(TEXT("stopped"), [this] { return Pawn()->GetVelocity().IsNearlyZero(1.0); }, 3.f);
//         }
//     };
//
// Two kinds of call, and they are not interchangeable:
//   script calls, used directly in Build():   Step, WaitSeconds, WaitFrames, WaitUntil, Check, TapKey, Click, TapTouch
//   action calls, used inside a step's code:  Hold, Release, MoveMouse, MouseDown, MouseUp, TouchBegin, TouchMove,
//                                             TouchEnd, HoldAction, ReleaseAction, Fail
//
// Input goes in where a player's input goes in, so the game's own bindings, focus rules and UI are under test:
//   keys          FSlateApplication::ProcessKeyDownEvent / ProcessKeyUpEvent  (keyboard focus is put on the game first)
//   mouse         FSlateApplication::ProcessMouseMoveEvent / ProcessMouseButtonDownEvent / ProcessMouseButtonUpEvent
//   touch         UGameViewportClient::InputTouch
//   HoldAction    UEnhancedInputLocalPlayerSubsystem::InjectInputForAction, every frame while held. This one skips
//                 the key mapping: use it for analogue values a key cannot give, and keys for everything else.
// Whatever a test still holds when it ends, pass or fail, is released.
//
// While tests run, key and mouse events that do not come from the test are swallowed, so someone bumping the
// keyboard or mouse cannot change a result. One thing is NOT blocked: a real cursor resting over the game window
// still makes UI under it hover. The blind profile has no window and is not affected; for runs with a window keep
// the pointer off it.
//
// Command line (Tools/gam3/ue_test.mjs passes these):
//   -Gam3Test=Name[,Name...] | all     which tests to run, in this order ("all": every test class, by name)
//   -Gam3TestShotOnFail                take a picture when a check fails: Saved/Screenshots/test_<Test>_<check>.png
// A test's name is its class name (UWalkForwardTest is "WalkForwardTest") unless GetTestName says otherwise.
// The runner is never created in Shipping builds, and not at all without -Gam3Test.
//
// Log lines, one per fact (the tool reads only these):
//   GAM3TEST: PASS <test>.<check>
//   GAM3TEST: FAIL <test>.<check> <why>
//   GAM3TEST: SUMMARY passed=<n> failed=<m> tests=<k>        then the game quits
// A test that is not found, and a test that finishes without one check, are failures.
#pragma once

#include "CoreMinimal.h"
#include "InputCoreTypes.h"
#include "Subsystems/WorldSubsystem.h"
#include "Gam3GameTest.generated.h"

class APawn;
class APlayerController;
class IInputProcessor;
class UGam3GameTestRunner;
class UInputAction;

UCLASS(Abstract)
class __GAM3_MODULE_API__ UGam3GameTest : public UObject
{
	GENERATED_BODY()

public:
	/** The name used on the command line and in the log. */
	virtual FString GetTestName() const { return GetClass()->GetName(); }
	/** List the steps. Called once, when the level is ready. */
	virtual void Build() {}

protected:
	// --- script calls: use in Build() ---------------------------------------------------------------------------
	/** Run this code once, then go on to the next step on the same frame. */
	void Step(const TCHAR* Name, TFunction<void()> Do);
	/** Game seconds. Under the fixed time step every run waits exactly the same number of frames. */
	void WaitSeconds(float Seconds);
	void WaitFrames(int32 Frames);
	/** Wait for the condition. Passing is a PASS line; the timeout (game seconds) is a FAIL and ends this test. */
	void WaitUntil(const TCHAR* Name, TFunction<bool()> Condition, float TimeoutSeconds = 5.f);
	/** One named fact. A failed check is logged and the test goes on, so one run reports every broken fact. */
	void Check(const TCHAR* Name, TFunction<bool()> Condition, const TCHAR* Why = TEXT(""));
	/** Key down, hold, key up. */
	void TapKey(FKey Key, float HoldSeconds = 0.1f);
	/** Move the mouse there (0,0 is the top left of the game picture, 1,1 the bottom right), press, hold, release. */
	void Click(FVector2D Where, float HoldSeconds = 0.1f, FKey Button = EKeys::LeftMouseButton);
	/** Finger down there, hold, finger up. */
	void TapTouch(FVector2D Where, float HoldSeconds = 0.1f);

	// --- action calls: use inside a step ------------------------------------------------------------------------
	void Hold(FKey Key);
	void Release(FKey Key);
	void MoveMouse(FVector2D Where);
	void MouseDown(FKey Button = EKeys::LeftMouseButton);
	void MouseUp(FKey Button = EKeys::LeftMouseButton);
	void TouchBegin(int32 Finger, FVector2D Where);
	void TouchMove(int32 Finger, FVector2D Where);
	void TouchEnd(int32 Finger);
	/** Enhanced Input: feed this value to the action with this asset name every frame until ReleaseAction. False when no such action is bound. */
	bool HoldAction(FName ActionName, FVector Value);
	void ReleaseAction(FName ActionName);
	/** Report a failure found inside a step. */
	void Fail(const TCHAR* Name, const FString& Why);

	// --- what a test looks at -----------------------------------------------------------------------------------
	UWorld* World() const;
	APlayerController* PC() const;
	APawn* Pawn() const;
	/** Game seconds since this test started. */
	float GameSeconds() const { return Elapsed; }

private:
	friend class UGam3GameTestRunner;
	enum class EKind : uint8 { Do, Seconds, Frames, Until, Check };
	struct FStep
	{
		EKind Kind = EKind::Do;
		FString Name, Why;
		TFunction<void()> Do;
		TFunction<bool()> Condition;
		float Seconds = 0.f;
		int32 Frames = 0;
	};
	FStep& Add(EKind Kind, const TCHAR* Name);
	void Report(bool bPassed, const FString& Name, const FString& Why);
	FVector2D ToScreen(FVector2D Where) const;
	FVector2D ToViewportPixels(FVector2D Where) const;
	void ReleaseEverything();

	TArray<FStep> Steps;
	TWeakObjectPtr<UGam3GameTestRunner> Runner;
	int32 Next = 0;
	int32 Passed = 0;
	int32 Failed = 0;
	float Elapsed = 0.f;
	float StepElapsed = 0.f;
	int32 StepFrames = 0;
	bool bAborted = false;
	TSet<FKey> HeldKeys;
	TSet<FKey> HeldButtons;
	TMap<int32, FVector2D> HeldTouches;
	TMap<FName, FVector> HeldActions;
	FVector2D MouseScreen = FVector2D::ZeroVector;
};

UCLASS()
class __GAM3_MODULE_API__ UGam3GameTestRunner : public UTickableWorldSubsystem
{
	GENERATED_BODY()

public:
	virtual bool ShouldCreateSubsystem(UObject* Outer) const override;
	virtual void Initialize(FSubsystemCollectionBase& Collection) override;
	virtual void Deinitialize() override;
	virtual void Tick(float DeltaTime) override;
	virtual TStatId GetStatId() const override { RETURN_QUICK_DECLARE_CYCLE_STAT(UGam3GameTestRunner, STATGROUP_Tickables); }
	virtual bool DoesSupportWorldType(const EWorldType::Type WorldType) const override;

	/** True while the test itself is sending an event: the guard lets those through and swallows the rest. */
	static bool bSending;

private:
	friend class UGam3GameTest;
	void Begin(UWorld* World);
	void Advance(UGam3GameTest* Test, float DeltaTime);
	void Finish(UWorld* World);
	const UInputAction* FindAction(FName Name) const;

	TArray<FString> Wanted;
	bool bAll = false;
	bool bShotOnFail = false;
	bool bStarted = false;
	bool bDone = false;
	int32 ReadyFrames = 0;
	int32 Current = 0;
	int32 Missing = 0;
	int32 ShotWait = 0;
	int32 QuitWait = -1;
	FString PendingShot;
	UPROPERTY(Transient)
	TArray<TObjectPtr<UGam3GameTest>> Tests;
	TSharedPtr<IInputProcessor> Guard;
};
