// Build a Terrain from Gam3.Layout: heights, three paint layers (grass, road dirt, trodden ground), markers,
// a sun and a camera. Run it again after editing the layout; it rebuilds the same scene and assets in place.
//
//   node Tools/gam3/unity_run.mjs exec Gam3.TerrainBuilder.Build [-- -gam3Scene Assets/Gam3World/World.unity]
//
// Writes the scene, a TerrainData asset, three TerrainLayer assets and three small colour textures next to the scene.
// Prints "GAM3TERRAIN: ..." with the height range. Also in the menu: Tools > Gam3 > Build Terrain From Layout.
using System;
using System.IO;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace Gam3
{
    public static class TerrainBuilder
    {
        const string DefaultScene = "Assets/Gam3World/World.unity";

        [MenuItem("Tools/Gam3/Build Terrain From Layout")]
        public static void Build()
        {
            try
            {
                string scenePath = Arg("-gam3Scene") ?? DefaultScene;
                if (!scenePath.StartsWith("Assets/") || !scenePath.EndsWith(".unity")) throw new ArgumentException("-gam3Scene must be Assets/.../Name.unity");
                string folder = Path.GetDirectoryName(scenePath).Replace('\\', '/');
                Directory.CreateDirectory(folder);
                AssetDatabase.Refresh();

                var scene = EditorSceneManager.NewScene(NewSceneSetup.DefaultGameObjects, NewSceneMode.Single);

                // ---- heights: sample the layout at every vertex
                int n = Layout.HeightRes;
                float half = Layout.Size * 0.5f;
                var metres = new float[n, n];
                float lo = float.MaxValue, hi = float.MinValue;
                for (int iz = 0; iz < n; iz++)
                {
                    float z = -half + Layout.Size * iz / (n - 1);
                    for (int ix = 0; ix < n; ix++)
                    {
                        float x = -half + Layout.Size * ix / (n - 1);
                        float h = Layout.Height(x, z);
                        metres[iz, ix] = h;
                        if (h < lo) lo = h;
                        if (h > hi) hi = h;
                    }
                }
                float range = Mathf.Max(1f, hi - lo);
                var heights = new float[n, n];           // Unity wants 0..1, indexed [z, x]
                for (int iz = 0; iz < n; iz++)
                    for (int ix = 0; ix < n; ix++) heights[iz, ix] = (metres[iz, ix] - lo) / range;

                string dataPath = folder + "/TerrainData.asset";
                var data = AssetDatabase.LoadAssetAtPath<TerrainData>(dataPath);
                if (data == null)
                {
                    data = new TerrainData();
                    AssetDatabase.CreateAsset(data, dataPath);
                }
                data.heightmapResolution = n;            // set before size: changing it resets size
                data.size = new Vector3(Layout.Size, range, Layout.Size);
                data.SetHeights(0, 0, heights);

                // ---- paint: grass everywhere, dirt on the road, trodden ground in the clearings
                data.terrainLayers = new[]
                {
                    Layer(folder, "Grass", Layout.Grass), Layer(folder, "Dirt", Layout.Dirt), Layer(folder, "Trodden", Layout.Trodden),
                };
                int m = Layout.PaintRes;
                data.alphamapResolution = m;
                var paint = new float[m, m, 3];          // [z, x, layer], the layers of one texel sum to 1
                for (int iz = 0; iz < m; iz++)
                {
                    float z = -half + Layout.Size * (iz + 0.5f) / m;
                    for (int ix = 0; ix < m; ix++)
                    {
                        float x = -half + Layout.Size * (ix + 0.5f) / m;
                        float road = Layout.RoadWeight(x, z);
                        float clear = Layout.ClearWeight(x, z) * (1f - road);
                        paint[iz, ix, 1] = road;
                        paint[iz, ix, 2] = clear;
                        paint[iz, ix, 0] = 1f - road - clear;
                    }
                }
                data.SetAlphamaps(0, 0, paint);
                EditorUtility.SetDirty(data);

                GameObject go = Terrain.CreateTerrainGameObject(data);
                go.name = "Terrain";
                go.transform.position = new Vector3(-half, lo, -half);   // origin in the middle, y in real metres
                var terrain = go.GetComponent<Terrain>();
                terrain.basemapDistance = 2000f;         // keep full paint detail at any distance (the far "basemap" is blurry)
                terrain.heightmapPixelError = 2f;
                if (terrain.materialTemplate == null)
                {
                    var rp = UnityEngine.Rendering.GraphicsSettings.defaultRenderPipeline;
                    terrain.materialTemplate = rp != null ? rp.defaultTerrainMaterial : AssetDatabase.GetBuiltinExtraResource<Material>("Default-Terrain-Standard.mat");
                }

                // ---- markers stand on the ground the layout describes
                var root = new GameObject("Markers");
                foreach (var mk in Layout.Markers)
                {
                    var p = new GameObject(mk.name);
                    p.transform.SetParent(root.transform);
                    p.transform.position = new Vector3(mk.x, Layout.Height(mk.x, mk.z), mk.z);
                }

                // ---- a low sun from the side and a three-quarter camera on the first marker
                foreach (Light l in UnityEngine.Object.FindObjectsByType<Light>(FindObjectsSortMode.None))
                {
                    if (l.type != LightType.Directional) continue;
                    l.transform.rotation = Quaternion.Euler(32f, 125f, 0f);
                    l.color = new Color(1f, 0.93f, 0.8f);
                    l.intensity = 1.3f;
                }
                Camera cam = Camera.main;
                if (cam != null && Layout.Markers.Length > 0)
                {
                    var f = Layout.Markers[0];
                    var target = new Vector3(f.x, Layout.Height(f.x, f.z), f.z);
                    Quaternion rot = Quaternion.Euler(42f, 45f, 0f);
                    cam.transform.rotation = rot;
                    cam.transform.position = target - rot * Vector3.forward * 30f;
                    cam.fieldOfView = 46f;
                    cam.farClipPlane = 2000f;
                }

                EditorSceneManager.SaveScene(scene, scenePath);
                AssetDatabase.SaveAssets();
                Debug.Log(string.Format("GAM3TERRAIN: {0} {1}x{1} vertices, {2} m across, y {3:F1}..{4:F1} m, markers {5}", scenePath, n, Layout.Size, lo, hi, Layout.Markers.Length));
            }
            catch (Exception e)
            {
                Debug.LogError("GAM3TERRAIN: FAILED " + e);
                if (Application.isBatchMode) EditorApplication.Exit(1);
            }
        }

        /// <summary>A TerrainLayer of one plain colour (a small grainy texture asset), created once and updated in place.</summary>
        static TerrainLayer Layer(string folder, string name, Color colour)
        {
            string texPath = folder + "/" + name + "_Colour.asset";
            const int size = 64;
            var tex = AssetDatabase.LoadAssetAtPath<Texture2D>(texPath);
            if (tex == null || tex.width != size)
            {
                if (tex != null) AssetDatabase.DeleteAsset(texPath);
                tex = new Texture2D(size, size, TextureFormat.RGBA32, true, true) { name = name + "_Colour", wrapMode = TextureWrapMode.Repeat };
                AssetDatabase.CreateAsset(tex, texPath);
            }
            // A little grain so the ground does not read as flat paint. Alpha is smoothness in the terrain shader: keep it 0.
            var rng = new System.Random(name.Length * 7919 + name[0]);   // fixed seed: the same texture on every build
            var px = new Color[size * size];
            for (int i = 0; i < px.Length; i++)
            {
                float k = 0.86f + 0.28f * (float)rng.NextDouble();
                px[i] = new Color(colour.r * k, colour.g * k, colour.b * k, 0f);
            }
            tex.SetPixels(px);
            tex.Apply(true);
            EditorUtility.SetDirty(tex);

            string layerPath = folder + "/" + name + ".terrainlayer";
            var layer = AssetDatabase.LoadAssetAtPath<TerrainLayer>(layerPath);
            if (layer == null)
            {
                layer = new TerrainLayer();
                AssetDatabase.CreateAsset(layer, layerPath);
            }
            layer.diffuseTexture = tex;
            layer.tileSize = new Vector2(3f, 3f);
            layer.smoothness = 0f;
            layer.metallic = 0f;
            EditorUtility.SetDirty(layer);
            return layer;
        }

        static string Arg(string name)
        {
            string[] a = Environment.GetCommandLineArgs();
            for (int i = 0; i < a.Length - 1; i++) if (a[i] == name) return a[i + 1];
            return null;
        }
    }
}
