# Precompiled LXE Skill CLI runtimes

`python scripts/build-lxeskill-bundle.py` writes the native build for the current
host to `vendor/<platform>-<arch>/lxeskill/`. Generated runtime files are not
committed; release packaging must build each target on that target operating
system and place the resulting directory here before producing the artifact.
