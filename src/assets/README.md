# Michi ToDo artwork

`app-icon-source.png` is the selected image generated with the built-in ImageGen
tool on 2026-10-30. The original image is retained without creative edits.
`node scripts/prepare-icons.cjs` uses Electron nativeImage to resize it for the
favicon, Apple touch icon, PWA, desktop window/tray, and Windows ICO frames.

Final workspace source:
`C:\Users\newmi\programming\todo-sync\src\assets\app-icon-source.png`

Original built-in output:
`C:\Users\newmi\.codex\generated_images\01a18d40-1fd4-7420-bba1-0a49a0861ef5\exec-d1db90ad-02ed-4f59-8f27-777a86cbed4a.png`

Final prompt:

> Use case: logo-brand. Asset type: production favicon and Windows desktop application icon for a Japanese ToDo app. Create ONE standalone square 1024x1024 icon. The entire canvas is one completely opaque solid deep forest green color #2e6851, filling all the way to every edge. Center a single large bold rounded off-white checkmark #f7f8fa, rising confidently like a forward path. The checkmark spans about 68 percent of the image width and has thick strokes and rounded terminals. Extremely simple flat two-color graphic with precise crisp edges, high contrast, readable at 16 pixels. No transparency anywhere. No letters, text, border, mockup, extra objects, holes, texture, gradients, shadows, reflections, or empty black/white surrounding backdrop. A single full-bleed green square with a white checkmark.

The generated source is 1254 × 1254 pixels; the derived outputs have the exact
dimensions encoded in their names. ICO contains 16, 32, 48, and 256 pixel frames.
Every ICO frame uses a 40-byte BITMAPINFOHEADER, bottom-up 32-bit BGRA pixels,
and a DWORD-aligned 1-bit AND mask. Classic uncompressed DIB frames are used
instead of PNG-compressed frames for compatibility with Windows icon loaders.

Sound effect source and licensing are recorded in `sounds/LICENSE.txt` and
`sounds/Kenney-LICENSE.txt`.
