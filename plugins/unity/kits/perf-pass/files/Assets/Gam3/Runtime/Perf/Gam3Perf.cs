// Frame times, split into labelled segments.
//
//   Perf.Begin();                 // start recording (the scenario runner does this when the ready gate opens)
//   Perf.Mark("boss/enter");      // everything from this frame on belongs to this label, until the next Mark
//   Perf.End(path);               // stop and write the report
//
// Mark costs nothing when nothing is recording, so the game can leave its marks in: call it where a wave starts,
// where an ability fires, where a level section begins. A performance run of the game playing itself is then
// split into the same parts the game is made of, and a slow part has a name.
//
// What is measured is the real duration of each frame (Time.unscaledDeltaTime). The frame in which Mark is called
// belongs to the new label, so the cost of a spawn made right after a Mark lands in that label's first frame.
// Where the engine reports them (FrameTimingManager: a built player with Frame Timing Stats on, and the editor on
// most graphics APIs), main thread, render thread and GPU times are averaged per segment as well. Those arrive a
// few frames late, so on a segment shorter than a few frames they are not reliable.
//
// Never record under a fixed capture time step: Begin refuses, because the numbers would say nothing about speed.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using UnityEngine;

namespace Gam3
{
    public static class Perf
    {
        /// <summary>The worst frame within this long after a Mark is the segment's first_ms: the hitch of a first use.</summary>
        public const float FirstWindowSeconds = 0.1f;

        /// <summary>A frame longer than this many milliseconds counts as a hitch. Set by the runner: twice the frame budget.</summary>
        public static float HitchMs = 33.4f;

        public static bool Recording { get { return probe != null && probe.recording; } }

        static PerfProbe probe;

        /// <summary>Start recording. Returns false (and logs why) under a fixed capture time step.</summary>
        public static bool Begin(string firstLabel = "start")
        {
            if (Time.captureDeltaTime != 0f)
            {
                Debug.LogError("GAM3PERF_ERROR: a fixed capture time step is on (Time.captureDeltaTime). Frame times mean nothing under it; run at the human profile.");
                return false;
            }
            if (probe == null)
            {
                var go = new GameObject("Gam3PerfProbe");
                UnityEngine.Object.DontDestroyOnLoad(go);
                go.hideFlags = HideFlags.HideAndDontSave;
                probe = go.AddComponent<PerfProbe>();
            }
            probe.StartRecording(firstLabel);
            return true;
        }

        /// <summary>Start a new segment. Does nothing when not recording.</summary>
        public static void Mark(string label)
        {
            if (probe != null && probe.recording) probe.Mark(label);
        }

