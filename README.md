# GIA Pixel Builder

A small Vite + React + TypeScript website that converts a PNG into a `.gia` file made from square UI shapes directly in the browser.

## Stack

- **Vite**
- **React + TypeScript**
- **protobuf.js** for `.proto` handling in the browser
- **Web Worker** so generation does not block the UI

## Features

- Upload a PNG
- Choose an optimization mode
- Visible controls for:
  - optimization mode
  - pixel size
  - image rotation
- Advanced Settings dropdown for everything else
- Disabled download button until `.gia` generation finishes
- Mobile-friendly single-page layout
- Static-site friendly for **GitHub Pages**

## Quick start

```bash
npm install
npm run dev
```

Then open the local URL shown by Vite.

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

- `gia_with_ui_rotation_v6.proto`
- `template.gia`

If you want to swap in a newer schema or template, replace those files.

## Notes

The current rectangle optimizer is a browser port intended to be practical and easy to host. If you later want parity with your newest Python heuristics, the best next step would be porting specific merge strategies one by one into `src/lib/optimizer.ts`.
