---
description: Run the game unattended and show screenshots of a level.
argument-hint: "<map> [seconds]"
---

Load the `unreal-editor-loop` skill. Run `node Tools/gam3/ue_game.mjs --map <map> --shots <t> --quit <t+2>` from
the project directory, with the map and time from `$ARGUMENTS` (default time 6 seconds). Read the PNGs it prints
and describe what they show. Report the `GAM3GAME:` line. If the `shot-director` kit is missing, say so and offer
to install it.
