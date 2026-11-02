import * as pdf from "./tools.js";
import { zip } from "./zip.js";

const BAR_WIDTH = 20;
// Longer side of an organize thumbnail, in canvas pixels.
const THUMB_SIZE = 240;

const $ = (id) => document.getElementById(id);

// Phones get tap wording instead of keyboard and drag-and-drop hints.
const touch = matchMedia("(hover: none)").matches;
const narrow = () => matchMedia("(max-width: 560px)").matches;

const PDF = {
  noun: "PDF",
  accept: ".pdf,application/pdf",
  test: (f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name),
};
const IMAGE = {
  noun: "image",
  accept: "image/*",
  test: (f) => f.type.startsWith("image/"),
};

// Organize: the pages in their new order, as { index, turn, canvas }.
let layout = [];

// Tools with `each` run once per file; tools with `all` get every file at once.
// Options with choices cycle through them; the rest are typed in.
const TOOLS = [
  {
    id: "merge",
    title: "Merge PDF",
    hint: "Combine PDFs",
    blurb: "Combine PDFs into one file, in the order listed.",
    input: PDF,
    multiple: true,
    min: 2,
    action: "Merge",
    all: pdf.merge,
  },
  {
    id: "split",
    title: "Split PDF",
    hint: "Separate pages",
    blurb: "Break a PDF into separate files, or pull pages out into a new one.",
    input: PDF,
    action: "Split",
    options: [
      { id: "mode", label: "Split", choices: [["every", "Every page"], ["ranges", "Custom ranges"], ["extract", "Pages to one file"]] },
      { id: "pages", label: "Pages", placeholder: "1-3, 5", hide: (v) => v.mode === "every" },
    ],
    each: pdf.split,
  },
  {
    id: "remove",
    title: "Remove pages",
    hint: "Delete pages",
    blurb: "Delete pages from a PDF.",
    input: PDF,
    action: "Remove pages",
    options: [{ id: "pages", label: "Pages to remove", placeholder: "2, 5-7" }],
    each: pdf.removePages,
  },
  {
    id: "organize",
    title: "Organize pages",
    hint: "Reorder and turn",
    blurb: "Move, turn and delete pages, then save a new PDF.",
    input: PDF,
    action: "Save PDF",
    pages: true,
    each: (file) => pdf.organize(file, layout),
  },
  {
    id: "rotate",
    title: "Rotate PDF",
    hint: "Turn every page",
    blurb: "Turn every page of one or more PDFs.",
    input: PDF,
    multiple: true,
    action: "Rotate",
    options: [{ id: "angle", label: "Turn", choices: [["90", "90° clockwise"], ["180", "180°"], ["270", "90° anticlockwise"]] }],
    each: pdf.rotate,
  },
  {
    id: "compress",
    title: "Compress PDF",
    hint: "Make files smaller",
    blurb: "Shrink PDFs by redrawing each page as a compressed image. Text won't be selectable afterwards.",
    input: PDF,
    multiple: true,
    action: "Compress",
    options: [{ id: "level", label: "Compression", choices: [["recommended", "Recommended"], ["extreme", "Extreme"], ["less", "Less"]] }],
    each: pdf.compress,
  },
  {
    id: "images",
    title: "Images to PDF",
    hint: "JPG, PNG to PDF",
    blurb: "Put photos and images into a PDF, one per page, in the order listed.",
    input: IMAGE,
    multiple: true,
    action: "Convert",
    options: [
      { id: "size", label: "Page size", choices: [["a4", "A4"], ["letter", "Letter"], ["fit", "Same as image"]] },
      { id: "margin", label: "Margin", choices: [["none", "None"], ["small", "Small"], ["large", "Large"]] },
    ],
    all: pdf.imagesToPdf,
  },
  {
    id: "to-images",
    title: "PDF to images",
    hint: "Pages to JPG, PNG",
    blurb: "Save every page as an image.",
    input: PDF,
    multiple: true,
    action: "Convert",
    options: [
      { id: "format", label: "Format", choices: [["jpg", "JPG"], ["png", "PNG"]] },
      { id: "dpi", label: "Quality", choices: [["150", "150 DPI"], ["300", "300 DPI"], ["72", "72 DPI"]] },
    ],
    each: pdf.pdfToImages,
  },
  {
    id: "numbers",
    title: "Page numbers",
    hint: "Number pages",
    blurb: "Add page numbers to every page.",
    input: PDF,
    multiple: true,
    action: "Add numbers",
    options: [
      {
        id: "position",
        label: "Position",
        choices: [
          ["bottom-center", "Bottom middle"],
          ["bottom-right", "Bottom right"],
          ["bottom-left", "Bottom left"],
          ["top-center", "Top middle"],
          ["top-right", "Top right"],
          ["top-left", "Top left"],
        ],
      },
      { id: "format", label: "Style", choices: [["{n}", "1"], ["Page {n}", "Page 1"], ["{n} / {total}", "1 / 9"], ["Page {n} of {total}", "Page 1 of 9"]] },
    ],
    each: pdf.pageNumbers,
  },
  {
    id: "watermark",
    title: "Watermark",
    hint: "Stamp text",
    blurb: "Stamp text across every page.",
    input: PDF,
    multiple: true,
    action: "Add watermark",
    options: [
      { id: "text", label: "Text", placeholder: "CONFIDENTIAL" },
      { id: "style", label: "Angle", choices: [["diagonal", "Diagonal"], ["across", "Straight across"]] },
      { id: "opacity", label: "Strength", choices: [["0.25", "Medium"], ["0.12", "Light"], ["0.5", "Strong"]] },
    ],
    each: pdf.watermark,
  },
];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className, text, label, onclick) {
  const node = el("button", className, text);
  node.type = "button";
  if (label) node.setAttribute("aria-label", label);
  node.onclick = onclick;
  return node;
}

