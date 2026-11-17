// Runs one performance scenario and writes the report. Put into a scene by Gam3.PerfPass (editor) from the options
// of Tools/gam3/unity_perf.mjs; it works the same in play mode and in a built player.
//
//   room    Each subject alone in front of a fixed camera in an otherwise empty scene: spawned cold and left alive
//           (segment "<name>/cold"), destroyed, then spawned again (segment "<name>/warm"). The difference between
//           the first frames of the two is what the first use costs: the hitch a player sees. With `prewarm` the
//           subjects go through Prewarm.Run behind the gate first, which is the cure being tested.
//   flyby   The camera moves through a list of points in the level: one segment per leg ("leg1", "leg2", ...).
//           This is the cost of the world itself, with nothing happening in it.
//   play    The game runs by itself for `seconds`. This script only measures; the game's own bot plays and the
//           game's own Perf.Mark calls split the run into named parts.
//
// Recording starts when the ready gate opens (the game's own gate if it began one, else one made here), so loading
// is never counted as play.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Threading;
using UnityEngine;
using UnityEngine.Rendering;

namespace Gam3
{
    public sealed class PerfRunner : MonoBehaviour
    {
        [Serializable]
        public sealed class Subject
        {
            public string name;
            public GameObject prefab;
            [Tooltip("How long the cold spawn stays alive: its steady cost is measured over this time.")]
            public float seconds = 2f;
        }

        [Serializable]
        public sealed class Point
        {
            public Vector3 position;
            public Vector3 lookAt;
            [Tooltip("Seconds to travel from the point before this one.")]
            public float seconds = 3f;
        }

        public string scenario = "room";
        public string outPath = "";
        public float budgetMs = 16.7f;
        public bool prewarm;
        public List<Subject> subjects = new List<Subject>();
        public float distance = 6f;
        public List<Point> points = new List<Point>();
        public float seconds = 20f;
        public int width = 1920;
        public int height = 1080;
        [Tooltip("Self-test only: sleep this long every frame, to prove that a slower run is reported as regressed.")]
        public int handicapMs;

        Camera roomCamera;
        RenderTexture screen;
        int rendered;
        bool manual;
        bool done;

        void Awake()
        {
            string[] a = Environment.GetCommandLineArgs();
            for (int i = 0; i < a.Length - 1; i++)
            {
                if (a[i] == "-gam3PerfOut") outPath = a[i + 1];
                if (a[i] == "-gam3PerfHandicapMs") int.TryParse(a[i + 1], NumberStyles.Integer, CultureInfo.InvariantCulture, out handicapMs);
            }
            // Measure the frame, not the display: no vertical sync, no frame cap.
            QualitySettings.vSyncCount = 0;
            Application.targetFrameRate = -1;
            Application.runInBackground = true;
            Perf.HitchMs = budgetMs * 2f;
            Camera.onPostRender += Counted;
            RenderPipelineManager.endCameraRendering += CountedSrp;
        }

        void OnDestroy()
        {
            Camera.onPostRender -= Counted;
            RenderPipelineManager.endCameraRendering -= CountedSrp;
            if (screen != null) screen.Release();
        }

        void Counted(Camera c) { if (!manual && screen != null && c.targetTexture == screen) rendered++; }
        void CountedSrp(ScriptableRenderContext ctx, Camera c) { Counted(c); }

        void Update()
        {
            if (handicapMs > 0) Thread.Sleep(handicapMs);
        }

        // An editor in batch mode has no game view, so a camera that draws to the screen may never draw at all and
        // the run would measure an empty frame. There, every such camera is pointed at a texture the size of the
        // screen being tested and, if the engine still does not draw it, drawn by hand once a frame.
        void LateUpdate()
        {
            if (!Application.isBatchMode || !Application.isEditor) return;
            if (screen == null) { screen = new RenderTexture(width, height, 24); screen.Create(); }
            foreach (Camera c in Camera.allCameras)
            {
                if (c.targetTexture == null) c.targetTexture = screen;
            }
            if (!manual) return;
            foreach (Camera c in Camera.allCameras)
            {
                if (c.targetTexture == screen) c.Render();
            }
        }

        IEnumerator Start()
        {
            IEnumerator run = Run();
            for (;;)
            {
                bool more;
                try { more = run.MoveNext(); }
                catch (Exception e)
                {
                    Debug.LogError("GAM3PERF_ERROR: " + e.GetType().Name + ": " + e.Message);
                    Quit(1);
                    yield break;
                }
                if (!more) yield break;
                yield return run.Current;
            }
        }

