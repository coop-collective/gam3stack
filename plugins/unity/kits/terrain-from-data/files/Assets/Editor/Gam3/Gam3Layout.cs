// The world as data. Edit this file; Gam3.TerrainBuilder reads it and never needs to change.
// Units are metres. The terrain is centred on the origin: x and z run from -Size/2 to +Size/2.
//
// Height, RoadWeight and ClearWeight are plain functions. The builder samples them at every terrain vertex and
// writes the heights and the paint layers, so moving a road point moves the worn track, the paint and anything
// else that asks the layout (markers, scatter rules you add later).
using UnityEngine;

namespace Gam3
{
    public static class Layout
    {
        public const float Size = 256f;          // metres across
        public const int HeightRes = 513;        // heightmap vertices per side (2^n + 1)
        public const int PaintRes = 512;         // paint (alphamap) texels per side
        public const float Play = 50f;           // half size of the flat-ish middle where the game happens

        // Roads: lists of points (x, z).
        public static readonly Vector2[][] Roads =
        {
            new[] { new Vector2(-72, -29), new Vector2(-46, -22), new Vector2(-25, -15), new Vector2(-6, 1.5f), new Vector2(15, 9), new Vector2(39, 15), new Vector2(72, 25) },
            new[] { new Vector2(15, 9), new Vector2(23, 19), new Vector2(28.5f, 26.5f) },
        };
        public const float RoadHalf = 1.5f;      // full-strength half width
        public const float RoadFade = 1.9f;      // grass creeps back in over this distance

        // Trodden clearings: x, z, radius.
        public static readonly Vector3[] Clearings = { new Vector3(-25, -15, 5.2f), new Vector3(30, 29, 7.6f), new Vector3(-3, -19, 3.8f), new Vector3(6, 23, 4.2f) };

        // A flat-topped knoll (a place for a landmark): x, z, flat radius.
        public static readonly Vector3 Knoll = new Vector3(30, 29, 5.2f);

        // Named points. The builder makes an empty GameObject for each, standing on the ground.
        public static readonly (string name, float x, float z)[] Markers =
        {
            ("Spawn_Player", -27f, -16.5f), ("Landmark", 30f, 29f), ("Pack_1", -5f, -17.5f), ("Pack_2", 4.5f, 22f),
        };

        // Paint colours (linear RGB). Plain colours, so the kit needs no texture downloads.
        public static readonly Color Grass = new Color(0.36f, 0.42f, 0.16f);
        public static readonly Color Dirt = new Color(0.50f, 0.40f, 0.27f);
        public static readonly Color Trodden = new Color(0.46f, 0.44f, 0.22f);

        static float Smooth(float a, float b, float v)
        {
            float t = Mathf.Clamp01((v - a) / (b - a));
            return t * t * (3f - 2f * t);
        }

        static float SegDist(Vector2 p, Vector2 a, Vector2 b)
        {
            Vector2 d = b - a;
            float t = Mathf.Clamp01(Vector2.Dot(p - a, d) / d.sqrMagnitude);
            return (p - a - d * t).magnitude;
        }

        public static float RoadDist(float x, float z)
        {
            var p = new Vector2(x, z);
            float best = 1e9f;
            foreach (Vector2[] line in Roads)
                for (int i = 0; i + 1 < line.Length; i++) best = Mathf.Min(best, SegDist(p, line[i], line[i + 1]));
            return best;
        }

        /// <summary>1 on the road, 0 in the grass. The edge wanders so the verge is not a ruled line.</summary>
        public static float RoadWeight(float x, float z)
        {
            float wob = 0.45f * Mathf.Sin(x / 1.9f + 1.3f) * Mathf.Sin(z / 2.3f + 0.4f) + 0.25f * Mathf.Sin((x - z) / 0.9f);
            return 1f - Smooth(RoadHalf, RoadHalf + RoadFade, RoadDist(x, z) + wob);
        }

        /// <summary>1 in the middle of a clearing, 0 in standing grass.</summary>
        public static float ClearWeight(float x, float z)
        {
            float w = 0f;
            float wob = 0.7f * Mathf.Sin(x / 2.6f + 0.5f) * Mathf.Sin(z / 2.1f + 2.1f);
            foreach (Vector3 c in Clearings)
                w = Mathf.Max(w, 1f - Smooth(c.z * 0.55f, c.z, Mathf.Sqrt((x - c.x) * (x - c.x) + (z - c.y) * (z - c.y)) + wob));
            return w;
        }

        static float Rolling(float x, float z)
        {
            float h = 1.9f * Mathf.Sin(x / 23f + 0.7f) * Mathf.Cos(z / 19f - 0.3f);
            h += 0.95f * Mathf.Sin((x + z) / 9.5f + 0.4f);
            h += 0.45f * Mathf.Sin(x / 4.3f + 1.3f) * Mathf.Sin(z / 5.2f + 0.2f);
            return h;
        }

        /// <summary>Ground height in metres (world y).</summary>
        public static float Height(float x, float z)
        {
            float h = Rolling(x, z);
            float top = Rolling(Knoll.x, Knoll.y) + 1.9f;
            float k = 1f - Smooth(Knoll.z, Knoll.z + 9f, Mathf.Sqrt((x - Knoll.x) * (x - Knoll.x) + (z - Knoll.y) * (z - Knoll.y)));
            h = Mathf.Lerp(h, top, k);
            // beyond the playable middle the land rises into hills
            float r = Mathf.Max(Mathf.Abs(x), Mathf.Abs(z));
            float edge = Play + 6f;
            if (r > edge)
            {
                float t = (r - edge) / (Size * 0.5f - edge);
                h += t * t * 23f * (0.62f + 0.38f * Mathf.Sin(3f * Mathf.Atan2(z, x) + 1f));
            }
            // the road is worn a hand's width into the ground
            h -= 0.14f * RoadWeight(x, z);
            return h;
        }
    }
}