        /// <summary>Stop recording and write the report (JSON). `extra` is raw JSON members to add, or null.</summary>
        public static void End(string path, string extra = null)
        {
            if (probe == null) return;
            probe.recording = false;
            string json = probe.Report(extra);
            if (!string.IsNullOrEmpty(path))
            {
                Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path)));
                File.WriteAllText(path, json);
            }
        }
    }

    /// <summary>Runs before everything else in the frame, so a frame's time is charged to the label that was current during it.</summary>
    [DefaultExecutionOrder(-32000)]
    public sealed class PerfProbe : MonoBehaviour
    {
        sealed class Segment
        {
            public string label;
            public float startedAt;
            public readonly List<float> ms = new List<float>();
            public float firstMs;
            public int hitches;
            public double mainSum, renderSum, gpuSum;
            public int timingFrames;
        }

        [NonSerialized] public bool recording;
        readonly List<Segment> segments = new List<Segment>();
        Segment current;
        bool skipNext;
        float startedAt;
        readonly FrameTiming[] timing = new FrameTiming[1];

        public void StartRecording(string label)
        {
            segments.Clear();
            current = null;
            recording = true;
            skipNext = true;            // the frame Begin was called in started before the recording did
            startedAt = Time.realtimeSinceStartup;
            Mark(label);
        }

        public void Mark(string label)
        {
            current = new Segment { label = label, startedAt = Time.realtimeSinceStartup };
            segments.Add(current);
        }

        void Update()
        {
            if (!recording || current == null) return;
            if (skipNext) { skipNext = false; return; }
            // The duration of the frame that has just ended. Nothing has run yet in this frame, so `current` is
            // still the label that frame ended under.
            float ms = Time.unscaledDeltaTime * 1000f;
            Segment s = current;
            // A frame that began before the Mark (the Mark was made late in it) still belongs to the new label:
            // that frame is where the spawn after the Mark was paid for.
            s.ms.Add(ms);
            if (Time.realtimeSinceStartup - s.startedAt - ms / 1000f <= Perf.FirstWindowSeconds && ms > s.firstMs) s.firstMs = ms;
            if (ms > Perf.HitchMs) s.hitches++;

            FrameTimingManager.CaptureFrameTimings();
            if (FrameTimingManager.GetLatestTimings(1, timing) > 0 && timing[0].cpuFrameTime > 0)
            {
                s.mainSum += timing[0].cpuMainThreadFrameTime;
                s.renderSum += timing[0].cpuRenderThreadFrameTime;
                s.gpuSum += timing[0].gpuFrameTime;
                s.timingFrames++;
            }
        }

        static string F(double v) { return v.ToString("0.###", CultureInfo.InvariantCulture); }

        static string Q(string s)
        {
            var b = new StringBuilder("\"");
            foreach (char c in s ?? "")
            {
                if (c == '"' || c == '\\') b.Append('\\').Append(c);
                else if (c < 0x20) b.Append(' ');
                else b.Append(c);
            }
            return b.Append('"').ToString();
        }

        static float Percentile(List<float> sorted, float p)
        {
            if (sorted.Count == 0) return 0f;
            int i = Mathf.Clamp(Mathf.CeilToInt(p * sorted.Count) - 1, 0, sorted.Count - 1);
            return sorted[i];
        }

        public string Report(string extra)
        {
            var b = new StringBuilder();
            b.Append("{\n");
            b.Append(" \"unity\": ").Append(Q(Application.unityVersion)).Append(",\n");
            b.Append(" \"player\": ").Append(Application.isEditor ? "false" : "true").Append(",\n");
            b.Append(" \"graphics\": ").Append(Q(SystemInfo.graphicsDeviceType.ToString())).Append(",\n");
            b.Append(" \"device\": ").Append(Q(SystemInfo.graphicsDeviceName)).Append(",\n");
            b.Append(" \"quality\": ").Append(Q(QualitySettings.names.Length > 0 ? QualitySettings.names[QualitySettings.GetQualityLevel()] : "")).Append(",\n");
            b.Append(" \"seconds\": ").Append(F(Time.realtimeSinceStartup - startedAt)).Append(",\n");
            b.Append(" \"hitch_ms\": ").Append(F(Perf.HitchMs)).Append(",\n");
            if (!string.IsNullOrEmpty(extra)) b.Append(' ').Append(extra).Append(",\n");
            b.Append(" \"segments\": [\n");
            bool first = true;
            foreach (Segment s in segments)
            {
                if (s.ms.Count == 0) continue;
                var sorted = new List<float>(s.ms);
                sorted.Sort();
                double sum = 0;
                foreach (float v in sorted) sum += v;
                if (!first) b.Append(",\n");
                first = false;
                b.Append("  {\"label\": ").Append(Q(s.label));
                b.Append(", \"frames\": ").Append(s.ms.Count);
                b.Append(", \"avg_ms\": ").Append(F(sum / s.ms.Count));
                b.Append(", \"p50_ms\": ").Append(F(Percentile(sorted, 0.5f)));
                b.Append(", \"p99_ms\": ").Append(F(Percentile(sorted, 0.99f)));
                b.Append(", \"max_ms\": ").Append(F(sorted[sorted.Count - 1]));
                b.Append(", \"first_ms\": ").Append(F(s.firstMs));
                b.Append(", \"hitches\": ").Append(s.hitches);
                if (s.timingFrames > 0)
                {
                    b.Append(", \"main_ms\": ").Append(F(s.mainSum / s.timingFrames));
                    b.Append(", \"render_ms\": ").Append(F(s.renderSum / s.timingFrames));
                    if (s.gpuSum > 0) b.Append(", \"gpu_ms\": ").Append(F(s.gpuSum / s.timingFrames));
                }
                b.Append('}');
            }
            b.Append("\n ],\n");
            // Everything that was measured on purpose: "idle" and "gap" are the pauses between the parts.
            var all = new List<float>();
            int hitches = 0;
            foreach (Segment s in segments)
            {
                if (s.label == "idle" || s.label == "gap") continue;
                all.AddRange(s.ms);
                hitches += s.hitches;
            }
            all.Sort();
            double total = 0;
            foreach (float v in all) total += v;
            b.Append(" \"total\": {\"frames\": ").Append(all.Count);
            b.Append(", \"avg_ms\": ").Append(F(all.Count > 0 ? total / all.Count : 0));
            b.Append(", \"p99_ms\": ").Append(F(Percentile(all, 0.99f)));
            b.Append(", \"max_ms\": ").Append(F(all.Count > 0 ? all[all.Count - 1] : 0));
            b.Append(", \"hitches\": ").Append(hitches).Append("}\n}\n");
            return b.ToString();
        }
    }
}
