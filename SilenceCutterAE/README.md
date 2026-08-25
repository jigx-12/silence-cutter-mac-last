# Silence Cutter — After Effects Panel

Removes silence directly on your AE timeline using **Silero VAD** (open-source,
~2.3MB), running fully on CPU via ONNX Runtime — no PyTorch, no GPU. Built and
tuned for modest hardware (e.g. AMD Ryzen 5 G-series APU + 16GB DDR4).

It works like Premiere's "Remove Silence": select your footage layer, hit
Analyze, then Apply — the panel duplicates the layer into one sub-clip per
speech segment and ripples out the silence, so your comp gets shorter and the
gaps disappear. It's a normal AE edit, so **Cmd/Ctrl+Z undoes it**.

## 1. Install prerequisites

- **ffmpeg** on your system PATH (or note its full path — you can set that in
  the panel's Advanced section). Download: https://ffmpeg.org/download.html
- **Node.js** (only needed once, to install the panel's dependencies — After
  Effects runs the panel's own bundled Node at runtime, you don't need Node
  installed system-wide for the extension to run, just to set it up).

## 2. Install the panel's dependencies

Open a terminal in the `SilenceCutterAE/client` folder and run:

```bash
npm install
```

This installs `onnxruntime-node` (CPU) and `node-wav`. `onnxruntime-node`
downloads a small prebuilt native binary for your OS/arch — this needs
internet access the first time.

## 3. Enable unsigned extensions (development install)

CEP panels normally need to be signed and installed via a `.zxp` package. For
personal use, the easier route is enabling debug mode so After Effects loads
unsigned extensions from a folder:

**Windows** — open Registry Editor and set:
```
HKEY_CURRENT_USER\Software\Adobe\CSXS.11\PlayerDebugMode = "1"  (String value)
```
(Use `CSXS.9`, `CSXS.10`, `CSXS.11`, etc. matching your AE version if `.11`
doesn't exist — create it as a String (REG_SZ) value if missing.)

**macOS** — in Terminal:
```bash
defaults write com.adobe.CSXS.11 PlayerDebugMode 1
```
(Same note on version number as above.)

## 4. Copy the extension into place

Copy the whole `SilenceCutterAE` folder into your CEP extensions directory:

- **Windows:** `C:\Users\<you>\AppData\Roaming\Adobe\CEP\extensions\`
- **macOS:** `~/Library/Application Support/Adobe/CEP/extensions/`

(Create the `extensions` folder if it doesn't exist.) End result should look
like `.../CEP/extensions/SilenceCutterAE/CSXS/manifest.xml`.

Restart After Effects. Open it via **Window → Extensions → Silence Cutter**.

## 5. Use it

1. Select a footage layer in your comp (the one with the audio you want
   cleaned up — talking head, podcast recording, etc).
2. Adjust the sliders if you like (defaults are reasonable for voice):
   - **VAD threshold** — confidence to call something speech (0–1).
   - **Min silence to cut** — only gaps longer than this get removed.
   - **Padding** — audio kept on either side of each speech segment, so words
     don't get clipped.
   - **Min speech blip to keep** — ignores very short noise blips.
3. Click **Analyze Selected Layer**. The panel extracts the audio, runs VAD,
   and reports how many segments it found and how much would be removed.
4. Click **Apply** to actually edit the timeline. This is a normal undoable
   AE edit.

## How the timeline edit works

For each kept speech segment, the layer is duplicated and trimmed to that
source range, then all the duplicates are placed back-to-back on the
timeline (no gaps) — same technique as Premiere/Descript-style silence
removal. The original layer is removed at the end. Comp duration itself
isn't changed automatically; trim your comp's work area / duration afterward
if you want it to match.

## Licensing

The panel is gated by a license key, checked against Gumroad — no server to
run yourself:

1. On your Gumroad product, open the **Content** tab and enable
   **"Generate a unique license key per sale."** Gumroad then emails a key
   to every buyer automatically — nothing to build.
2. Once enabled, Gumroad shows a **`product_id`** field right there — a
   short alphanumeric string. This is NOT your product's URL permalink;
   Gumroad's verify API requires `product_id` specifically for any product
   created after Jan 9, 2023 (i.e. every product you're creating now).
3. Open `client/license.js` and set:
   ```js
   const GUMROAD_PRODUCT_ID = "your-product-id-here";
   ```
4. Rebuild/re-zip the extension (or just replace this one file if you're
   updating an already-installed copy) before shipping to customers.

Each key is allowed on 1 machine by default (`MAX_ACTIVATIONS` in
`license.js`) — adjust if you want a different limit. Refunds and
chargebacks are detected automatically on the next check (Gumroad flags the
purchase, the panel picks that up and locks out). If a customer is briefly
offline, cached validations are honored for up to 7 days before re-requiring
a check.

## Troubleshooting

If clicking **Analyze Selected Layer** does nothing, or you see a red error
line in the panel's log box, that's now surfaced directly in the UI — every
step (Node.js loading, ffmpeg, the AE selection check) is wrapped so failures
show up instead of failing silently.

1. Open **Advanced → Run Diagnostics** first. It checks Node.js integration,
   the `node-wav` and `onnxruntime-node` modules, the model file, ffmpeg, and
   your current AE selection, one at a time, and tells you exactly which
   step failed and how to fix it.
2. For deeper inspection, this panel ships with remote debugging enabled
   (`.debug` file, port 8088). With After Effects open and the panel visible,
   open Chrome and go to **http://localhost:8088** — click through to the
   panel to get full Chrome DevTools (Console/Network) on it.
3. Most common cause of a fully silent panel: `npm install` inside `client/`
   didn't finish successfully (no internet during install, or antivirus
   blocked the `onnxruntime-node` native binary download), so Node.js
   integration itself is fine but the modules it needs aren't there.
   Diagnostics will call this out explicitly.

## Notes / limitations

- Works on **footage layers with a file on disk**. If your layer's source is
  a nested composition, pre-render it to a file first.
- If you re-select and re-Analyze a *different* layer, run Analyze again
  before Apply — the panel tracks which layer index the last analysis was
  for.
- All processing is local — nothing leaves your machine.

## Files

```
SilenceCutterAE/
  CSXS/manifest.xml       — extension manifest (Node.js enabled)
  client/
    index.html            — panel UI
    main.js                — panel logic (ffmpeg, VAD, calls into AE)
    vad_engine.js          — Silero VAD via onnxruntime-node (CPU, no torch)
    CSInterface.js         — Adobe's standard CEP/AE bridge library
    model/silero_vad.onnx  — the VAD model (~2.3MB)
    package.json
  host/
    hostscript.jsx         — ExtendScript that edits the AE timeline
```
