# Image fixture

`color-pattern.jpg` is a synthetic 1600 × 900 RGB image with color gradients and
alternating tiles, encoded as JPEG at quality 90. It contains no business data
and is independent of Skill assets.

The provider and read-tool tests share it to exercise JPEG preservation, PNG
selection after resizing, coordinate scaling, and the Feishu image profile.
Its dimensions exceed the Feishu profile's 1024-pixel limit but fit the read
profile's 2000-pixel limit. After enlargement to 2600 pixels, a resized PNG fits
the read payload budget while a JPEG at the same dimensions is smaller; keep
those properties when replacing this fixture.
