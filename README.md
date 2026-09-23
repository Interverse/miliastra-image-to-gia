# GIA Pixel Builder

A small Vite + React + TypeScript website that converts a PNG into a `.gia`
file made from UI image primitives directly in the browser.

## Stack

- **Vite**
- **React + TypeScript**
- **protobuf.js** for `.proto` handling in the browser
- **Web Worker** so generation does not block the UI
- **Vitest** for the `.gia` format regression tests

## Features

- Upload a PNG
- Choose an optimization mode
- Visible controls for:
  - optimization mode
  - pixel size
  - image rotation
- Advanced Settings dropdown for everything else
- Two export targets from one conversion: **Server Image** and **Client Image**
- Mobile-friendly single-page layout
- Static-site friendly for **GitHub Pages**

## Server Image and Client Image

One click on **Generate .gia** runs the pixel pipeline once and writes the
result twice, as two different Control Templates:

| | Download | Written for |
|---|---|---|
| **Download Server Image** | `<name>.gia` | Server Control Template |
| **Download Client Image** | `<name>_client.gia` | Client Control Template |

Both describe the same picture: the same optimizer output, the same pixel
layout, colors, dimensions, transforms, object GUIDs and — importantly — the
same image resource IDs (square `100001`, circle `100002`). Only the `.gia`
record structure and the hierarchy direction differ.

The two Control Templates composite their children in opposite directions:

```
Server: earlier in hierarchy -> rendered later -> on top of later siblings
Client: earlier in hierarchy -> rendered first -> behind later siblings
```

A background primitive therefore has to come **first** in a Client hierarchy
and **last** in a Server one, so the generated Client child list is the Server
child list reversed. Object identity follows the rectangle rather than the
hierarchy slot, so the same rectangle keeps one GUID and one name in both
files. `exportLayerOrder` names the Server hierarchy order and flips both
exports together, so the two files always resolve to the same picture.

The pipeline is split so neither exporter re-derives the picture:

```
Image Processing ─► ImagePlan ─┬─► Server .gia serializer   (src/lib/gia.ts)
   (optimizer.ts)  (imagePlan)  └─► Client .gia serializer   (src/lib/giaClient.ts)
```

- `src/lib/imagePlan.ts` — the logical image representation: object identity,
  names, image resource IDs, colors and transforms.
- `src/lib/giaCommon.ts` — the `.gia` container, the field-501 envelope
  helpers, and the single authoritative image-resource ID table.
- `src/lib/pbraw.ts` — a lossless protobuf codec. The Client template carries
  fields that `gia_with_ui_rotation_v6.proto` does not declare, and protobuf.js
  drops undeclared fields on decode, so the Client exporter patches the
  supplied reference at the raw-field level and preserves everything else
  untouched.
- `src/lib/giaInspect.ts` — decodes either format into one model. It validates
  the Client bundle before the download is offered, and lets the Server/Client
  comparison tests assert on decoded structure rather than raw bytes.

The Client exporter refuses to emit a bundle that still carries the reference
file's placeholder container name (`Image Container`) or that fails validation,
rather than producing a malformed `.gia`.

Field-by-field findings are in `docs/client-gia-format.md`.

## Quick start

```bash
npm install
npm run dev
```

Then open the local URL shown by Vite.

## Tests

```bash
npm test
```

- `tests/clientReference.test.ts` — regression tests against the supplied
  Client Control Template reference, including the known `Circle = Square + 100`
  X-offset anchor.
- `tests/serverRegression.test.ts` — proves the Server exporter is
  byte-identical to the implementation from before the Server/Client split.
- `tests/serverVsClient.test.ts` — the same image through both exporters across
  1×1, multicolour, transparent, merged, square/circle/mixed and large cases,
  plus compositing tests that repaint each generated bundle under its own draw
  order and compare it against the source pixels.

## Production build

```bash
npm run build
npm run preview
```

The built site will be in `dist/`.

## GitHub Pages deployment

This repo includes a GitHub Actions workflow.

1. Push this project to a GitHub repo.
2. In GitHub, open **Settings → Pages**.
3. Set **Build and deployment** to **GitHub Actions**.
4. Push to `main`.

The workflow will build and deploy the site automatically.

## Important bundled files

Placed in `public/`:

- `gia_with_ui_rotation_v6.proto` — schema used by the Server exporter
- `template.gia` — Server Control Template structural template
- `client-template.gia` — Client Control Template structural template, the
  supplied reference file verbatim; it doubles as the test fixture

If you want to swap in a newer schema or template, replace those files and run
`npm test`. The Server regression tests assert the container GUID both
exporters build their object IDs from, so a mismatched template fails loudly
instead of silently producing divergent IDs.

## Notes

The current rectangle optimizer is a browser port intended to be practical and
easy to host. If you later want parity with your newest Python heuristics, the
best next step would be porting specific merge strategies one by one into
`src/lib/optimizer.ts`.

`RectPlan` carries an optional `shape` (`square` | `circle` | `triangle`) that
both exporters honour through the shared ID table. The optimizer currently only
emits squares, so mixed primitives are available to the format layer but not
yet surfaced as a conversion option.
