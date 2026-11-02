// All PDF work happens here, in the browser. Every tool returns a list of
// { name, blob, meta? } outputs; app.js only drives the screens.

const PDF_LIB = "/vendor/pdf-lib-1.17.1.esm.min.js";
const PDFJS = "/vendor/pdfjs-4.10.38/";
// Phones fail to draw canvases much bigger than this, so very large pages
// and photos are scaled down to fit.
const MAX_PIXELS = 16_000_000;
// Pages can't be bigger than 200 inches.
const MAX_PAGE = 14_400;

// A problem with the user's file or input, shown to them as is.
export class Problem extends Error {}

// Both libraries are large, so they load the first time they're needed.
let editorModule, viewerModule;

function editor() {
  editorModule ??= import(PDF_LIB).catch((err) => {
    editorModule = null;
    throw err;
  });
  return editorModule;
}

function viewer() {
  viewerModule ??= import(PDFJS + "pdf.min.mjs").then(
    (pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = PDFJS + "pdf.worker.min.mjs";
      return pdfjs;
    },
    (err) => {
      viewerModule = null;
      throw err;
    },
  );
  return viewerModule;
}

export const baseName = (file) => file.name.replace(/\.[^.]*$/, "") || "file";

const pdfBlob = (bytes) => new Blob([bytes], { type: "application/pdf" });

// Opens a PDF for editing with pdf-lib.
async function open(file) {
  const { PDFDocument } = await editor();
  try {
    return await PDFDocument.load(await file.arrayBuffer(), { updateMetadata: false });
  } catch (err) {
    // pdf-lib's EncryptedPDFError is compiled to ES5, so instanceof doesn't work.
    if (/is encrypted/.test(err.message)) {
      throw new Problem(`${file.name} is password-protected or locked. Print it to a new PDF, then try again.`);
    }
    throw new Problem(`${file.name} couldn't be read as a PDF.`);
  }
}

// Opens a PDF for drawing with pdf.js.
async function read(file) {
  const { getDocument } = await viewer();
  try {
    return await getDocument({
      data: new Uint8Array(await file.arrayBuffer()),
      isEvalSupported: false,
      cMapUrl: PDFJS + "cmaps/",
      standardFontDataUrl: PDFJS + "standard_fonts/",
    }).promise;
  } catch (err) {
    if (err.name === "PasswordException") throw new Problem(`${file.name} needs a password to open.`);
    throw new Problem(`${file.name} couldn't be read as a PDF.`);
  }
}

export async function pageCount(file) {
  const doc = await read(file);
  const count = doc.numPages;
  doc.destroy();
  return count;
}

// Draws a page onto a white canvas. A scale of 1 is 72 DPI.
async function draw(page, scale) {
  let viewport = page.getViewport({ scale });
  const pixels = viewport.width * viewport.height;
  if (pixels > MAX_PIXELS) viewport = page.getViewport({ scale: scale * Math.sqrt(MAX_PIXELS / pixels) });
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas;
}

function toBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

// Yields a small canvas for each page, scaled so its longer side is `size`.
export async function* thumbnails(file, size) {
  const doc = await read(file);
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const { width, height } = page.getViewport({ scale: 1 });
      yield await draw(page, size / Math.max(width, height));
      page.cleanup();
    }
  } finally {
    doc.destroy();
  }
}

// "1-3, 5, 8-" -> [[1, 3], [5, 5], [8, count]]. Pages count from 1.
export function parseRanges(text, count) {
  const ranges = [];
  for (const part of text.split(",").map((s) => s.trim()).filter(Boolean)) {
    const match = part.match(/^(\d+)$|^(\d*)\s*-\s*(\d*)$/);
    if (!match || part === "-") throw new Problem(`"${part}" isn't a page or a range like 2-5.`);
    const from = match[1] ? +match[1] : match[2] ? +match[2] : 1;
    const to = match[1] ? +match[1] : match[3] ? +match[3] : count;
    if (from < 1 || to > count || from > to) {
      throw new Problem(`${part} isn't within pages 1-${count}.`);
    }
    ranges.push([from, to]);
  }
  if (!ranges.length) throw new Problem("Type which pages, like 1-3, 5.");
  return ranges;
}

// [from, to] counting from 1 -> 0-based page indices.
const indices = ([from, to]) => Array.from({ length: to - from + 1 }, (_, i) => from - 1 + i);

const angleOf = (page, turn = 0) => (((page.getRotation().angle + turn) % 360) + 360) % 360;

async function copy(src, pageIndices) {
  const { PDFDocument } = await editor();
  const out = await PDFDocument.create();
  for (const page of await out.copyPages(src, pageIndices)) out.addPage(page);
  return out;
}

// Merge, split, remove, organize, rotate

export async function merge(files, options, progress) {
  const { PDFDocument } = await editor();
  const out = await PDFDocument.create();
  for (const [i, file] of files.entries()) {
    const src = await open(file);
    for (const page of await out.copyPages(src, src.getPageIndices())) out.addPage(page);
    progress(i + 1, files.length);
  }
  return [{ name: "merged.pdf", blob: pdfBlob(await out.save()) }];
}

