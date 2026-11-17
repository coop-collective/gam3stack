// Look at what a player sees on the first frames after the loading cover drops.
//
// The seconds after a load are where a game looks broken: materials popping in, blurry textures sharpening, the
// camera snapping from the origin to the player, a character in bind pose. A screenshot taken five seconds in shows
// none of it. This renders the first N frames after a ReadyGate opens (or after you call it) to PNG files, so they
// can be checked one by one.
//
//   FirstFrames.AfterGate(gate, Camera.main, 5, "Shots/first");   // Shots/first_00.png ... first_04.png
//   yield return FirstFrames.Capture(camera, 5, "Shots/spawn");   // from any coroutine, starting this frame
//
// Each file is rendered from the camera at the end of that frame's LateUpdate, so it holds what that frame draws.
// Screen-space overlay UI is not part of a camera render, which is the point: the files show the world as it is at
// the moment the cover goes away. Each capture logs "GAM3FIRST: <path> frame=<n>".
// Works in the editor (also in batch mode) and in development builds. In a release build it does nothing.
using System.Collections;
using System.IO;
using UnityEngine;

namespace Gam3
{
    public static class FirstFrames
    {
        /// <summary>Capture the first <paramref name="frames"/> frames after the gate opens.</summary>
        public static void AfterGate(ReadyGate gate, Camera camera, int frames, string pathPrefix, int width = 640, int height = 360)
        {
            if (!Application.isEditor && !Debug.isDebugBuild) return;
            if (gate.IsReady) gate.StartCoroutine(Capture(camera, frames, pathPrefix, width, height));
            else gate.Ready += () => gate.StartCoroutine(Capture(camera, frames, pathPrefix, width, height));
        }

        /// <summary>Capture this frame and the following ones. A null camera means Camera.main on each frame.</summary>
        public static IEnumerator Capture(Camera camera, int frames, string pathPrefix, int width = 640, int height = 360)
        {
            if (!Application.isEditor && !Debug.isDebugBuild) yield break;
            var probe = new GameObject("Gam3FirstFrames").AddComponent<Probe>();
            Object.DontDestroyOnLoad(probe.gameObject);
            probe.Init(camera, frames, pathPrefix, width, height);
            while (probe != null && !probe.Done) yield return null;
            if (probe != null) Object.Destroy(probe.gameObject);
        }

        /// <summary>Render one camera to a PNG now. Returns the absolute path.</summary>
        public static string RenderToPng(Camera camera, string path, int width, int height)
        {
            RenderTexture oldTarget = camera.targetTexture;
            RenderTexture oldActive = RenderTexture.active;
            var rt = new RenderTexture(width, height, 24, RenderTextureFormat.ARGB32, RenderTextureReadWrite.sRGB);
            var tex = new Texture2D(width, height, TextureFormat.RGB24, false);
            try
            {
                camera.targetTexture = rt;
                camera.Render();
                RenderTexture.active = rt;
                tex.ReadPixels(new Rect(0, 0, width, height), 0, 0);
                tex.Apply();
                string full = Path.IsPathRooted(path) ? path : Path.Combine(Directory.GetCurrentDirectory(), path);
                Directory.CreateDirectory(Path.GetDirectoryName(full));
                File.WriteAllBytes(full, tex.EncodeToPNG());
                return full;
            }
            finally
            {
                camera.targetTexture = oldTarget;
                RenderTexture.active = oldActive;
                rt.Release();
                Object.Destroy(rt);
                Object.Destroy(tex);
            }
        }

        // Runs after every other LateUpdate, so the render holds the frame as it will be drawn.
        [DefaultExecutionOrder(32000)]
        sealed class Probe : MonoBehaviour
        {
            Camera cam;
            int frames, taken, width, height;
            string prefix;
            public bool Done { get; private set; }

            public void Init(Camera camera, int count, string pathPrefix, int w, int h)
            {
                cam = camera; frames = count; prefix = pathPrefix; width = w; height = h;
            }

            void LateUpdate()
            {
                if (Done) return;
                Camera c = cam != null ? cam : Camera.main;
                if (c == null || SystemInfo.graphicsDeviceType == UnityEngine.Rendering.GraphicsDeviceType.Null)
                {
                    Debug.LogWarning("GAM3FIRST: skipped, " + (c == null ? "no camera" : "no graphics device"));
                    Done = true;
                    return;
                }
                string full = RenderToPng(c, prefix + "_" + taken.ToString("00") + ".png", width, height);
                Debug.Log("GAM3FIRST: " + full + " frame=" + taken);
                if (++taken >= frames) Done = true;
            }
        }
    }
}
