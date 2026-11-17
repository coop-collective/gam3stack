// Play-mode tests for the ready gate and the posed spawn. Run them with:
//   node Tools/gam3/unity_run.mjs test --platform PlayMode --filter Gam3.Tests
// They measure what a frame would draw: a probe that runs after every other LateUpdate reads the bone on the same
// frame the object became visible. The spawn tests first prove the fault exists (a plain Instantiate in LateUpdate is
// in bind pose on its first frame), then that Spawn.Posed removes it.
using System;
using System.Collections;
using System.IO;
using System.Text.RegularExpressions;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

namespace Gam3.Tests
{
    public class ReadyGateTests
    {
        ReadyGate gate;

        [TearDown]
        public void TearDown()
        {
            if (gate != null) UnityEngine.Object.Destroy(gate.gameObject);
        }

        [UnityTest]
        public IEnumerator Gate_KeepsTheCoverUpUntilAHoldIsReleased()
        {
            LogAssert.Expect(LogType.Log, new Regex("^GAM3READY: ok frames=\\d+ waited=[0-9.]+s$"));
            var cover = new GameObject("Cover");
            gate = ReadyGate.Begin(cover);
            int opened = 0;
            gate.Ready += () => opened++;
            IDisposable hold = gate.Hold("player");
            for (int i = 0; i < 10; i++) yield return null;
            Assert.IsFalse(gate.IsReady, "the gate opened while a hold was still out");
            Assert.IsTrue(cover.activeSelf, "the cover was hidden while the gate was closed");

            hold.Dispose();
            for (int i = 0; i < 120 && !gate.IsReady; i++) yield return null;
            Assert.IsTrue(gate.IsReady);
            Assert.IsFalse(gate.TimedOut);
            Assert.IsFalse(cover.activeSelf, "the cover is still up after the gate opened");
            Assert.AreEqual(1, opened, "Ready must be raised exactly once");
            UnityEngine.Object.Destroy(cover);
        }

        [UnityTest]
        public IEnumerator Gate_WaitsForConditionsAndAsyncOperations_ThenForSettledFrames()
        {
            gate = ReadyGate.Begin();
            gate.settledFrames = 5;
            bool terrain = false;
            gate.AddCondition("terrain", () => terrain);
            AsyncOperation op = Resources.UnloadUnusedAssets();
            gate.Track("unload", op);
            for (int i = 0; i < 5; i++) yield return null;
            Assert.IsFalse(gate.IsReady);
            int before = gate.FramesWaited;
            terrain = true;
            yield return gate.WaitUntilReady();
            Assert.IsTrue(op.isDone, "the gate opened before a tracked operation finished");
            Assert.IsFalse(gate.TimedOut);
            Assert.GreaterOrEqual(gate.FramesWaited - before, 5, "it must wait for the settled frames after the last condition");
        }

        [UnityTest]
        public IEnumerator Gate_OpensAfterTheTimeout_AndNamesWhatItWaitedFor()
        {
            LogAssert.Expect(LogType.Error, new Regex("^GAM3READY: TIMEOUT waiting=never,slow "));
            gate = ReadyGate.Begin();
            gate.timeoutSeconds = 0.3f;
            gate.Hold("never");
            gate.AddCondition("slow", () => false);
            float t0 = Time.realtimeSinceStartup;
            while (!gate.IsReady && Time.realtimeSinceStartup - t0 < 10f) yield return null;
            Assert.IsTrue(gate.IsReady, "a gate must open after its timeout");
            Assert.IsTrue(gate.TimedOut);
            Assert.AreEqual("never,slow", gate.TimeoutReason);
        }