export async function split(file, { mode, pages }, progress) {
  const src = await open(file);
  const count = src.getPageCount();
  const base = baseName(file);

  if (mode === "extract") {
    const picked = parseRanges(pages, count).flatMap(indices);
    return [{ name: `${base}-extract.pdf`, blob: pdfBlob(await (await copy(src, picked)).save()) }];
  }

  const ranges = mode === "every"
    ? Array.from({ length: count }, (_, i) => [i + 1, i + 1])
    : parseRanges(pages, count);
  const outputs = [];
  for (const range of ranges) {
    const [from, to] = range;
    const name = `${base}-${from === to ? from : `${from}-${to}`}.pdf`;
    outputs.push({ name, blob: pdfBlob(await (await copy(src, indices(range))).save()) });
    progress(outputs.length, ranges.length);
  }
  return outputs;
}

export async function removePages(file, { pages }) {
  const src = await open(file);
  const drop = new Set(parseRanges(pages, src.getPageCount()).flatMap(indices));
  const keep = src.getPageIndices().filter((i) => !drop.has(i));
  if (!keep.length) throw new Problem("That would remove every page.");
  return [{ name: `${baseName(file)}-removed.pdf`, blob: pdfBlob(await (await copy(src, keep)).save()) }];
}

// order: [{ index, turn }], where turn is extra clockwise rotation in degrees.
export async function organize(file, order) {
  const { degrees } = await editor();
  const src = await open(file);
  const out = await copy(src, order.map((p) => p.index));
  out.getPages().forEach((page, i) => page.setRotation(degrees(angleOf(page, order[i].turn))));
  return [{ name: `${baseName(file)}-organized.pdf`, blob: pdfBlob(await out.save()) }];
}

export async function rotate(file, { angle }) {
  const { degrees } = await editor();
  const doc = await open(file);
  for (const page of doc.getPages()) page.setRotation(degrees(angleOf(page, +angle)));
  return [{ name: `${baseName(file)}-rotated.pdf`, blob: pdfBlob(await doc.save()) }];
}

// Compress: every page is redrawn as a JPEG at this DPI and quality.

const COMPRESSION = {
  recommended: [110, 0.6],
  extreme: [72, 0.4],
  less: [150, 0.8],
};

export async function compress(file, { level }, progress) {
  const { PDFDocument } = await editor();
  const [dpi, quality] = COMPRESSION[level];
  const src = await read(file);
  const out = await PDFDocument.create();
  try {
    for (let n = 1; n <= src.numPages; n++) {
      const page = await src.getPage(n);
      const { width, height } = page.getViewport({ scale: 1 });
      const canvas = await draw(page, dpi / 72);
      const jpeg = await toBlob(canvas, "image/jpeg", quality);
      canvas.width = 0;
      const image = await out.embedJpg(await jpeg.arrayBuffer());
      out.addPage([width, height]).drawImage(image, { x: 0, y: 0, width, height });
      page.cleanup();
      progress(n, src.numPages);
    }
  } finally {
    src.destroy();
  }

  const name = `${baseName(file)}-compressed.pdf`;
  const bytes = await out.save();
  if (bytes.length >= file.size) return [{ name, blob: file, meta: "Already small, kept as is" }];
  const saved = Math.round((1 - bytes.length / file.size) * 100);
  return [{ name, blob: pdfBlob(bytes), meta: `${saved}% smaller` }];
}

// Images to PDF and back

const PAPER = { a4: [595.28, 841.89], letter: [612, 792] };
const MARGIN = { none: 0, small: 18, large: 36 };

// PNGs go in as they are. Everything else is redrawn as a JPEG, which also
// applies the rotation phones store in a photo's EXIF data.
async function embedImage(doc, file) {
  if (file.type === "image/png") {
    try {
      return await doc.embedPng(await file.arrayBuffer());
    } catch {
      // Unusual PNGs pdf-lib can't parse still work through the canvas.
    }
  }
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Problem(`${file.name} couldn't be read as an image.`);
  }
  const scale = Math.min(1, Math.sqrt(MAX_PIXELS / (bitmap.width * bitmap.height)));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const jpeg = await toBlob(canvas, "image/jpeg", 0.92);
  canvas.width = 0;
  return doc.embedJpg(await jpeg.arrayBuffer());
}

