// Pay every first-use cost while the loading cover is up, so nothing hitches the first time a player sees it.
//
// The first time a prefab is used, the engine does work it never does again: it compiles and uploads the shader
// variants the prefab draws with, uploads meshes and textures, runs the one-time set-up in its scripts (static
// tables, pools, lazily built data) and compiles the code paths it calls for the first time. On the frame an
// effect first fires, that work is a visible stall. Prewarm does it early:
//
//   var gate = ReadyGate.Begin(cover);
//   Prewarm.Run(this, prefabsSpawnedDuringPlay, gate, shaderCollections);   // holds the gate as "prewarm"
//   yield return gate.WaitUntilReady();
//
// Each prefab is instantiated once far away from the level, in front of a small camera of its own, and drawn for a
// few frames, then destroyed. Out of view is not enough: an object that is never drawn never compiles its shaders,
// which is why the camera is there. Particle systems are advanced so the particles themselves are drawn.
//
// The prefab's own scripts run (Awake, OnEnable, Start), which is the point, but it also means a prefab that plays
// a sound, deals damage or reports to an analytics service on spawn will do that during loading. Give those a way
// to tell (Prewarm.Running is true while this runs) or keep them out of the list.
//
// One line reports it:  GAM3PREWARM: ok items=<n> seconds=<s>
// Prove it with the test room: `unity_perf.mjs --scenario room` fails a subject that hitches on first use, and the
// same run with --prewarm shows whether prewarming cures it.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using UnityEngine;

namespace Gam3
{
    public static class Prewarm
    {
        /// <summary>True while a prewarm is spawning things. Scripts on prewarmed prefabs can read it to stay silent.</summary>
        public static bool Running { get; private set; }

        /// <summary>Where the prewarmed objects are put: far below the world, away from anything the level draws.</summary>
        public static Vector3 Place = new Vector3(0f, -20000f, 0f);

        /// <summary>
        /// Start prewarming on `host`. With a gate, the gate stays closed (hold "prewarm") until it is done.
        /// `framesEach` is how many frames each prefab is drawn for.
        /// </summary>
        public static Coroutine Run(MonoBehaviour host, IList<GameObject> prefabs, ReadyGate gate = null,
            IList<ShaderVariantCollection> shaders = null, int framesEach = 3)
        {
            IDisposable hold = gate != null ? gate.Hold("prewarm") : null;
            return host.StartCoroutine(Work(prefabs, shaders, hold, Mathf.Max(1, framesEach)));
        }

        static IEnumerator Work(IList<GameObject> prefabs, IList<ShaderVariantCollection> shaders, IDisposable hold, int framesEach)
        {
            float t0 = Time.realtimeSinceStartup;
            int items = 0;
            Running = true;
            var camGo = new GameObject("Gam3PrewarmCamera") { hideFlags = HideFlags.HideAndDontSave };
            var rt = new RenderTexture(64, 64, 16);
            Camera cam = camGo.AddComponent<Camera>();
            cam.enabled = false;                        // drawn by hand, into its own small texture
            cam.targetTexture = rt;
            cam.clearFlags = CameraClearFlags.SolidColor;
            cam.transform.position = Place - Vector3.forward * 8f;
            cam.transform.rotation = Quaternion.identity;
            cam.farClipPlane = 100f;
            try
            {
                if (shaders != null)
                {
                    foreach (ShaderVariantCollection c in shaders)
                    {
                        if (c == null) continue;
                        if (!c.isWarmedUp) c.WarmUp();
                        items++;
                        yield return null;
                    }
                }
                if (prefabs != null)
                {
                    foreach (GameObject prefab in prefabs)
                    {
                        if (prefab == null) continue;
                        GameObject o = UnityEngine.Object.Instantiate(prefab, Place, Quaternion.identity);
                        foreach (ParticleSystem ps in o.GetComponentsInChildren<ParticleSystem>(true))
                        {
                            if (ps.transform.parent != null && ps.transform.parent.GetComponentInParent<ParticleSystem>() != null) continue;
                            ps.Simulate(0.25f, true, true);
                            ps.Play(true);
                        }
                        for (int f = 0; f < framesEach; f++)
                        {
                            cam.Render();
                            yield return null;
                        }
                        UnityEngine.Object.Destroy(o);
                        items++;
                        yield return null;
                    }
                }
            }
            finally
            {
                Running = false;
                cam.targetTexture = null;
                UnityEngine.Object.Destroy(camGo);
                rt.Release();
                UnityEngine.Object.Destroy(rt);
                if (hold != null) hold.Dispose();
            }
            Debug.Log("GAM3PREWARM: ok items=" + items + " seconds=" + (Time.realtimeSinceStartup - t0).ToString("0.00", CultureInfo.InvariantCulture));
        }
    }
}