        [UnityTest]
        public IEnumerator FirstFrames_WritesOnePictureForEachFrameAfterTheGateOpens()
        {
            if (SystemInfo.graphicsDeviceType == UnityEngine.Rendering.GraphicsDeviceType.Null) Assert.Ignore("no graphics device (blind profile)");
            var camGo = new GameObject("Cam");
            Camera cam = camGo.AddComponent<Camera>();
            cam.clearFlags = CameraClearFlags.SolidColor;
            cam.backgroundColor = new Color(0.2f, 0.4f, 0.8f);
            string dir = Path.Combine(Application.temporaryCachePath, "gam3-first-" + Guid.NewGuid().ToString("N"));
            gate = ReadyGate.Begin();
            FirstFrames.AfterGate(gate, cam, 3, Path.Combine(dir, "first"), 64, 36);
            yield return gate.WaitUntilReady();
            for (int i = 0; i < 6; i++) yield return null;
            for (int i = 0; i < 3; i++)
            {
                string file = Path.Combine(dir, "first_0" + i + ".png");
                Assert.IsTrue(File.Exists(file), "missing " + file);
                var tex = new Texture2D(2, 2);
                Assert.IsTrue(tex.LoadImage(File.ReadAllBytes(file)));
                Assert.AreEqual(64, tex.width);
                Assert.Greater(tex.GetPixel(10, 10).b, 0.5f, "the picture is not the camera's view");
                UnityEngine.Object.Destroy(tex);
            }
            Assert.IsFalse(File.Exists(Path.Combine(dir, "first_03.png")), "it captured more frames than asked");
            Directory.Delete(dir, true);
            UnityEngine.Object.Destroy(camGo);
        }
    }

    public class SpawnTests
    {
        const float BindY = 0f;     // where the bone sits in the stored rig
        const float PosedY = 2f;    // where the first frame of the animation puts it

        GameObject template;
        RuntimeAnimatorController controller;
        GameObject driver;
        Driver late;
        GameObject spawned;

        [SetUp]
        public void SetUp()
        {
#if UNITY_EDITOR
            var clip = new AnimationClip { name = "Rise" };
            clip.SetCurve("Arm", typeof(Transform), "localPosition.y", AnimationCurve.Linear(0f, PosedY, 1f, PosedY + 1f));
            var c = new UnityEditor.Animations.AnimatorController { name = "Gam3Test" };
            c.AddLayer("Base");
            c.layers[0].stateMachine.AddState("Rise").motion = clip;
            controller = c;
#endif
            template = new GameObject("Template");
            template.SetActive(false);
            template.AddComponent<Animator>();
            GameObject arm = GameObject.CreatePrimitive(PrimitiveType.Cube);
            arm.name = "Arm";
            arm.transform.SetParent(template.transform, false);
            arm.transform.localPosition = new Vector3(0f, BindY, 0f);
            driver = new GameObject("Driver");
            late = driver.AddComponent<Driver>();
            driver.AddComponent<Probe>().driver = late;
        }

        [TearDown]
        public void TearDown()
        {
            foreach (GameObject go in new[] { template, driver, spawned }) if (go != null) UnityEngine.Object.Destroy(go);
        }

        static float ArmY(GameObject go) { return go.transform.Find("Arm").localPosition.y; }
        static bool Visible(GameObject go) { return go.activeInHierarchy && go.GetComponentInChildren<Renderer>().enabled; }

        void RequireController()
        {
            if (controller == null) Assert.Ignore("the test rig needs the editor to build an AnimatorController");
        }

        /// <summary>Run `spawn` inside LateUpdate (after this frame's animation step) and report what that frame draws.</summary>
        IEnumerator SpawnLate(Func<GameObject> spawn)
        {
            late.firstVisibleY = float.NaN;
            late.bindFramesVisible = 0;
            late.action = () => { spawned = spawn(); late.watch = spawned; };
            while (late.action != null) yield return null;
            yield return null;
        }

        [UnityTest]
        public IEnumerator Control_APlainInstantiateInLateUpdate_IsDrawnInBindPose()
        {
            RequireController();
            template.GetComponent<Animator>().runtimeAnimatorController = controller;
            yield return SpawnLate(() => { GameObject g = UnityEngine.Object.Instantiate(template); g.SetActive(true); return g; });
            Assert.AreEqual(BindY, late.firstVisibleY, 0.001f, "expected the fault this kit exists for: a bind-pose first frame");
            yield return null;
            Assert.Greater(ArmY(spawned), PosedY - 0.001f, "the rig does animate from the next frame, so the test rig is sound");
        }

        [UnityTest]
        public IEnumerator Posed_InLateUpdate_FirstVisibleFrameIsAnimated()
        {
            RequireController();
            template.GetComponent<Animator>().runtimeAnimatorController = controller;
            yield return SpawnLate(() => Spawn.Posed(template, Vector3.zero, Quaternion.identity));
            Assert.AreEqual(PosedY, late.firstVisibleY, 0.001f, "the first visible frame must be the first frame of the animation");
            for (int i = 0; i < 5; i++) yield return null;
            Assert.AreEqual(0, late.bindFramesVisible, "a frame was drawn in bind pose");
        }

