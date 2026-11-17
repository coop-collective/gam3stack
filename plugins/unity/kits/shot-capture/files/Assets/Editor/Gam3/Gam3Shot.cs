// Render one camera view of a scene to a PNG, from the command line (batch mode) or from the editor menu.
//
//   node Tools/gam3/unity_run.mjs exec Gam3.Shot.Capture -- -gam3Scene Assets/Scenes/Main.unity -gam3Out Shots/main.png
//        [-gam3Size 1600x900] [-gam3Pos x,y,z -gam3Rot pitch,yaw,roll] [-gam3Fov 46] [-gam3ReadyTimeout 60]
//
// Without -gam3Pos the scene's main camera is used (tag MainCamera, else the first enabled camera).
// With -gam3Pos a temporary camera is made at that pose; the scene file is never saved.
// -gam3Out is relative to the project directory unless it is absolute. Prints "GAM3SHOT: <path> <w>x<h>".
//
// Nothing is captured until the scene is ready. Ready means: the scene is loaded, nothing is importing or
// compiling, no shader is still compiling (shaders compile synchronously for the capture, so a material never
// draws as the cyan placeholder), and the picture has stopped changing: warm-up renders are compared until two in
// a row match. The result is one log line:
//   GAM3READY: ok frames=<renders> waited=<seconds>s
//   GAM3READY: TIMEOUT waiting=<what was still not ready: scene, import, compile, shaders, unsettled>
// On a timeout the picture is still written, the line "GAM3SHOT: UNREADY ..." is logged and the run exits 1:
// look at the picture to find out what is wrong with the scene, never to judge the scene.
// The wait needs editor updates, so the capture does not finish inside Capture(): it ends the run itself with
// EditorApplication.Exit. unity_run.mjs knows this and starts Gam3.Shot.* methods without -quit.
//
// Profile (set by unity_run.mjs --profile, read from -gam3Profile): under "agent" the default size is 640x360,
// the render uses the lowest quality level and no anti-aliasing. Under "blind" there is no graphics device and the
// capture is refused. The quality level is put back after the render.
//
// This is an edit-mode render: no physics, animation or particles have run. It shows what the scene looks like when
// opened, not a frame of gameplay. For the first frames of gameplay use the ready-gate kit's FirstFrames.
using System;
using System.Globalization;
using System.IO;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.SceneManagement;

namespace Gam3
{
    public static class Shot
    {
        const int MinRenders = 3;             // the first renders build shadow maps, probes and terrain patches
        const float SettledDifference = 0.5f; // mean difference per colour channel, out of 255, between two renders

        /// <summary>Command-line entry. Returns at once; the capture runs on editor updates and then ends the run.</summary>
        public static void Capture()
        {
            try
            {
                if (SystemInfo.graphicsDeviceType == GraphicsDeviceType.Null)
                    throw new InvalidOperationException("no graphics device (--profile blind or -nographics): a capture needs --profile agent or human");
                bool agent = Arg("-gam3Profile") == "agent";
                string scene = Arg("-gam3Scene");
                int width = agent ? 640 : 1600, height = agent ? 360 : 900;
                string size = Arg("-gam3Size");
                if (size != null)
                {
                    string[] wh = size.ToLowerInvariant().Split('x');
                    if (wh.Length != 2 || !int.TryParse(wh[0], out width) || !int.TryParse(wh[1], out height) || width < 16 || height < 16 || width > 8192 || height > 8192)
                        throw new ArgumentException("-gam3Size must look like 1600x900");
                }
                if (scene != null) EditorSceneManager.OpenScene(scene, OpenSceneMode.Single);
                Begin(Arg("-gam3Out") ?? "Shots/shot.png", width, height, Vec("-gam3Pos"), Vec("-gam3Rot"), Num("-gam3Fov"), agent, Num("-gam3ReadyTimeout") ?? 60f,
                    (path, ready) => { if (Application.isBatchMode) EditorApplication.Exit(ready ? 0 : 1); });
            }
            catch (Exception e)
            {
                Debug.LogError("GAM3SHOT: FAILED " + e.Message);
                if (Application.isBatchMode) EditorApplication.Exit(1);
            }
        }

        [MenuItem("Tools/Gam3/Capture Main Camera")]
        static void CaptureFromMenu()
        {
            Begin("Shots/shot.png", 1600, 900, null, null, null, false, 60f, null);
        }

        /// <summary>
        /// Start a capture. It renders once per editor update until the scene is ready and the picture has stopped
        /// changing (or the time is up), writes the PNG, logs GAM3READY and GAM3SHOT, then calls
        /// <paramref name="done"/> with the absolute path and whether the scene was ready. pos null: the scene's camera.
        /// </summary>
        public static void Begin(string outPath, int width, int height, Vector3? pos, Vector3? rot, float? fov, bool cheap, float readyTimeout, Action<string, bool> done)
        {
            var job = new Job { outPath = outPath, timeout = readyTimeout, done = done, start = EditorApplication.timeSinceStartup };
            if (pos.HasValue)
            {
                job.temp = new GameObject("Gam3ShotCamera") { hideFlags = HideFlags.HideAndDontSave };
                job.cam = job.temp.AddComponent<Camera>();
                job.cam.transform.position = pos.Value;
                job.cam.transform.rotation = Quaternion.Euler(rot ?? Vector3.zero);
                job.cam.farClipPlane = 5000f;
            }
            else
            {
                job.cam = Camera.main;
                if (job.cam == null && Camera.allCamerasCount > 0) job.cam = Camera.allCameras[0];
                if (job.cam == null) throw new InvalidOperationException("the scene has no camera: pass -gam3Pos x,y,z (and -gam3Rot pitch,yaw,roll)");
            }
            job.oldFov = job.cam.fieldOfView;
            if (fov.HasValue) job.cam.fieldOfView = fov.Value;
            job.oldTarget = job.cam.targetTexture;
            job.oldAsync = ShaderUtil.allowAsyncCompilation;
            job.oldQuality = QualitySettings.GetQualityLevel();
            // A shader that is still compiling draws as a flat cyan placeholder. Compile on demand instead.
            ShaderUtil.allowAsyncCompilation = false;
            if (cheap) QualitySettings.SetQualityLevel(0, true);
            job.rt = new RenderTexture(width, height, 24, RenderTextureFormat.ARGB32, RenderTextureReadWrite.sRGB) { antiAliasing = cheap ? 1 : 4 };
            job.tex = new Texture2D(width, height, TextureFormat.RGB24, false);
            job.cam.targetTexture = job.rt;
            EditorApplication.update += job.Step;
        }

