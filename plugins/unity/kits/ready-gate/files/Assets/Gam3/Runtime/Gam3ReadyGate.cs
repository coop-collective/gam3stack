// A gate between "the scene object exists" and "a player may see it".
//
// A level that has just loaded is not ready to be looked at: shaders are still compiling (a hitch per new material),
// texture mips are still streaming in (blurry surfaces that sharpen), additive scenes are still arriving (holes in
// the world), and the game's own setup (spawning the player, generating terrain, placing the camera) has not run.
// The gate keeps a loading cover up until all of that is done, then opens once.
//
//   var gate = ReadyGate.Begin(coverObject);            // cover is any GameObject: a full-screen canvas, usually
//   gate.LoadScene("Level1", LoadSceneMode.Additive);   // optional: scene loads the gate should wait for
//   var spawn = gate.Hold("player");                    // optional: anything of your own it should wait for
//   ... spawn the player ...  spawn.Dispose();
//   gate.AddCondition("terrain", () => terrain.Ready);  // optional: polled every frame
//   yield return gate.WaitUntilReady();                 // or: gate.Ready += ...;  or: await gate.WhenReady();
//
// Ready means, in this order: every tracked scene load has finished, every hold has been released and every
// condition is true, the shader variant collections have been warmed up, no texture mip is still streaming (when
// mip streaming is on), and then `settledFrames` frames in a row were each shorter than `hitchSeconds` (so the gate
// does not open into the middle of a loading hitch). One log line reports it:
//   GAM3READY: ok frames=<n> waited=<s>s
//   GAM3READY: TIMEOUT waiting=<names of what was still not ready>
// After `timeoutSeconds` the gate opens anyway (a game must never sit behind a cover for ever), `TimedOut` is true and
// the line names what it was waiting for. Treat that line as a bug to fix, not as noise.
//
// Time is measured on the real clock, so the gate works while the game is paused (Time.timeScale = 0) and under a
// fixed capture time step.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Threading.Tasks;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace Gam3
{
    public sealed class ReadyGate : MonoBehaviour
    {
        /// <summary>The gate that is closed or opened most recently. Null before the first Begin.</summary>
        public static ReadyGate Current { get; private set; }

        [Tooltip("Shown while the gate is closed, hidden when it opens. Usually a full-screen canvas.")]
        public GameObject cover;
        [Tooltip("Warmed up, one per frame, while the cover is up: the shader variants the level uses.")]
        public ShaderVariantCollection[] shaderWarmUp;
        [Tooltip("Frames in a row that must each be shorter than Hitch Seconds before the gate opens.")]
        public int settledFrames = 3;
        [Tooltip("A frame longer than this is a loading hitch and restarts the settled count.")]
        public float hitchSeconds = 0.1f;
        [Tooltip("Open anyway after this long, and log what was still not ready.")]
        public float timeoutSeconds = 20f;

        public bool IsReady { get; private set; }
        public bool TimedOut { get; private set; }
        /// <summary>What the gate was still waiting for when it timed out, comma separated; empty otherwise.</summary>
        public string TimeoutReason { get; private set; } = "";
        /// <summary>Frames the gate stayed closed.</summary>
        public int FramesWaited { get; private set; }
        /// <summary>Raised once, on the frame the gate opens (also after a timeout).</summary>
        public event Action Ready;

        readonly List<KeyValuePair<string, Func<bool>>> conditions = new List<KeyValuePair<string, Func<bool>>>();
        readonly List<KeyValuePair<string, AsyncOperation>> loads = new List<KeyValuePair<string, AsyncOperation>>();
        readonly List<Hold_> holds = new List<Hold_>();
        TaskCompletionSource<bool> whenReady;
        float startedAt;
        float lastFrameAt;
        int warmed;
        int settled;

        /// <summary>Make a closed gate and show the cover. The gate object survives scene loads.</summary>
        public static ReadyGate Begin(GameObject cover = null)
        {
            var go = new GameObject("Gam3ReadyGate");
            DontDestroyOnLoad(go);
            var gate = go.AddComponent<ReadyGate>();
            gate.cover = cover;
            if (cover != null) cover.SetActive(true);
            return gate;
        }

        void Awake()
        {
            Current = this;
            startedAt = lastFrameAt = Time.realtimeSinceStartup;
            if (cover != null) cover.SetActive(true);
        }

        /// <summary>Start a scene load the gate waits for.</summary>
        public AsyncOperation LoadScene(string sceneName, LoadSceneMode mode = LoadSceneMode.Single)
        {
            AsyncOperation op = SceneManager.LoadSceneAsync(sceneName, mode);
            if (op == null) throw new ArgumentException("scene not in the build: " + sceneName);
            Track("scene:" + sceneName, op);
            return op;
        }

        /// <summary>Wait for any async operation: a scene load started elsewhere, an asset bundle, a resource request.</summary>
        public void Track(string name, AsyncOperation operation)
        {
            if (operation != null) loads.Add(new KeyValuePair<string, AsyncOperation>(name, operation));
        }

        /// <summary>Wait until <paramref name="ready"/> returns true. It is called once a frame while the gate is closed.</summary>
        public void AddCondition(string name, Func<bool> ready)
        {
            conditions.Add(new KeyValuePair<string, Func<bool>>(name, ready));
        }

        /// <summary>Keep the gate closed until the returned object is disposed.</summary>
        public IDisposable Hold(string name)
        {
            var h = new Hold_ { name = name };
            holds.Add(h);
            return h;
        }

        /// <summary>For coroutines: yield return gate.WaitUntilReady();</summary>
        public IEnumerator WaitUntilReady()
        {
            while (!IsReady) yield return null;
        }

        /// <summary>For async code: await gate.WhenReady();</summary>
        public Task WhenReady()
        {
            if (IsReady) return Task.CompletedTask;
            if (whenReady == null) whenReady = new TaskCompletionSource<bool>();
            return whenReady.Task;
        }

        void Update()
        {
            if (IsReady) return;
            FramesWaited++;
            // Real seconds, measured here: Time.unscaledDeltaTime follows a fixed capture time step, a hitch does not.
            float frameSeconds = Time.realtimeSinceStartup - lastFrameAt;
            lastFrameAt = Time.realtimeSinceStartup;
            string waiting = Waiting();
            // Settled frames only count once everything else is done: the point is to let the last hitch pass.
            if (waiting.Length == 0)
            {
                settled = frameSeconds <= hitchSeconds ? settled + 1 : 0;
                if (settled >= Mathf.Max(1, settledFrames)) { Open(""); return; }
                waiting = "settling";
            }
            else settled = 0;
            if (Time.realtimeSinceStartup - startedAt >= timeoutSeconds) Open(waiting);
        }

        string Waiting()
        {
            var names = new List<string>();
            foreach (var l in loads) if (!l.Value.isDone) names.Add(l.Key);
            foreach (var h in holds) if (!h.released) names.Add(h.name);
            foreach (var c in conditions)
            {
                bool ok;
                try { ok = c.Value(); }
                catch (Exception e) { Debug.LogException(e); ok = false; }
                if (!ok) names.Add(c.Key);
            }
            if (names.Count > 0) return string.Join(",", names);

            // Shaders: warm one collection per frame so the cover can keep animating.
            if (shaderWarmUp != null && warmed < shaderWarmUp.Length)
            {
                ShaderVariantCollection set = shaderWarmUp[warmed++];
                if (set != null && !set.isWarmedUp) set.WarmUp();
                return "shaders";
            }
            if (QualitySettings.streamingMipmapsActive && (Texture.streamingTexturePendingLoadCount > 0 || Texture.streamingTextureLoadingCount > 0)) return "textures";
            return "";
        }

        void Open(string timedOutWaitingFor)
        {
            IsReady = true;
            TimedOut = timedOutWaitingFor.Length > 0;
            TimeoutReason = timedOutWaitingFor;
            string waited = (Time.realtimeSinceStartup - startedAt).ToString("0.00", CultureInfo.InvariantCulture);
            if (TimedOut) Debug.LogError("GAM3READY: TIMEOUT waiting=" + timedOutWaitingFor + " frames=" + FramesWaited + " waited=" + waited + "s");
            else Debug.Log("GAM3READY: ok frames=" + FramesWaited + " waited=" + waited + "s");
            if (cover != null) cover.SetActive(false);
            Action handlers = Ready;
            Ready = null;
            if (handlers != null) handlers();
            if (whenReady != null) whenReady.TrySetResult(true);
        }

        sealed class Hold_ : IDisposable
        {
            public string name;
            public bool released;
            public void Dispose() { released = true; }
        }
    }
}
