# pdf

PDF tools in the browser: merge, split, remove pages, organize, rotate,
compress, images to PDF, PDF to images, page numbers and watermarks. Files
are processed on the user's device and never uploaded.

Static site, no build step, no backend.

## Run locally

```sh
python3 -m http.server 8000 -d public
```

Open http://localhost:8000.

## Deploy

Netlify picks up `netlify.toml`, which publishes `public/` and sets security
headers. Either connect the repo in the Netlify dashboard or run:

```sh
npx netlify-cli deploy --prod
```

## How it works

- **Editing** (merge, split, remove, organize, rotate, page numbers,
  watermark, images to PDF) uses [pdf-lib](https://pdf-lib.js.org) 1.17.1.
- **Drawing pages** (thumbnails, compress, PDF to images) uses
  [pdf.js](https://mozilla.github.io/pdf.js/) 4.10.38, with its cmaps and
  standard fonts so CJK and unembedded-font PDFs render properly.
- Both are vendored in `public/vendor/` and load the first time a tool needs
  them, so the menu itself is small.
- Tools that produce several files offer them as a zip (`public/zip.js`,
  stored without compression).

## Limits

- Compress redraws every page as a JPEG. That shrinks scans and image-heavy
  PDFs a lot, but text stops being selectable, and a text-only PDF may come
  out bigger, in which case the original is kept.
- Password-protected or permission-locked PDFs can't be edited. Printing them
  to a new PDF first removes the lock.
- Page numbers and watermarks use the standard Helvetica font, so the text
  has to be in Latin script.
- Merging and splitting keep pages, but not bookmarks or form fields.