        sealed class Job
        {
            public string outPath;
            public float timeout;
            public Action<string, bool> done;
            public double start;
            public Camera cam;
            public GameObject temp;
            public RenderTexture rt, oldTarget;
            public Texture2D tex;
            public float oldFov;
            public bool oldAsync;
            public int oldQuality;
            byte[] previous;
            int renders;

            public void Step()
            {
                try
                {
                    string waiting = RenderAndCheck();
                    double waited = EditorApplication.timeSinceStartup - start;
                    if (waiting.Length > 0 && waited < timeout) return;
                    bool ready = waiting.Length == 0;
                    string seconds = waited.ToString("0.00", CultureInfo.InvariantCulture);
                    if (ready) Debug.Log("GAM3READY: ok frames=" + renders + " waited=" + seconds + "s");
                    else Debug.LogError("GAM3READY: TIMEOUT waiting=" + waiting.Substring(1) + " frames=" + renders + " waited=" + seconds + "s");
                    string full = Path.IsPathRooted(outPath) ? outPath : Path.Combine(Directory.GetCurrentDirectory(), outPath);
                    Directory.CreateDirectory(Path.GetDirectoryName(full));
                    File.WriteAllBytes(full, tex.EncodeToPNG());
                    string what = full + " " + rt.width + "x" + rt.height;
                    if (ready) Debug.Log("GAM3SHOT: " + what);
                    else Debug.LogError("GAM3SHOT: UNREADY " + what + " (written for diagnosis only)");
                    Action<string, bool> then = done;
                    End();
                    if (then != null) then(full, ready);
                }
                catch (Exception e)
                {
                    End();
                    Debug.LogError("GAM3SHOT: FAILED " + e.Message);
                    if (Application.isBatchMode) EditorApplication.Exit(1);
                }
            }

            /// <summary>One render. Returns what is still not ready as ",a,b", or "" when the picture can be trusted.</summary>
            string RenderAndCheck()
            {
                cam.Render();
                RenderTexture old = RenderTexture.active;
                RenderTexture.active = rt;
                tex.ReadPixels(new Rect(0, 0, rt.width, rt.height), 0, 0);
                tex.Apply();
                RenderTexture.active = old;
                renders++;
                var now = tex.GetRawTextureData<byte>();
                bool settled = previous != null && MeanDifference(previous, now) <= SettledDifference;
                if (previous == null) previous = new byte[now.Length];
                now.CopyTo(previous);

                string waiting = "";
                for (int i = 0; i < SceneManager.sceneCount; i++) if (!SceneManager.GetSceneAt(i).isLoaded) { waiting += ",scene"; break; }
                if (EditorApplication.isUpdating) waiting += ",import";
                if (EditorApplication.isCompiling) waiting += ",compile";
                if (ShaderUtil.anythingCompiling) waiting += ",shaders";
                if (!settled || renders < MinRenders) waiting += ",unsettled";
                return waiting;
            }

            void End()
            {
                EditorApplication.update -= Step;
                done = null;
                ShaderUtil.allowAsyncCompilation = oldAsync;
                if (QualitySettings.GetQualityLevel() != oldQuality) QualitySettings.SetQualityLevel(oldQuality, true);
                if (cam != null) { cam.targetTexture = oldTarget; cam.fieldOfView = oldFov; }
                if (rt != null) { rt.Release(); UnityEngine.Object.DestroyImmediate(rt); }
                if (tex != null) UnityEngine.Object.DestroyImmediate(tex);
                if (temp != null) UnityEngine.Object.DestroyImmediate(temp);
            }
        }

        static float MeanDifference(byte[] a, Unity.Collections.NativeArray<byte> b)
        {
            if (a.Length != b.Length || a.Length == 0) return 255f;
            long sum = 0;
            for (int i = 0; i < a.Length; i++) sum += Math.Abs(a[i] - b[i]);
            return (float)sum / a.Length;
        }

        static string Arg(string name)
        {
            string[] a = Environment.GetCommandLineArgs();
            for (int i = 0; i < a.Length - 1; i++) if (a[i] == name) return a[i + 1];
            return null;
        }

        static float? Num(string name)
        {
            string v = Arg(name);
            if (v == null) return null;
            return float.Parse(v, CultureInfo.InvariantCulture);
        }

        static Vector3? Vec(string name)
        {
            string v = Arg(name);
            if (v == null) return null;
            string[] p = v.Split(',');
            if (p.Length != 3) throw new ArgumentException(name + " needs three numbers: x,y,z");
            return new Vector3(float.Parse(p[0], CultureInfo.InvariantCulture), float.Parse(p[1], CultureInfo.InvariantCulture), float.Parse(p[2], CultureInfo.InvariantCulture));
        }
    }
}
