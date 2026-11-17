// Applies the run profile that Tools/gam3/unity_run.mjs passes as "-gam3Profile blind|agent|human".
//
//   human  nothing is changed: the project's own quality and real time.
//   agent  play mode runs at the lowest quality level and on a fixed time step.
//   blind  there is no graphics device; play mode runs on the same fixed time step.
//
// The fixed time step (Time.captureDeltaTime) makes every frame advance game time by exactly 1/30 s (or
// "-gam3Fps N"), however long the frame took to compute. A slow machine, a shader hitch or three editors running
// side by side then change how long a test takes, not what happens in it; and a run with nothing to draw goes
// faster than real time. Code that reads Time.unscaledDeltaTime or the system clock still sees real time.
//
// Nothing here is saved: the quality level and time step are put back when play mode ends and when the editor quits.
// Without the command-line argument (a person's editor) this script does nothing.
using System;
using System.Globalization;
using UnityEditor;
using UnityEngine;

namespace Gam3
{
    [InitializeOnLoad]
    public static class Profile
    {
        const string QualityKey = "Gam3.Profile.Quality";

        /// <summary>"blind", "agent" or "human" (the default when the argument is absent).</summary>
        public static string Name
        {
            get
            {
                string v = Arg("-gam3Profile");
                return v == "blind" || v == "agent" ? v : "human";
            }
        }

        public static bool IsAgent { get { return Name == "agent"; } }

        /// <summary>Frames per second of game time under blind and agent. 0 under human (real time).</summary>
        public static int FixedFps
        {
            get
            {
                if (Name == "human") return 0;
                int fps;
                string v = Arg("-gam3Fps");
                return v != null && int.TryParse(v, NumberStyles.Integer, CultureInfo.InvariantCulture, out fps) && fps > 0 && fps <= 240 ? fps : 30;
            }
        }

        static Profile()
        {
            if (Name == "human") return;
            EditorApplication.playModeStateChanged += OnPlayMode;
            EditorApplication.quitting += Restore;
            if (EditorApplication.isPlaying) Apply();
        }

        static void OnPlayMode(PlayModeStateChange change)
        {
            if (change == PlayModeStateChange.EnteredPlayMode) Apply();
            else if (change == PlayModeStateChange.ExitingPlayMode) Restore();
        }

        static void Apply()
        {
            if (SessionState.GetInt(QualityKey, -1) < 0) SessionState.SetInt(QualityKey, QualitySettings.GetQualityLevel());
            if (IsAgent) QualitySettings.SetQualityLevel(0, true);
            QualitySettings.vSyncCount = 0;
            Application.targetFrameRate = -1;
            Time.captureDeltaTime = 1f / FixedFps;
            Debug.Log("GAM3PROFILE: " + Name + " quality=" + QualitySettings.names[QualitySettings.GetQualityLevel()] + " fixed_fps=" + FixedFps);
        }

        static void Restore()
        {
            Time.captureDeltaTime = 0f;
            int saved = SessionState.GetInt(QualityKey, -1);
            if (saved >= 0 && saved != QualitySettings.GetQualityLevel()) QualitySettings.SetQualityLevel(saved, true);
            SessionState.EraseInt(QualityKey);
        }

        static string Arg(string name)
        {
            string[] a = Environment.GetCommandLineArgs();
            for (int i = 0; i < a.Length - 1; i++) if (a[i] == name) return a[i + 1];
            return null;
        }
    }
}
