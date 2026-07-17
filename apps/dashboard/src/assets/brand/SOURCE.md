# LXE Agent brand assets

- `lxe-agent-logo.png` is derived from the user-provided application icon
  supplied on 2026-07-17. The original squirrel, acorn, palette, gradients,
  spacing, and rounded white container are preserved; only the opaque black
  pixels outside the container were replaced with transparency.
- `lxe-agent-tray-source.png` is the approved compact tray derivative. It keeps
  the squirrel and acorn without the white tile and adds a restrained light
  keyline for legibility on light and dark Windows taskbars.

Both masters were prepared with OpenAI built-in image editing followed by local
chroma-key removal. Run `uv run python scripts/generate-brand-assets.py` to
normalize the masters and regenerate the desktop PNG, ICO, and Template Image
variants.
