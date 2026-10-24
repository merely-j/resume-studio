# Resume Studio

Build a resume on your phone, see the A4 layout update live, export a print-ready PDF. **Pure front-end, zero dependencies, your data never leaves your device.**

**Live demo**: <https://merely-j.github.io/resume-studio/>

[简体中文](README.md) · English

![Mobile editor](shots/phone-edit.png)

---

## What it does

**Filling in**

- Structured sections: basics, work experience, projects, education, skills & certificates
- Add, remove and reorder entries; rename sections, reorder sections, adjust the gap between them
- Built-in sections not enough? Add a **custom section** and rename its title plus all five field labels
- Every field is optional — empty fields simply disappear from the resume, no blank lines or stray separators
- Rich text in paragraphs: **bold / italic / underline**
- Phone numbers are normalised (`138-0000-0000` → `13800000000`)
- Photo upload, auto-resized to 480px, replaceable or removable

**Layout**

- Live A4 preview with three templates: classic single column, modern two column, minimal black & white
- Font size in pt (8–14), three margin presets, adjustable section spacing (0–40px)
- **Fit to one page**: binary-searches the largest font size that still fits, shrinking font, line height and margins together
- All-black typography, Microsoft YaHei for Chinese

**Output**

- Export PDF: exact A4, no UI elements, correct Chinese glyphs, file name defaults to the resume title
- Autosave to local storage — close the tab and come back later
- Multiple resumes: one per job application, duplicate and delete
- Undo / redo (Ctrl+Z / Ctrl+Shift+Z), up to 50 steps
- Installable as a home-screen app (PWA) and works offline

---

## Who it's for

| You are | Why it fits |
| --- | --- |
| **Actively job hunting** | One resume per role — swap the template, tweak two lines, new version in 30 seconds |
| **Writing a Chinese resume** | Chinese typography, a photo block and a one-page limit are all handled |
| **Privacy-conscious** | Nothing is uploaded: no account, no server, data stays in your browser |
| **Iterating constantly** | Multiple versions plus undo — an accidental deletion is recoverable |
| **Helping someone else** | Send a single HTML file; they double-click and it works, no install |
| **Recruiters / friends reviewing** | Edit on the spot with them and export a PDF immediately |

**Not for you if** you need multi-device sync or collaboration (no accounts yet), PDF/Word import with field extraction (not built), or a recruiting backend — this only makes the resume itself.

---

## How to use

### 1. Online (fastest)

Open <https://merely-j.github.io/resume-studio/>, fill it in, hit **Export PDF** and choose "Save as PDF".

### 2. On a phone

Open the link and use your browser's **Add to Home Screen** — it then behaves like an app. Or use the **mobile build** (`dist/简历工坊-手机版.html`): larger touch targets and a fixed bottom bar with *preview* and *export*.

![Mobile build](shots/mobile-build.png)

### 3. Locally (offline)

- **Windows**: double-click `启动.bat` — it starts a local server and opens the browser
- Or just double-click `index.html`
- Developers: `node server.mjs` → `http://localhost:8080/`

To open it on your phone from the same Wi-Fi, use the `http://192.168.x.x:8080/` address the server prints.

### 4. Build distributables

```bash
node tools/build.mjs
```

| Output | Purpose |
| --- | --- |
| `dist/web/` | Static site for any host |
| `dist/简历工坊.html` | Single file, double-click anywhere |
| `dist/简历工坊-手机版.html` | Mobile build with touch-friendly controls |

---

## How it's built

Plain HTML, CSS and JavaScript. No framework, no bundler, no runtime dependencies — edit a file, refresh, done.

A4 pages use millimetre dimensions and are scaled with `transform` on screen; printing hides every UI element via `@media print`, so the preview and the PDF share one stylesheet.

Scripts are classic `<script>` tags rather than ES modules on purpose: module scripts are rejected by the same-origin policy when opened over `file://` or embedded in a sandboxed iframe, which blanked the page. A `window.RS` namespace avoids that at the cost of tree-shaking nobody needs at this size.

```
js/model.js     data model and formatters
js/store.js     local-storage persistence and migrations
js/preview.js   data → resume HTML (pure functions)
js/editor.js    data → form HTML + event delegation
js/app.js       state, undo, view switching, printing
css/resume.css  A4 paper, three templates, print styles
```

Commands:

```bash
node server.mjs          # local static server
node tools/build.mjs     # build all three outputs
node tests/smoke.mjs     # pure-function tests
node tests/e2e.mjs       # real-browser end-to-end tests
```

Deeper notes on the design decisions and pitfalls: **[ARCHITECTURE.md](ARCHITECTURE.md)** (Chinese).

---

## License

[MIT](LICENSE) — free to use, modify and sell; keep the copyright notice.