        [UnityTest]
        public IEnumerator Posed_WithACulledAnimator_FirstVisibleFrameIsAnimated()
        {
            RequireController();
            Animator a = template.GetComponent<Animator>();
            a.runtimeAnimatorController = controller;
            a.cullingMode = AnimatorCullingMode.CullCompletely;
            yield return SpawnLate(() => Spawn.Posed(template, new Vector3(0f, 0f, -500f), Quaternion.identity));
            Assert.AreEqual(PosedY, late.firstVisibleY, 0.001f);
            Assert.AreEqual(AnimatorCullingMode.CullCompletely, spawned.GetComponent<Animator>().cullingMode, "the culling mode must be put back");
        }

        [UnityTest]
        public IEnumerator ShowWhenPosed_APooledObject_StartsFromTheFirstFrameNotItsOldPose()
        {
            RequireController();
            template.GetComponent<Animator>().runtimeAnimatorController = controller;
            yield return SpawnLate(() => Spawn.Posed(template, Vector3.zero, Quaternion.identity));
            GameObject pooled = spawned;
            float t0 = Time.time;
            while (Time.time - t0 < 0.3f) yield return null;
            float oldPose = ArmY(pooled);
            Assert.Greater(oldPose, PosedY + 0.1f, "the animation should have moved on before the object goes back to the pool");
            pooled.SetActive(false);
            yield return null;
            yield return SpawnLate(() => { pooled.SetActive(true); Spawn.ShowWhenPosed(pooled); return pooled; });
            Assert.AreEqual(PosedY, late.firstVisibleY, 0.001f, "a pooled object must not show the last pose of its previous life");
        }

        [UnityTest]
        public IEnumerator ShowWhenPosed_WithoutAController_StaysHiddenUntilItHasOne()
        {
            RequireController();
            yield return SpawnLate(() => Spawn.Posed(template, Vector3.zero, Quaternion.identity, null, 30f));
            Assert.IsTrue(float.IsNaN(late.firstVisibleY), "it was shown before it could be posed");
            for (int i = 0; i < 5; i++) yield return null;
            Assert.IsFalse(Visible(spawned), "it must stay hidden while there is nothing to evaluate");

            spawned.GetComponent<Animator>().runtimeAnimatorController = controller;   // the asset arrived
            for (int i = 0; i < 3 && float.IsNaN(late.firstVisibleY); i++) yield return null;
            Assert.IsTrue(Visible(spawned));
            Assert.GreaterOrEqual(late.firstVisibleY, PosedY - 0.001f, "it became visible in bind pose");
            Assert.AreEqual(0, late.bindFramesVisible, "a frame was drawn in bind pose");
        }

        [UnityTest]
        public IEnumerator ShowWhenPosed_GivesUpAndShows_WhenNoControllerEverArrives()
        {
            LogAssert.Expect(LogType.Warning, new Regex("^GAM3SPAWN: .* shown without an animated pose"));
            yield return SpawnLate(() => Spawn.Posed(template, Vector3.zero, Quaternion.identity, null, 0.2f));
            Assert.IsFalse(Visible(spawned));
            float t0 = Time.realtimeSinceStartup;
            while (!Visible(spawned) && Time.realtimeSinceStartup - t0 < 10f) yield return null;
            Assert.IsTrue(Visible(spawned), "an object must not stay invisible for ever");
        }

        /// <summary>Runs one action inside LateUpdate, which is after the frame's animation step.</summary>
        sealed class Driver : MonoBehaviour
        {
            public Action action;
            public GameObject watch;
            public float firstVisibleY = float.NaN;
            public int bindFramesVisible;

            void LateUpdate()
            {
                if (action == null) return;
                Action a = action;
                a();
                action = null;
            }
        }

        /// <summary>Runs after every other LateUpdate: what it reads is what the frame draws.</summary>
        [DefaultExecutionOrder(32000)]
        sealed class Probe : MonoBehaviour
        {
            public Driver driver;

            void LateUpdate()
            {
                GameObject go = driver.watch;
                if (go == null || !Visible(go)) return;
                float y = ArmY(go);
                if (float.IsNaN(driver.firstVisibleY)) driver.firstVisibleY = y;
                if (Mathf.Abs(y - BindY) < 0.001f) driver.bindFramesVisible++;
            }
        }
    }
}