        IEnumerator Run()
        {
            if (scenario == "room") BuildRoom();

            ReadyGate gate = ReadyGate.Current != null ? ReadyGate.Current : ReadyGate.Begin(null);
            if (prewarm)
            {
                var prefabs = new List<GameObject>();
                foreach (Subject s in subjects) if (s.prefab != null) prefabs.Add(s.prefab);
                Prewarm.Run(this, prefabs, gate);
            }
            // Find out, before recording, whether the engine draws the cameras by itself in this kind of run.
            for (int i = 0; i < 6; i++) yield return null;
            if (Application.isBatchMode && Application.isEditor && rendered == 0)
            {
                manual = true;
                foreach (Camera c in Camera.allCameras) if (c.targetTexture == screen) c.enabled = true;
            }
            yield return gate.WaitUntilReady();
            if (gate.TimedOut) throw new InvalidOperationException("the ready gate timed out (" + gate.TimeoutReason + "): the scene was not ready, so nothing was measured");
            Debug.Log("GAM3PERF: started scenario=" + scenario + " cameras=" + (manual ? "drawn-by-hand" : "engine") + " size=" + width + "x" + height);

            if (!Perf.Begin("idle")) { Quit(1); yield break; }
            yield return Wait(0.5f);

            if (scenario == "room") yield return Room();
            else if (scenario == "flyby") yield return Flyby();
            else if (scenario == "play") { Perf.Mark("play"); yield return Wait(seconds); }
            else throw new InvalidOperationException("unknown scenario: " + scenario);

            string extra = "\"scenario\": \"" + scenario + "\", \"prewarm\": " + (prewarm ? "true" : "false")
                + ", \"budget_ms\": " + budgetMs.ToString("0.###", CultureInfo.InvariantCulture)
                + ", \"width\": " + width + ", \"height\": " + height
                + ", \"cameras\": \"" + (manual ? "drawn-by-hand" : "engine") + "\""
                + ", \"handicap_ms\": " + handicapMs;
            Perf.End(outPath, extra);
            Debug.Log("GAM3PERF: done report=" + outPath);
            Quit(0);
        }

        static IEnumerator Wait(float realSeconds)
        {
            float until = Time.realtimeSinceStartup + realSeconds;
            while (Time.realtimeSinceStartup < until) yield return null;
        }

        void BuildRoom()
        {
            var camGo = new GameObject("Gam3PerfCamera");
            roomCamera = camGo.AddComponent<Camera>();
            roomCamera.tag = "MainCamera";
            roomCamera.clearFlags = CameraClearFlags.SolidColor;
            roomCamera.backgroundColor = new Color(0.18f, 0.18f, 0.2f);
            roomCamera.transform.position = new Vector3(0f, 1.5f, 0f);
            roomCamera.transform.LookAt(new Vector3(0f, 1f, distance));
            var lightGo = new GameObject("Gam3PerfLight");
            Light light = lightGo.AddComponent<Light>();
            light.type = LightType.Directional;
            light.shadows = LightShadows.Soft;
            lightGo.transform.rotation = Quaternion.Euler(50f, -30f, 0f);
            GameObject floor = GameObject.CreatePrimitive(PrimitiveType.Plane);
            floor.name = "Gam3PerfFloor";
            floor.transform.localScale = new Vector3(4f, 1f, 4f);
            floor.transform.position = new Vector3(0f, 0f, distance);
        }

        IEnumerator Room()
        {
            Vector3 at = new Vector3(0f, 0f, distance);
            foreach (Subject s in subjects)
            {
                if (s.prefab == null) throw new InvalidOperationException("subject \"" + s.name + "\" has no prefab");
                Perf.Mark(s.name + "/cold");
                GameObject o = Instantiate(s.prefab, at, Quaternion.identity);
                yield return Wait(Mathf.Max(0.5f, s.seconds));
                Destroy(o);
                Perf.Mark("gap");
                yield return Wait(0.3f);
                Perf.Mark(s.name + "/warm");
                o = Instantiate(s.prefab, at, Quaternion.identity);
                yield return Wait(1f);
                Destroy(o);
                Perf.Mark("gap");
                yield return Wait(0.3f);
            }
        }

        IEnumerator Flyby()
        {
            if (points.Count < 2) throw new InvalidOperationException("a fly-by needs at least two points");
            Camera cam = Camera.main;
            if (cam == null)
            {
                cam = new GameObject("Gam3PerfCamera").AddComponent<Camera>();
                cam.tag = "MainCamera";
            }
            Transform t = cam.transform;
            t.position = points[0].position;
            t.LookAt(points[0].lookAt);
            Perf.Mark("gap");
            yield return Wait(0.3f);
            for (int i = 1; i < points.Count; i++)
            {
                Point a = points[i - 1], b = points[i];
                Perf.Mark("leg" + i);
                float dur = Mathf.Max(0.1f, b.seconds);
                float t0 = Time.realtimeSinceStartup;
                for (;;)
                {
                    float k = Mathf.Clamp01((Time.realtimeSinceStartup - t0) / dur);
                    t.position = Vector3.Lerp(a.position, b.position, k);
                    t.LookAt(Vector3.Lerp(a.lookAt, b.lookAt, k));
                    if (k >= 1f) break;
                    yield return null;
                }
            }
        }

        void Quit(int code)
        {
            if (done) return;
            done = true;
#if UNITY_EDITOR
            UnityEditor.EditorApplication.Exit(code);
#else
            Application.Quit(code);
#endif
        }
    }
}
