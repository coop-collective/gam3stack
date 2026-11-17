// Editor entry points for Tools/gam3/unity_perf.mjs. Not meant to be called by hand.
//
//   Gam3.PerfPass.Run     set the scenario up in a scene (not saved) and enter play mode; the PerfRunner in the
//                         scene measures, writes the report and ends the editor.
//   Gam3.PerfPass.Build   save the same scene under Assets/Gam3PerfGenerated/ and build a player that starts in it,
//                         with Frame Timing Stats on. The build settings of the project are not changed.
//
// Arguments (after the Unity ones):
//   -gam3PerfScenario room|flyby|play   -gam3PerfData FILE.json   -gam3PerfOut REPORT.json
//   -gam3PerfBudgetMs N   -gam3PerfPrewarm   -gam3PerfHandicapMs N   -gam3PerfSize WxH   -gam3PerfBuildTo PATH
//
// The data file:
//   room   { "distance": 6, "subjects": [ { "name": "Fireball", "prefab": "Assets/FX/Fireball.prefab", "seconds": 2 } ] }
//   flyby  { "scene": "Assets/Scenes/Level1.unity",
//            "points": [ { "pos": [0, 5, -20], "look": [0, 1, 0], "seconds": 0 }, { "pos": [30, 5, 0], "look": [0, 1, 0], "seconds": 4 } ] }
//   play   { "scene": "Assets/Scenes/Level1.unity", "seconds": 30 }
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace Gam3
{
    public static class PerfPass
    {
        const string GeneratedDir = "Assets/Gam3PerfGenerated";

        [Serializable] sealed class SubjectData { public string name; public string prefab; public float seconds = 2f; }
        [Serializable] sealed class PointData { public float[] pos; public float[] look; public float seconds = 3f; }
        [Serializable]
        sealed class Data
        {
            public string scene;
            public float seconds = 20f;
            public float distance = 6f;
            public List<SubjectData> subjects = new List<SubjectData>();
            public List<PointData> points = new List<PointData>();
        }

        static string Arg(string name)
        {
            string[] a = Environment.GetCommandLineArgs();
            for (int i = 0; i < a.Length - 1; i++) if (a[i] == name) return a[i + 1];
            return null;
        }

        static bool Flag(string name) { return Array.IndexOf(Environment.GetCommandLineArgs(), name) >= 0; }

        static Vector3 V(float[] v, string what)
        {
            if (v == null || v.Length != 3) throw new ArgumentException(what + " must be [x, y, z]");
            return new Vector3(v[0], v[1], v[2]);
        }

        static float Num(string name, float fallback)
        {
            float v;
            string s = Arg(name);
            return s != null && float.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out v) ? v : fallback;
        }

        /// <summary>Open or make the scene and put a configured PerfRunner in it. The scene is left unsaved.</summary>
        static PerfRunner SetUp()
        {
            string scenario = Arg("-gam3PerfScenario") ?? "room";
            string dataPath = Arg("-gam3PerfData");
            if (dataPath == null || !File.Exists(dataPath)) throw new ArgumentException("data file not found: " + dataPath);
            Data data = JsonUtility.FromJson<Data>(File.ReadAllText(dataPath));
            if (data == null) throw new ArgumentException("data file is not JSON: " + dataPath);

            if (scenario == "room") EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            else
            {
                if (string.IsNullOrEmpty(data.scene) || !File.Exists(data.scene)) throw new ArgumentException("\"scene\" in the data file must be the path of a scene asset: " + data.scene);
                EditorSceneManager.OpenScene(data.scene, OpenSceneMode.Single);
            }

            var runner = new GameObject("Gam3PerfRunner").AddComponent<PerfRunner>();
            runner.scenario = scenario;
            runner.outPath = Arg("-gam3PerfOut") ?? "";
            runner.budgetMs = Num("-gam3PerfBudgetMs", 16.7f);
            runner.prewarm = Flag("-gam3PerfPrewarm");
            runner.handicapMs = (int)Num("-gam3PerfHandicapMs", 0f);
            runner.seconds = data.seconds;
            runner.distance = data.distance;
            string size = Arg("-gam3PerfSize");
            if (size != null)
            {
                string[] wh = size.Split('x');
                if (wh.Length != 2 || !int.TryParse(wh[0], out runner.width) || !int.TryParse(wh[1], out runner.height)) throw new ArgumentException("-gam3PerfSize must be WxH");
            }
            foreach (SubjectData s in data.subjects)
            {
                var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(s.prefab);
                if (prefab == null) throw new ArgumentException("subject \"" + s.name + "\": no prefab at " + s.prefab);
                runner.subjects.Add(new PerfRunner.Subject { name = string.IsNullOrEmpty(s.name) ? Path.GetFileNameWithoutExtension(s.prefab) : s.name, prefab = prefab, seconds = s.seconds });
            }
            foreach (PointData p in data.points)
                runner.points.Add(new PerfRunner.Point { position = V(p.pos, "pos"), lookAt = V(p.look, "look"), seconds = p.seconds });
            if (scenario == "room" && runner.subjects.Count == 0) throw new ArgumentException("a room needs at least one subject");
            if (scenario == "flyby" && runner.points.Count < 2) throw new ArgumentException("a fly-by needs at least two points");
            return runner;
        }

        public static void Run()
        {
            try
            {
                if (Profile.Name != "human") throw new InvalidOperationException("a performance run needs --profile human: the other profiles run on a fixed time step and lowered quality");
                SetUp();
                EditorApplication.EnterPlaymode();
            }
            catch (Exception e)
            {
                Debug.LogError("GAM3PERF_ERROR: " + e.Message);
                EditorApplication.Exit(1);
            }
        }

        public static void Build()
        {
            try
            {
                string to = Arg("-gam3PerfBuildTo");
                if (string.IsNullOrEmpty(to)) throw new ArgumentException("-gam3PerfBuildTo is missing");
                PerfRunner runner = SetUp();
                runner.outPath = "";            // the player takes -gam3PerfOut
                Directory.CreateDirectory(GeneratedDir);
                string scenePath = GeneratedDir + "/Gam3Perf.unity";
                if (!EditorSceneManager.SaveScene(runner.gameObject.scene, scenePath, true)) throw new InvalidOperationException("could not save " + scenePath);
                AssetDatabase.Refresh();

                // The perf scene starts; the project's own scenes follow, so a game that loads them by name still can.
                var scenes = new List<string> { scenePath };
                foreach (EditorBuildSettingsScene s in EditorBuildSettings.scenes) if (s.enabled && File.Exists(s.path)) scenes.Add(s.path);

                bool hadStats = PlayerSettings.enableFrameTimingStats;
                PlayerSettings.enableFrameTimingStats = true;
                try
                {
                    var options = new BuildPlayerOptions
                    {
                        scenes = scenes.ToArray(),
                        locationPathName = to,
                        target = EditorUserBuildSettings.activeBuildTarget,
                        options = BuildOptions.None,
                    };
                    UnityEditor.Build.Reporting.BuildReport report = BuildPipeline.BuildPlayer(options);
                    if (report.summary.result != UnityEditor.Build.Reporting.BuildResult.Succeeded)
                        throw new InvalidOperationException("the player build " + report.summary.result + " with " + report.summary.totalErrors + " error(s)");
                    Debug.Log("GAM3PERF: built player=" + to + " target=" + options.target);
                }
                finally
                {
                    PlayerSettings.enableFrameTimingStats = hadStats;
                }
                EditorApplication.Exit(0);
            }
            catch (Exception e)
            {
                Debug.LogError("GAM3PERF_ERROR: " + e.Message);
                EditorApplication.Exit(1);
            }
        }
    }
}