function show(id) {
  for (const section of document.querySelectorAll(".screen > section")) {
    section.hidden = section.id !== id;
  }
  $("back").hidden = id === "home";
}

function formatBytes(n) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1000 && i < units.length - 1) {
    n /= 1000;
    i++;
  }
  return `${i === 0 ? n : n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

const totalSize = (items) => items.reduce((sum, item) => sum + (item.blob || item).size, 0);

// Writes a status line, optionally with an inverted ERROR badge.
function setStatus(node, text, isError = false) {
  node.replaceChildren();
  if (isError) node.append(el("span", "badge", "ERROR"), " ");
  node.append(text);
}

// name ........ meta
function row(name, meta) {
  const item = el("li");
  item.append(el("span", "name", name), el("span", "dots"), el("span", "meta", meta));
  return item;
}

// Returns an update(done, total) function that writes a text progress bar.
function meter(label) {
  const width = narrow() ? 12 : BAR_WIDTH;
  return (done, total) => {
    const filled = Math.round((done / total) * width);
    label.textContent =
      `[${"#".repeat(filled)}${".".repeat(width - filled)}] ${String(Math.floor((done / total) * 100)).padStart(3)}%` +
      `  ${done} / ${total}`;
  };
}

// Screens: a tool is picked with the URL hash, so tools can be linked to and
// the browser's back button works.

let tool = null;
let files = [];
let values = {};
let loadingPages = false;
let urls = [];
// Bumped whenever the screen changes, so work for an old screen is dropped.
let job = 0;

function go(id) {
  history.pushState(null, "", id ? `#${id}` : location.pathname);
  route();
}

function route() {
  job++;
  for (const url of urls) URL.revokeObjectURL(url);
  urls = [];
  files = [];
  layout = [];
  loadingPages = false;
  tool = TOOLS.find((t) => t.id === location.hash.slice(1)) || null;
  setStatus($("status"), "");
  $("bar").hidden = true;

  if (!tool) {
    show("home");
    document.title = "pdf";
    return;
  }
  document.title = `${tool.title} - pdf`;
  values = Object.fromEntries((tool.options || []).map((o) => [o.id, o.choices ? o.choices[0][0] : ""]));
  $("tool-title").textContent = tool.title;
  $("tool-blurb").textContent = tool.blurb;
  $("picker").accept = tool.input.accept;
  $("picker").multiple = !!tool.multiple;
  $("again").textContent = `[2] Back to ${tool.title}`;
  renderTool(true);
}

function renderTool(fresh = false) {
  show("tool");
  const empty = !files.length;
  const noun = tool.multiple ? `${tool.input.noun}s` : `a ${tool.input.noun}`;
  const verb = touch ? "Tap to choose" : "Drop";
  const tail = touch ? "" : ", or click to choose";

  $("dropzone").classList.toggle("small", !empty);
  $("dropzone-label").textContent = empty
    ? `${verb} ${noun}${touch ? "" : ` here${tail}`}`
    : tool.multiple
      ? (touch ? `Tap to add more ${noun}` : `Drop more ${noun} here${tail}`)
      : (touch ? `Tap to choose another ${tool.input.noun}` : `Drop another ${tool.input.noun} here to replace it${tail}`);

  renderFiles();
  renderMenu(fresh);
}

