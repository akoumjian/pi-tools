# tool-display

## Purpose

Opt-in display wrapper for `document_parse` (and any future bundled tool wrapper). Replaces the stock LiteParse rendering with a compact `Parse(...)` call row and a single-line success/error result row, without changing the underlying tool behavior. Defaults to **off** so the wrapper is transparent until explicitly enabled.

## Provides

- `document_parse` tool registration that proxies through to LiteParse's `pi-docparser` implementation.
- `/docparser:doctor` command (always registered) for diagnosing missing host parser dependencies (Tesseract, libreoffice/soffice, ghostscript, ImageMagick, etc.).
- Optional compact `Parse(...)` renderer and `⎿ ... · pages · screenshots ...` result row when `enableDisplayOverrides` is `true`.
- Compact `⎿ error: ...` row on tool errors when overrides are enabled (otherwise Pi falls back to its default error rendering).

## Tool schema

```ts
document_parse({
  path: string,                                  // file to parse: PDF, DOCX, PPTX, XLSX, CSV, PNG, JPG, TIFF, WebP, ...
  format?: "text" | "json",                      // default "text"
  targetPages?: string,                          // e.g. "1-5,10,15-20"
  screenshotPages?: string,                      // PDF only, e.g. "1-3,8" or "all"
  ocr?: "auto" | "off",                          // default "auto"
  ocrLanguage?: string,                          // ISO 639-3 code, e.g. "eng"
  ocrLanguages?: string[],                       // multiple languages
  ocrServerUrl?: string,                         // remote LiteParse OCR API
  numWorkers?: number,                           // >= 1
  maxPages?: number,                             // >= 1
  dpi?: number,                                  // >= 72
  preciseBoundingBox?: boolean,
  preserveSmallText?: boolean,
  preserveLayoutAlignmentAcrossPages?: boolean
})
```

## Behavior

1. On load, the extension reads [`config/tool-display-settings.json`](../../config/tool-display-settings.json):
   ```json
   { "enableDisplayOverrides": false }
   ```
2. It registers a `document_parse` tool that delegates `execute` to the real LiteParse `pi-docparser` tool. When `enableDisplayOverrides` is `true`, it also adds the compact `renderCall`/`renderResult` functions; when `false`, Pi uses default rendering and the wrapper is invisible.
3. It registers `/docparser:doctor` unconditionally, exposing the LiteParse-shipped diagnostics command for host dependency checks.
4. The compact result row shows page count, screenshot count, and the number of warnings (if any), in `⎿ ...` format.
5. The error renderer (also opt-in) shows `⎿ error: <one-line truncated content>` on tool errors instead of dumping the raw error text.

## Setup

1. Install LiteParse runtime dependencies you intend to use. Run `/docparser:doctor` for guided diagnosis; it reports missing binaries and suggests install steps.
2. Optional: turn on the compact renderer by editing `tool-display-settings.json`:
   ```json
   { "enableDisplayOverrides": true }
   ```
   No restart required for the next call rendering, but Pi must reload settings (typically by restart or by running a setup command).
3. To use a remote OCR server, pass `ocrServerUrl` per call or wire it into a higher-level workflow.

## Notes

- The wrapper keeps LiteParse's execution behavior and output shape while providing explicit `document_parse` model guidance and, when enabled, compact renderers.
- Output files for parsed documents (text, JSON, screenshots) are saved by LiteParse to temp locations. Use `read_many` on the returned `outputPath`/screenshot paths when the in-call preview is insufficient.
- See also [native-tools](native-tools.md) for the `read_many` follow-up.