export async function imagesToPdf(files, { size, margin }, progress) {
  const { PDFDocument } = await editor();
  const out = await PDFDocument.create();
  const gap = MARGIN[margin];
  for (const [i, file] of files.entries()) {
    const image = await embedImage(out, file);
    let pageWidth, pageHeight;
    if (size === "fit") {
      // 96 pixels to the inch, like a browser.
      const fit = Math.min(0.75, (MAX_PAGE - 2 * gap) / Math.max(image.width, image.height));
      pageWidth = image.width * fit + 2 * gap;
      pageHeight = image.height * fit + 2 * gap;
    } else {
      [pageWidth, pageHeight] = PAPER[size];
      if (image.width > image.height) [pageWidth, pageHeight] = [pageHeight, pageWidth];
    }
    const scale = Math.min((pageWidth - 2 * gap) / image.width, (pageHeight - 2 * gap) / image.height);
    const width = image.width * scale;
    const height = image.height * scale;
    out.addPage([pageWidth, pageHeight]).drawImage(image, {
      x: (pageWidth - width) / 2,
      y: (pageHeight - height) / 2,
      width,
      height,
    });
    progress(i + 1, files.length);
  }
  const name = files.length === 1 ? `${baseName(files[0])}.pdf` : "images.pdf";
  return [{ name, blob: pdfBlob(await out.save()) }];
}

export async function pdfToImages(file, { format, dpi }, progress) {
  const type = format === "png" ? "image/png" : "image/jpeg";
  const src = await read(file);
  const digits = String(src.numPages).length;
  const outputs = [];
  try {
    for (let n = 1; n <= src.numPages; n++) {
      const page = await src.getPage(n);
      const canvas = await draw(page, dpi / 72);
      const name = `${baseName(file)}-${String(n).padStart(digits, "0")}.${format}`;
      outputs.push({ name, blob: await toBlob(canvas, type, 0.9) });
      canvas.width = 0;
      page.cleanup();
      progress(n, src.numPages);
    }
  } finally {
    src.destroy();
  }
  return outputs;
}

// Stamping text: page numbers and watermarks

// Size of the page as it's displayed, after /Rotate.
function shownSize(page) {
  const { width, height } = page.getCropBox();
  return angleOf(page) % 180 ? { width: height, height: width } : { width, height };
}

// Turns a point measured from the bottom left of the page as it's displayed
// into the page's own coordinates, which ignore /Rotate. Text drawn with the
// returned angle added to its own reads the right way up.
function unturn(page, X, Y) {
  const { x, y, width, height } = page.getCropBox();
  const angle = angleOf(page);
  if (angle === 90) return { x: x + width - Y, y: y + X, angle };
  if (angle === 180) return { x: x + width - X, y: y + height - Y, angle };
  if (angle === 270) return { x: x + Y, y: y + height - X, angle };
  return { x: x + X, y: y + Y, angle: 0 };
}

// Standard fonts only cover Latin text.
function checkText(font, text) {
  try {
    font.encodeText(text);
  } catch {
    throw new Problem("Text can only use Latin letters, numbers and punctuation.");
  }
}

export async function pageNumbers(file, { position, format }) {
  const { StandardFonts, rgb, degrees } = await editor();
  const doc = await open(file);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const size = 10;
  const margin = 28;
  const pages = doc.getPages();
  const [edge, align] = position.split("-");

  pages.forEach((page, i) => {
    const text = format.replace("{n}", i + 1).replace("{total}", pages.length);
    const { width, height } = shownSize(page);
    const textWidth = font.widthOfTextAtSize(text, size);
    const X = align === "left" ? margin : align === "right" ? width - margin - textWidth : (width - textWidth) / 2;
    const Y = edge === "top" ? height - margin - font.heightAtSize(size, { descender: false }) : margin;
    const { x, y, angle } = unturn(page, X, Y);
    page.drawText(text, { x, y, size, font, color: rgb(0, 0, 0), rotate: degrees(angle) });
  });
  return [{ name: `${baseName(file)}-numbered.pdf`, blob: pdfBlob(await doc.save()) }];
}

export async function watermark(file, { text, style, opacity }) {
  const { StandardFonts, rgb, degrees } = await editor();
  text = text.trim();
  if (!text) throw new Problem("Type the watermark text.");
  const doc = await open(file);
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  checkText(font, text);

  for (const page of doc.getPages()) {
    const { width, height } = shownSize(page);
    // Corner to corner, or straight across.
    const tilt = style === "diagonal" ? Math.atan2(height, width) : 0;
    const span = style === "diagonal" ? Math.hypot(width, height) : width;
    const size = Math.min(120, (span * 0.6) / font.widthOfTextAtSize(text, 1));
    const textWidth = font.widthOfTextAtSize(text, size);
    const textHeight = font.heightAtSize(size, { descender: false });
    // Start of the baseline that puts the middle of the text in the middle of the page.
    const X = width / 2 - (Math.cos(tilt) * textWidth - Math.sin(tilt) * textHeight) / 2;
    const Y = height / 2 - (Math.sin(tilt) * textWidth + Math.cos(tilt) * textHeight) / 2;
    const { x, y, angle } = unturn(page, X, Y);
    page.drawText(text, {
      x,
      y,
      size,
      font,
      color: rgb(0.5, 0.5, 0.5),
      opacity: +opacity,
      rotate: degrees(angle + (tilt * 180) / Math.PI),
    });
  }
  return [{ name: `${baseName(file)}-watermarked.pdf`, blob: pdfBlob(await doc.save()) }];
}