function renderFiles() {
  const rows = files.map((file, i) => {
    const item = row(file.name, formatBytes(file.size));
    if (tool.input === PDF) describePdf(file, item.querySelector(".meta"));
    // Order only matters when the files are combined.
    if (tool.all && files.length > 1) {
      item.append(
        button("act", "[^]", `Move ${file.name} up`, () => move(files, i, -1, renderFiles)),
        button("act", "[v]", `Move ${file.name} down`, () => move(files, i, 1, renderFiles)),
      );
    }
    item.append(button("act", "[x]", `Remove ${file.name}`, () => {
      files.splice(i, 1);
      if (tool.pages) loadPages();
      renderTool(true);
    }));
    return item;
  });
  $("files").replaceChildren(...rows);
}

function move(list, i, step, render) {
  const j = i + step;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  render();
}

// Page counts are shown next to each PDF, and catch unreadable files early.
const counts = new WeakMap();

function describePdf(file, meta) {
  if (!counts.has(file)) counts.set(file, pdf.pageCount(file).catch(() => null));
  counts.get(file).then((count) => {
    meta.textContent = count === null
      ? `Can't read this PDF, ${formatBytes(file.size)}`
      : `${plural(count, "page")}, ${formatBytes(file.size)}`;
  });
}

// The tool's menu: choose files, its options, then the action.
function renderMenu(fresh) {
  const menu = $("tool-menu");
  const selected = fresh ? null : menu.querySelector(".selected")?.dataset.id;
  const empty = !files.length;

  const items = [
    menuButton("choose", empty
      ? (tool.multiple ? `Choose ${tool.input.noun}s` : `Choose a ${tool.input.noun}`)
      : (tool.multiple ? "Add more files" : `Choose another ${tool.input.noun}`)),
  ];
  for (const option of tool.options || []) {
    if (option.hide?.(values)) continue;
    items.push(option.choices ? choiceItem(option) : textItem(option));
  }
  const ready = tool.pages ? layout.length && !loadingPages : files.length >= (tool.min || 1);
  if (ready) items.push(menuButton("run", tool.action));

  items.forEach((item, i) => {
    item.dataset.key = String(i + 1);
    item.querySelector(".key").textContent = `[${i + 1}] `;
    item.addEventListener("mouseenter", () => select(item));
  });
  menu.replaceChildren(...items);
  select(items.find((item) => item.dataset.id === selected) || items.find((item) => item.dataset.id === "run") || items[0]);
}

function menuButton(id, text) {
  const item = el("button", "option");
  item.type = "button";
  item.dataset.id = id;
  item.append(label(text));
  return item;
}

// "[1] Text", kept in one piece so the flex gap doesn't split it.
function label(text) {
  const span = el("span", "label");
  span.append(el("span", "key"), text);
  return span;
}

function choiceItem(option) {
  const item = menuButton(option.id, option.label);
  const [, chosen] = option.choices.find(([value]) => value === values[option.id]);
  item.append(el("span", "dots"), el("span", "meta", chosen));
  item.onclick = () => cycle(option, 1);
  return item;
}

function cycle(option, step) {
  const i = option.choices.findIndex(([value]) => value === values[option.id]);
  values[option.id] = option.choices[(i + step + option.choices.length) % option.choices.length][0];
  renderMenu();
}

function textItem(option) {
  const item = el("label", "option");
  item.dataset.id = option.id;
  const input = el("input");
  input.type = "text";
  input.value = values[option.id];
  input.placeholder = option.placeholder;
  input.autocomplete = "off";
  input.spellcheck = false;
  input.oninput = () => (values[option.id] = input.value);
  input.onfocus = () => select(item);
  item.append(label(option.label), el("span", "dots"), input);
  return item;
}

// Choosing files

