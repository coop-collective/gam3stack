# ready-gate

Runtime code for the game itself, not for the editor. It exists because of two faults that every game ships with
until somebody removes them:

- **The world is shown before it is ready.** The level has "loaded", the cover drops, and for a few seconds the
  player watches materials pop in, textures sharpen, pieces of the map arrive and the camera jump to the player.
- **A spawned character stands in its bind pose (the "T-pose") for a frame or more** before it starts to animate.

Three small files in `Assets/Gam3/Runtime/` (assembly `Gam3.Runtime`), plus play-mode tests.

| File | Use |
| --- | --- |
| `Gam3ReadyGate.cs` | `ReadyGate`: keeps a loading cover up until the world is ready, then opens once |
| `Gam3Spawn.cs` | `Spawn.Posed` / `Spawn.ShowWhenPosed`: the first visible frame of a character is animated |
| `Gam3FirstFrames.cs` | `FirstFrames`: PNGs of the first frames after the gate opens, to check the two above |

## The gate

```csharp
var gate = ReadyGate.Begin(loadingCover);              // any GameObject; usually a full-screen canvas
gate.shaderWarmUp = new[] { levelShaderVariants };      // optional: ShaderVariantCollection assets
gate.LoadScene("Level1", LoadSceneMode.Additive);       // scene loads to wait for
var hold = gate.Hold("player");                         // anything of your own
SpawnPlayer(); hold.Dispose();
gate.AddCondition("camera", () => cameraRig.Settled);   // polled once a frame
yield return gate.WaitUntilReady();                     // or gate.Ready += ..., or await gate.WhenReady()
```

It opens when every tracked load is done, every hold is released and every condition is true, the shader
collections are warmed up, no texture mip is still streaming (when mip streaming is on), and then `settledFrames`
frames in a row were each shorter than `hitchSeconds`. It logs `GAM3READY: ok frames=<n> waited=<s>s`.

After `timeoutSeconds` (default 20) it opens anyway and logs `GAM3READY: TIMEOUT waiting=<names>`. A game must
not sit behind a cover for ever, but that line is a bug report: fix what it names.

What to put behind the gate is the game's decision. The usual list: the player exists and is posed, the camera is
where it will be, the ground under the player has its collider, generated content is generated, the first enemies
are spawned and posed, the first UI screen is built.

## The spawn

```csharp
var enemy = Spawn.Posed(prefab, position, rotation);   // instead of Instantiate
Spawn.ShowWhenPosed(pooledEnemy);                      // for an object you activate yourself (pools)
```

Unity evaluates Animators once per frame, between `Update` and `LateUpdate`. Anything that becomes visible after
that point is drawn as stored, in bind pose, until the next frame. `Spawn.Posed` evaluates the Animator at once
(`Rebind` then `Update(0)`), so the first frame drawn is the first frame of the entry state. It also covers an
Animator that would be culled where it spawns, and a pooled object that still holds the pose it died in. If the
Animator has no controller yet (the asset is still loading) the renderers stay off until it has one, or until
`giveUpSeconds` pass: then the object is shown with a `GAM3SPAWN:` warning.

## The proof

```csharp
FirstFrames.AfterGate(gate, Camera.main, 5, "Shots/first");   // Shots/first_00.png ... first_04.png
```

Renders the camera at the end of each of the first frames after the gate opens (editor and development builds
only). Open the files. Frame 0 must already look like frame 4. Overlay UI is not in a camera render, so the
files show the world exactly as it is when the cover goes away.

The tests in `Assets/Gam3/Tests/PlayMode/` run with
`node Tools/gam3/unity_run.mjs test --platform PlayMode --filter Gam3.Tests`. The spawn tests first reproduce
the fault (a plain `Instantiate` in `LateUpdate` is measured in bind pose on the frame it appears), then show
that `Spawn.Posed` removes it. Keep them, and add your own character prefab to them.

## When not to use it

- For a character driven only by a `PlayableGraph` or Timeline you build yourself: evaluate the graph before
  showing it. `Spawn` handles `Animator` controllers and the legacy `Animation` component.
- As the whole answer to pop-in. The gate waits; it does not make anything load. Shaders still need a
  `ShaderVariantCollection` (or the pipeline's own prewarming) to have something to warm up, and addressable
  assets must be tracked with `gate.Track` or a hold.

## Limits

- Tested with Unity 6000.6.5f1, built-in render pipeline, in the editor's play mode on macOS. Not run in a
  built player, under URP or HDRP, or on Windows or Linux.
- The texture streaming wait and the shader warm-up step are written against the documented API and compile, but
  the scratch project had mip streaming off and no variant collection, so neither wait was exercised.
- `Gam3.Tests.PlayMode` needs `com.unity.test-framework`. Without the package the assembly is skipped (it is
  constrained to `UNITY_INCLUDE_TESTS`). The spawn tests build their rig with editor API and are ignored in a
  player.
