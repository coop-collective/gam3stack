// Render one camera view of a scene to a PNG, from the command line (batch mode) or from the editor menu.
//
//   node Tools/gam3/unity_run.mjs exec Gam3.Shot.Capture -- -gam3Scene Assets/Scenes/Main.unity -gam3Out Shots/main.png
//        [-gam3Size 1600x900] [-gam3Pos x,y,z -gam3Rot pitch,yaw,roll] [-gam3Fov 46]
//
// Without -gam3Pos the scene's main camera is used (tag MainCamera, else the first enabled camera).
// With -gam3Pos a temporary camera is made at that pose; the scene file is never saved.
// -gam3Out is relative to the project directory unless it is absolute. Prints "GAM3SHOT: <path> <w>x<h>".
//
// Needs a graphics device: do not pass -nographics. This is an edit-mode render: no physics, animation or
// particles have run. It shows what the scene looks like when opened, not a frame of gameplay.
using System;
using System.Globalization;
using System.IO;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace Gam3
{
    public static class Shot
    {
        public static void Capture()
        {
            try
            {
                string scene = Arg("-gam3Scene");
                string outPath = Arg("-gam3Out") ?? "Shots/shot.png";
                int width = 1600, height = 900;
                string size = Arg("-gam3Size");
                if (size != null)
                {
                    string[] wh = size.ToLowerInvariant().Split('x');
                    if (wh.Length != 2 || !int.TryParse(wh[0], out width) || !int.TryParse(wh[1], out height) || width < 16 || height < 16 || width > 8192 || height > 8192)
                        throw new ArgumentException("-gam3Size must look like 1600x900");
                }
                if (scene != null) EditorSceneManager.OpenScene(scene, OpenSceneMode.Single);
                string full = Render(outPath, width, height, Vec("-gam3Pos"), Vec("-gam3Rot"), Num("-gam3Fov"));
                Debug.Log("GAM3SHOT: " + full + " " + width + "x" + height);
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
            string full = Render("Shots/shot.png", 1600, 900, null, null, null);
            Debug.Log("GAM3SHOT: " + full);
        }

        /// <summary>Render to a PNG and return its absolute path. pos null: use the scene's own camera.</summary>
        public static string Render(string outPath, int width, int height, Vector3? pos, Vector3? rot, float? fov)
        {
            Camera cam;
            GameObject temp = null;
            if (pos.HasValue)
            {
                temp = new GameObject("Gam3ShotCamera") { hideFlags = HideFlags.HideAndDontSave };
                cam = temp.AddComponent<Camera>();
                cam.transform.position = pos.Value;
                cam.transform.rotation = Quaternion.Euler(rot ?? Vector3.zero);
                cam.farClipPlane = 5000f;
            }
            else
            {
                cam = Camera.main;
                if (cam == null && Camera.allCamerasCount > 0) cam = Camera.allCameras[0];
                if (cam == null) throw new InvalidOperationException("the scene has no camera: pass -gam3Pos x,y,z (and -gam3Rot pitch,yaw,roll)");
            }
            float oldFov = cam.fieldOfView;
            if (fov.HasValue) cam.fieldOfView = fov.Value;
            RenderTexture oldTarget = cam.targetTexture;
            RenderTexture oldActive = RenderTexture.active;
            var rt = new RenderTexture(width, height, 24, RenderTextureFormat.ARGB32, RenderTextureReadWrite.sRGB) { antiAliasing = 4 };
            var tex = new Texture2D(width, height, TextureFormat.RGB24, false);
            try
            {
                cam.targetTexture = rt;
                cam.Render();
                RenderTexture.active = rt;
                tex.ReadPixels(new Rect(0, 0, width, height), 0, 0);
                tex.Apply();
                string full = Path.IsPathRooted(outPath) ? outPath : Path.Combine(Directory.GetCurrentDirectory(), outPath);
                Directory.CreateDirectory(Path.GetDirectoryName(full));
                File.WriteAllBytes(full, tex.EncodeToPNG());
                return full;
            }
            finally
            {
                cam.targetTexture = oldTarget;
                cam.fieldOfView = oldFov;
                RenderTexture.active = oldActive;
                rt.Release();
                UnityEngine.Object.DestroyImmediate(rt);
                UnityEngine.Object.DestroyImmediate(tex);
                if (temp != null) UnityEngine.Object.DestroyImmediate(temp);
            }
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