function stage(list) {
  if (!tool) return;
  const chosen = [...list];
  const accepted = chosen.filter(tool.input.test);
  const skipped = chosen.length - accepted.length;
  setStatus(
    $("status"),
    skipped
      ? `Skipped ${plural(skipped, "file")} that ${skipped === 1 ? `isn't a ${tool.input.noun}` : `aren't ${tool.input.noun}s`}.`
      : "",
    skipped > 0,
  );
  if (!accepted.length) return;

  if (tool.multiple) {
    for (const file of accepted) {
      const duplicate = files.some(
        (f) => f.name === file.name && f.size === file.size && f.lastModified === file.lastModified,
      );
      if (!duplicate) files.push(file);
    }
  } else {
    files = [accepted[0]];
  }
  if (tool.pages) loadPages();
  renderTool(true);
}

// Organize

async function loadPages() {
  const mine = ++job;
  layout = [];
  renderPages();
  loadingPages = files.length > 0;
  if (!loadingPages) return;
  let index = 0;
  try {
    for await (const canvas of pdf.thumbnails(files[0], THUMB_SIZE)) {
      if (mine !== job) return;
      layout.push({ index: index++, turn: 0, canvas });
      $("pages").append(pageCard(layout.length - 1));
    }
  } catch (err) {
    if (mine === job) setStatus($("status"), describeError(err), true);
  } finally {
    if (mine === job) {
      loadingPages = false;
      renderMenu(true);
    }
  }
}

function renderPages() {
  $("pages").replaceChildren(...layout.map((_, i) => pageCard(i)));
}

function pageCard(i) {
  const page = layout[i];
  const card = el("figure", "page");
  const thumb = el("div", "thumb");
  page.canvas.style.transform = `rotate(${page.turn}deg)`;
  thumb.append(page.canvas);
  const caption = el("figcaption");
  const n = page.index + 1;
  caption.append(
    el("span", "", String(n)),
    button("act", "[<]", `Move page ${n} earlier`, () => move(layout, i, -1, renderPages)),
    button("act", "[>]", `Move page ${n} later`, () => move(layout, i, 1, renderPages)),
    button("act", "[r]", `Turn page ${n}`, () => {
      page.turn = (page.turn + 90) % 360;
      page.canvas.style.transform = `rotate(${page.turn}deg)`;
    }),
    button("act", "[x]", `Delete page ${n}`, () => {
      layout.splice(i, 1);
      renderPages();
      renderMenu();
    }),
  );
  card.append(thumb, caption);
  return card;
}

// Running a tool

function describeError(err) {
  if (err instanceof pdf.Problem) return err.message;
  console.error(err);
  return "Something went wrong with this file. It may be damaged, or use a PDF feature this site can't handle.";
}

async function run() {
  const mine = ++job;
  const status = $("status");
  const bar = $("bar");
  $("tool").classList.add("busy");
  bar.hidden = false;
  bar.textContent = "";
  const progress = meter(bar);

  try {
    let outputs = [];
    if (tool.all) {
      setStatus(status, "Working...");
      outputs = await tool.all(files, values, progress);
    } else {
      for (const [i, file] of files.entries()) {
        setStatus(status, files.length > 1 ? `Working on ${file.name} (${i + 1} of ${files.length})...` : "Working...");
        outputs.push(...(await tool.each(file, values, progress)));
        if (mine !== job) return;
      }
    }
    if (mine !== job) return;
    finish(outputs);
  } catch (err) {
    if (mine === job) setStatus(status, describeError(err), true);
  } finally {
    if (mine === job) {
      $("tool").classList.remove("busy");
      bar.hidden = true;
    }
  }
}

// Two outputs can't share a name inside a zip, e.g. two inputs called scan.pdf.
function uniqueNames(outputs) {
  const seen = new Set();
  for (const output of outputs) {
    const [, stem, ext] = output.name.match(/^(.*?)(\.[^.]*)?$/);
    let name = output.name;
    for (let n = 2; seen.has(name); n++) name = `${stem} (${n})${ext || ""}`;
    seen.add(name);
    output.name = name;
  }
}

function link(blob, name) {
  const url = URL.createObjectURL(blob);
  urls.push(url);
  const a = el("a", "", "Save");
  a.href = url;
  a.download = name;
  return a;
}

let download = null;

