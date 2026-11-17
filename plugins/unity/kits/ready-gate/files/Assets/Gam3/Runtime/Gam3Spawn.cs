// Spawn characters so that nobody ever sees them in their bind pose (the "T-pose").
//
// A skinned character is stored in its bind pose. It only takes its animated pose when its Animator evaluates, which
// Unity does once per frame, after every Update and before every LateUpdate. So a character is drawn in bind pose for
// one frame or more whenever it becomes visible after that point without being evaluated:
//   - it was instantiated or activated in LateUpdate, at the end of a frame, or from a callback that runs after the
//     animation step (physics callbacks late in the frame, async continuations, some networking callbacks);
//   - its Animator is culled (Cull Completely) because it spawned outside the view, and the camera then cuts to it;
//   - its controller or avatar is assigned later (asset loaded asynchronously), so there is nothing to evaluate yet;
//   - it came back from a pool still holding the last pose of its previous life (a corpse standing up).
//
//   var enemy = Spawn.Posed(prefab, position, rotation);   // instead of Instantiate
//   Spawn.ShowWhenPosed(pooledEnemy);                        // for an object you activate yourself
//
// Both evaluate the Animator at once (Rebind + Update(0)) so the very first frame shows the first frame of the entry
// state. If an Animator has no controller yet, its renderers stay hidden until it has one and has evaluated, or until
// `giveUpSeconds` pass (then they are shown anyway and a warning names the object: a missing controller is a bug,
// an invisible enemy is a worse one).
//
// Not covered: characters driven only by a PlayableGraph or Timeline you build yourself (evaluate the graph before
// showing them), and blend-in from an empty default state (give the controller a real entry state).
using System.Collections.Generic;
using UnityEngine;

namespace Gam3
{
    public static class Spawn
    {
        /// <summary>Instantiate a prefab and make sure its first visible frame is animated, not the bind pose.</summary>
        public static GameObject Posed(GameObject prefab, Vector3 position, Quaternion rotation, Transform parent = null, float giveUpSeconds = 2f)
        {
            GameObject instance = Object.Instantiate(prefab, position, rotation, parent);
            ShowWhenPosed(instance, giveUpSeconds);
            return instance;
        }

        /// <summary>
        /// Pose an object that is about to become visible: just instantiated, just activated, or taken from a pool.
        /// Returns true when it is posed and visible now, false when it stays hidden until its Animator can evaluate.
        /// </summary>
        public static bool ShowWhenPosed(GameObject instance, float giveUpSeconds = 2f)
        {
            if (!instance.activeInHierarchy) instance.SetActive(true);
            Animator[] animators = instance.GetComponentsInChildren<Animator>(false);
            bool allPosed = true;
            foreach (Animator a in animators) allPosed &= Evaluate(a);
            foreach (Animation legacy in instance.GetComponentsInChildren<Animation>(false))
            {
                if (legacy.clip == null) continue;
                if (!legacy.isPlaying) legacy.Play();
                legacy.Sample();
            }
            if (allPosed) return true;

            var hidden = new List<Renderer>();
            foreach (Renderer r in instance.GetComponentsInChildren<Renderer>(false)) if (r.enabled) { r.enabled = false; hidden.Add(r); }
            PoseGuard guard = instance.AddComponent<PoseGuard>();
            guard.Init(animators, hidden, giveUpSeconds);
            return false;
        }

        /// <summary>Evaluate now. False when the Animator has nothing to evaluate yet.</summary>
        internal static bool Evaluate(Animator a)
        {
            if (!a.enabled) return true;                          // not animated: the pose it has is the pose intended
            if (a.runtimeAnimatorController == null) return false;
            AnimatorCullingMode mode = a.cullingMode;
            a.cullingMode = AnimatorCullingMode.AlwaysAnimate;    // a culled Animator does not write its pose
            a.Rebind();                                           // start of the entry state, also for a pooled object
            a.Update(0f);
            a.cullingMode = mode;
            return true;
        }

        /// <summary>Keeps renderers off until every Animator has evaluated. Removes itself.</summary>
        sealed class PoseGuard : MonoBehaviour
        {
            Animator[] animators;
            List<Renderer> hidden;
            float showAt;

            public void Init(Animator[] animators, List<Renderer> hidden, float giveUpSeconds)
            {
                this.animators = animators;
                this.hidden = hidden;
                showAt = Time.realtimeSinceStartup + giveUpSeconds;
            }

            // LateUpdate, not Update: a controller assigned during this frame's Update is picked up the same frame.
            void LateUpdate()
            {
                bool posed = true;
                foreach (Animator a in animators) if (a != null) posed &= Evaluate(a);
                bool gaveUp = !posed && Time.realtimeSinceStartup >= showAt;
                if (!posed && !gaveUp) return;
                if (gaveUp) Debug.LogWarning("GAM3SPAWN: " + name + " shown without an animated pose: an Animator still has no controller", this);
                foreach (Renderer r in hidden) if (r != null) r.enabled = true;
                Destroy(this);
            }
        }
    }
}