async function finish(outputs) {
  uniqueNames(outputs);
  setStatus($("status"), "");
  show("done");

  const size = totalSize(outputs);
  let summary = `[ OK ] ${plural(outputs.length, "file")}, ${formatBytes(size)}`;
  if (tool.id === "compress") {
    const before = totalSize(files);
    summary += ` (was ${formatBytes(before)}, ${Math.max(0, Math.round((1 - size / before) * 100))}% smaller)`;
  }
  $("done-summary").textContent = summary;

  $("results").replaceChildren(
    ...outputs.map((output) => {
      const item = row(output.name, output.meta ? `${output.meta}, ${formatBytes(output.blob.size)}` : formatBytes(output.blob.size));
      item.append(link(output.blob, output.name));
      return item;
    }),
  );

  const single = outputs.length === 1;
  $("download").textContent = single ? "[1] Download" : "[1] Download all (.zip)";
  const zipName = `${files.length === 1 ? pdf.baseName(files[0]) : tool.id}.zip`;
  let archive = null;
  const mine = job;
  download = async () => {
    if (single) return $("results").querySelector("a").click();
    archive ??= zip(outputs).then((blob) => link(blob, zipName));
    const a = await archive;
    if (mine === job) a.click();
  };
  select($("download"));
  download();
}

// Menus

function select(item) {
  for (const b of item.parentElement.children) b.classList.toggle("selected", b === item);
}

for (const menu of document.querySelectorAll(".menu")) {
  if (!menu.children.length) continue;
  select(menu.firstElementChild);
  for (const item of menu.children) item.addEventListener("mouseenter", () => select(item));
}

$("home-menu").replaceChildren(
  ...TOOLS.map((t, i) => {
    const key = String((i + 1) % 10);
    const item = menuButton(t.id, t.title);
    item.dataset.key = key;
    item.querySelector(".key").textContent = `[${key}] `;
    item.append(el("span", "dots"), el("span", "meta", t.hint));
    item.onclick = () => go(t.id);
    item.addEventListener("mouseenter", () => select(item));
    return item;
  }),
);
select($("home-menu").firstElementChild);

function activate(item) {
  const input = item.querySelector("input");
  if (input) input.focus();
  else item.click();
}

document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  if (e.key === "Escape") {
    if (e.target.matches("input")) e.target.blur();
    else if (tool) go("");
    return;
  }

  const menu = [...document.querySelectorAll(".menu")].find((m) => m.offsetParent !== null);
  if (!menu) return;
  const items = [...menu.children].filter((b) => !b.hidden);
  const current = items.findIndex((b) => b.classList.contains("selected"));

  if (e.target.matches("input")) {
    if (e.key === "Enter") {
      e.preventDefault();
      items.find((b) => b.dataset.id === "run")?.click();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.target.blur();
  }

  if (/^[0-9]$/.test(e.key)) {
    const item = items.find((b) => b.dataset.key === e.key);
    if (!item) return;
    e.preventDefault();
    select(item);
    activate(item);
  } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const step = e.key === "ArrowDown" ? 1 : -1;
    select(items[(current + step + items.length) % items.length]);
  } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    const option = tool?.options?.find((o) => o.choices && o.id === items[current]?.dataset.id);
    if (!option || $("tool").hidden) return;
    e.preventDefault();
    cycle(option, e.key === "ArrowRight" ? 1 : -1);
  } else if (e.key === "Enter" && !e.target.matches("button, a")) {
    e.preventDefault();
    if (items[current]) activate(items[current]);
  }
});

// Wiring

$("tool-menu").addEventListener("click", (e) => {
  const id = e.target.closest("button")?.dataset.id;
  if (id === "choose") $("picker").click();
  else if (id === "run") run();
});
$("dropzone").addEventListener("click", () => $("picker").click());
$("download").addEventListener("click", () => download?.());
$("again").addEventListener("click", () => renderTool());
$("main-menu").addEventListener("click", () => go(""));
$("back").addEventListener("click", () => go(""));

$("picker").addEventListener("change", (e) => {
  stage(e.target.files);
  e.target.value = "";
});

// Files can be dropped or pasted in while a tool is waiting for them.
const choosing = () => !$("tool").hidden && !$("tool").classList.contains("busy");

document.addEventListener("dragover", (e) => {
  e.preventDefault();
  if (choosing()) document.body.classList.add("dragging");
});
document.addEventListener("dragleave", (e) => {
  if (!e.relatedTarget) document.body.classList.remove("dragging");
});
document.addEventListener("drop", (e) => {
  e.preventDefault();
  document.body.classList.remove("dragging");
  if (choosing()) stage(e.dataTransfer.files);
});
document.addEventListener("paste", (e) => {
  if (choosing() && e.clipboardData.files.length) stage(e.clipboardData.files);
});

window.addEventListener("popstate", route);
route();
