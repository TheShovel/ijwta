/* Generator for the Khuwari docs subpages. Emits docs/<slug>.html from the
 * category definitions below. Run: node gen-docs-subpages.js
 * (output lives in docs/, which is committed). */
'use strict';
const fs = require('fs');
const path = require('path');

const SITE = path.resolve(__dirname, '..');
const OUT = path.join(SITE, 'docs');

const NAV = `<nav class="nav">
  <a class="nav-brand" href="../index.html">
    <img src="../logo.svg" alt="" class="brand-logo">
    Khuwari
  </a>
  <div class="nav-links" id="navLinks">
    <a href="../index.html">Home</a>
    <a href="../docs.html" class="active">Docs</a>
    <a href="../credits.html">Credits</a>
    <a href="https://github.com/TheShovel/khuwari">GitHub</a>
  </div>
  <div class="nav-cta">
    <a class="btn primary" href="../editor.html">Open Khuwari</a>
  </div>
</nav>`;

const FOOTER = `<footer class="footer">
  <div class="footer-inner">
    <div class="footer-brand">
      <img src="../logo.svg" alt="" class="brand-logo">
      Khuwari
    </div>
    <div class="footer-links">
      <a href="../index.html">Home</a>
      <a href="../docs.html">Docs</a>
      <a href="../credits.html">Credits</a>
      <a href="https://github.com/TheShovel/khuwari">GitHub</a>
    </div>
  </div>
</footer>`;

// Shared SVG figure library. Every figure mirrors the real app UI (same
// palette and layout) so it reads like a screenshot; animated ones use the
// .fig-* CSS animations in site.css and pause under prefers-reduced-motion.
// Figures are authored at a 720-unit viewBox with fonts sized to match their
// boxes (no post-scaling), so text never overflows or clips.
// Figure library. UI figures are real screenshots of the editor (shots/);
// the remaining illustrations (project file, keyboard, privacy) are SVGs.
const FIG = {
  appWindow:   `
<figure class="doc-fig">
  <img class="fig-img" src="../shots/win.png" alt="The Khuwari window with a project loaded: assets on the left, the canvas in the middle, the selection panel on the right, and the timeline along the bottom" width="720">
  <figcaption>The whole Khuwari window. Your image library sits on the left, the canvas is in the middle, the selection panel is on the right, and the timeline runs along the bottom.</figcaption>
</figure>`,
  browserBar:   `
<figure class="doc-fig">
  <img class="fig-img" src="../shots/start.png" alt="The Khuwari start screen with the mascot banner and the launch buttons" width="720">
  <figcaption>The start screen greets you with a new project, load, docs, example project, credits and GitHub buttons.</figcaption>
</figure>`,
  projectFile: `
<figure class="doc-fig">
  <svg viewBox="0 0 720 200" role="img" aria-label="A .khuwari project file with its contents listed" class="fig-border">
    <rect x="40" y="30" width="200" height="150" rx="10" fill="#22272e" stroke="#39414d"/>
    <path d="M70 30 h60 l20 20 h50 v120 h-130 z" fill="#1b1f25" stroke="#8aa3b9" stroke-width="1.5"/>
    <text x="80" y="120" font-size="14.5" fill="#e6e9ee" font-weight="600">my-anim</text>
    <text x="80" y="138" font-size="12.5" fill="#c3ab7d">.khuwari</text>
    <text x="300" y="64" font-size="15" fill="#98a1ad">One file holds everything:</text>
    <circle cx="316" cy="92" r="3.5" fill="#8aa3b9"/><text x="328" y="96" font-size="15" fill="#e6e9ee">layers</text>
    <circle cx="316" cy="118" r="3.5" fill="#8aa3b9"/><text x="328" y="122" font-size="15" fill="#e6e9ee">keyframes and gaps</text>
    <circle cx="316" cy="144" r="3.5" fill="#8aa3b9"/><text x="328" y="148" font-size="15" fill="#e6e9ee">settings</text>
  </svg>
  <figcaption>A project is one file, easy to save, share and version.</figcaption>
</figure>`,
  assetsPanel:   `
<figure class="doc-fig">
  <img class="fig-img" src="../shots/assets.png" alt="The assets panel with images in a grid" width="720">
  <figcaption>The assets panel. Drag any tile onto the timeline to turn it into a keyframe.</figcaption>
</figure>`,
  previewFilmstrip:   `
<figure class="doc-fig">
  <img class="fig-img" src="../shots/preview.png" alt="The preview canvas with the filmstrip below it" width="720">
  <figcaption>The preview canvas with the filmstrip below. Click any thumb to jump to that frame.</figcaption>
</figure>`,
  timelineLayers:   `
<figure class="doc-fig">
  <img class="fig-img" src="../shots/timeline_layers.png" alt="The timeline with a normal layer and a thin color layer holding stacked dot chips" width="720">
  <figcaption>The timeline. Keyframes are chips on their layer track; color layers stay thin and hold dots.</figcaption>
</figure>`,
  selectionPanel:   `
<figure class="doc-fig">
  <img class="fig-img" src="../shots/selection.png" alt="The selection panel showing a selected keyframe" width="720">
  <figcaption>Select a keyframe and its details appear in the right panel.</figcaption>
</figure>`,
  kfChip:   `
<figure class="doc-fig">
  <img class="fig-img" src="../shots/kfchip.png" alt="A keyframe chip selected on the timeline" width="720">
  <figcaption>Drag the chip to retime it; drag its edges to change how long it holds.</figcaption>
</figure>`,
  gapInbetween:   `
<figure class="doc-fig">
  <img class="fig-img" src="../shots/gap.png" alt="A gap between two keyframes with the generated inbetween frames marked" width="720">
  <figcaption>Between two keyframes is a gap. Khuwari generates the inbetween frames for it.</figcaption>
</figure>`,
  squash:   `
<figure class="doc-fig">
  <img class="fig-img" src="../shots/squash.png" alt="A gap in squash mode with its options in the right panel" width="720">
  <figcaption>Squash mode deforms the inbetweens for cartoon motion.</figcaption>
</figure>`,
  motionBlur:   `
<figure class="doc-fig">
  <img class="fig-img" src="../shots/blur.png" alt="A gap with motion blur on and its intensity slider in the right panel" width="720">
  <figcaption>Motion blur smears the inbetweens along their movement, easing in and out.</figcaption>
</figure>`,
  colorFill:   `
<figure class="doc-fig">
  <img class="fig-img" src="../shots/colorfill.png" alt="Color dots flooding the line art shapes on the canvas" width="720">
  <figcaption>Each dot flood-fills the connected area inside the nearest lines.</figcaption>
</figure>`,
  onion:   `
<figure class="doc-fig">
  <img class="fig-img" src="../shots/onion.png" alt="Onion skinning with ghost frames around the current one and the settings popup" width="720">
  <figcaption>Onion skinning keeps the neighboring frames faintly visible while you work.</figcaption>
</figure>`,
  blend:   `
<figure class="doc-fig">
  <img class="fig-img" src="../shots/blend.png" alt="The selection panel with the blend mode dropdown for a keyframe" width="720">
  <figcaption>Each keyframe can blend with the layers below it in 16 different ways.</figcaption>
</figure>`,
  exportMenu:   `
<figure class="doc-fig">
  <img class="fig-img" src="../shots/export.png" alt="The export menu with the format and resolution dropdowns" width="720">
  <figcaption>The export menu. Pick a format and resolution, then hit Export.</figcaption>
</figure>`,
  settingsMenu:   `
<figure class="doc-fig">
  <img class="fig-img" src="../shots/settings.png" alt="The settings menu with FPS, snapping, aspect ratio and working size" width="720">
  <figcaption>The settings menu controls the pace and shape of your project.</figcaption>
</figure>`,
  keys: `
<figure class="doc-fig">
  <svg viewBox="0 0 720 190" role="img" aria-label="Keyboard keys: space, left arrow, right arrow, delete" class="fig-border">
    <g class="fig-anim fig-tap">
      <rect x="60" y="50" width="220" height="60" rx="10" fill="#2a3038" stroke="#39414d" stroke-width="2"/>
      <text x="170" y="88" font-size="17" fill="#e6e9ee" text-anchor="middle">Space</text>
    </g>
    <rect x="320" y="50" width="60" height="60" rx="10" fill="#2a3038" stroke="#39414d" stroke-width="2"/>
    <path d="M340 78 l14 -13 v9 h26 v8 h-26 v9 z" fill="#e6e9ee"/>
    <rect x="400" y="50" width="60" height="60" rx="10" fill="#2a3038" stroke="#39414d" stroke-width="2"/>
    <path d="M440 78 l-14 -13 v9 h-26 v8 h26 v9 z" fill="#e6e9ee"/>
    <rect x="500" y="50" width="150" height="60" rx="10" fill="#2a3038" stroke="#39414d" stroke-width="2"/>
    <text x="575" y="88" font-size="17" fill="#e6e9ee" text-anchor="middle">Del</text>
    <text x="360" y="150" font-size="15" fill="#98a1ad" text-anchor="middle">space plays, arrows step, delete removes</text>
  </svg>
  <figcaption>The shortcuts are easy to reach while you work.</figcaption>
</figure>`,
  privacy: ``
};

// Structured category content. Each section: { id, title, html }.
const CATEGORIES = [
  {
    slug: 'getting-started', title: 'Getting started',
    blurb: 'What Khuwari is, how to open it, and how project files work.',
    sections: [
      { id: 'what-is', title: 'What is Khuwari?', html: `
        <p>Khuwari is a browser based animation tool that fills in the frames between your keyframes using machine learning. You draw or import the important poses, place them on the timeline, and Khuwari generates everything in between.</p>
        <h3>The idea</h3>
        <ul>
          <li>You provide the key poses, called <strong>keyframes</strong>.</li>
          <li>Khuwari generates the frames between them, called <strong>inbetweens</strong>.</li>
          <li>Everything runs in your browser. The model downloads once, and your art never leaves your machine.</li>
        </ul>
        ${FIG.appWindow}
      ` },
      { id: 'open-app', title: 'Open the app', html: `
        <p>The easiest way is to open the app straight from the <a href="https://theshovel.rocks/khuwari/" target="_blank" rel="noopener">Khuwari website</a> in your browser. No install, nothing to set up, everything runs in the tab. This is the recommended way to use Khuwari.</p>
        <p>You can also host it yourself. Khuwari is a static site, so any file server works.</p>
        <ol>
          <li>Serve the project folder, for example with <code>python3 -m http.server 4000</code>.</li>
          <li>Open <code>http://localhost:4000</code> in your browser.</li>
        </ol>
        <p>From the start screen you can start a new project, load an existing <code>.khuwari</code> file, or try the bundled example project. The example project is the fastest way to see a finished animation. Load it and press play.</p>
        ${FIG.browserBar}
      ` },
      { id: 'project-files', title: 'Project files', html: `
        <p>Projects save as <code>.khuwari</code> files that are easy to version and share.</p>
        <ul>
          <li>Use <code>File</code> in the toolbar, then <code>Save project (.khuwari)</code> to download one.</li>
          <li>Use <code>File</code>, then <code>Load project</code> to bring one back.</li>
          <li>A project file holds your layers, keyframes, gaps and settings.</li>
        </ul>
        ${FIG.projectFile}
      ` }
    ]
  },
  {
    slug: 'interface', title: 'The interface',
    blurb: 'The assets panel, the preview, the timeline, the selection panel and layers.',
    sections: [
      { id: 'assets-panel', title: 'The assets panel', html: `
        <p>The panel on the left is your image library.</p>
        <ul>
          <li>Use <code>Add images</code> to bring in art.</li>
          <li>Drag an image onto the timeline to make a keyframe.</li>
          <li>Hover a tile to reveal a delete badge. Deleting an image removes it from the library only.</li>
        </ul>
        ${FIG.assetsPanel}
      ` },
      { id: 'preview', title: 'The preview', html: `
        <p>The large canvas in the center shows the current frame, and the filmstrip under it shows every frame of the animation.</p>
        <ul>
          <li>Press play to watch it move, or step frame by frame with the arrow keys.</li>
          <li>Click a filmstrip thumb to jump to that frame.</li>
          <li>The outlined thumb is the frame you are looking at.</li>
        </ul>
        ${FIG.previewFilmstrip}
      ` },
      { id: 'timeline', title: 'The timeline', html: `
        <p>Each layer has its own track along the bottom. Keyframes appear as chips, and the space between two keyframes is a gap.</p>
        <ul>
          <li>Click a chip to select it.</li>
          <li>Drag a chip to move it in time.</li>
          <li>Drag a chip's edges to change how long it holds.</li>
          <li>Click a gap to open its inbetween options.</li>
        </ul>
        ${FIG.timelineLayers}
      ` },
      { id: 'selection-panel', title: 'The selection panel', html: `
        <p>The panel on the right shows the details of whatever you have selected, whether that is a keyframe, a gap or a color dot.</p>
        <ul>
          <li>Set exact times and blend modes for keyframes.</li>
          <li>Choose how a gap fills in its inbetweens, and tune squash and motion blur.</li>
          <li>Edit a color dot's color, threshold, grow and gradient.</li>
        </ul>
        ${FIG.selectionPanel}
      ` },
      { id: 'layers', title: 'Layers', html: `
        <p>The <code>Layer</code> button in the toolbar opens the layer menu.</p>
        <ul>
          <li>Add a normal layer or a color layer.</li>
          <li>Rename, hide or remove the active layer.</li>
          <li>Layers draw from top to bottom, and each one keeps its own keyframes and gaps.</li>
          <li>Drag layers up and down in the menu to reorder them.</li>
        </ul>
      ` }
    ]
  },
  {
    slug: 'keyframes', title: 'Keyframes',
    blurb: 'Adding, selecting, moving, resizing, timing, replacing and deleting frames.',
    sections: [
      { id: 'add-keyframe', title: 'Add a keyframe', html: `
        <p>Drag an image from the assets panel onto a layer track at the time you want it. The image becomes a keyframe chip that holds that pose.</p>
      ` },
      { id: 'select-inspect', title: 'Select and inspect', html: `
        <p>Click a chip to select it. The selection panel on the right shows:</p>
        <ul>
          <li>a thumbnail of the frame</li>
          <li>the exact time</li>
          <li>the blend mode</li>
          <li>buttons to replace or delete the frame</li>
        </ul>
        ${FIG.selectionPanel}
      ` },
      { id: 'move-resize', title: 'Move and resize', html: `
        <p>Drag a chip left or right to change when it happens. Drag its edges to change how long the frame holds before the gap starts. Hold times matter for pacing.</p>
        ${FIG.kfChip}
      ` },
      { id: 'set-time', title: 'Set the time exactly', html: `
        <p>With a keyframe selected, enter the time in seconds in the selection panel. Use the playhead and frame counter to find the moment you want.</p>
      ` },
      { id: 'replace-delete', title: 'Replace or delete', html: `
        <ul>
          <li><code>Replace image</code> swaps in different art while keeping the timing.</li>
          <li><code>Delete</code> removes the keyframe. The keyboard shortcut <kbd>Delete</kbd> or <kbd>Backspace</kbd> also works.</li>
        </ul>
      ` }
    ]
  },
  {
    slug: 'gaps', title: 'Gaps & inbetweens',
    blurb: 'Machine learning, squash and stretch, no inbetweens, motion blur and regeneration.',
    sections: [
      { id: 'what-is-gap', title: 'What is a gap?', html: `
        <p>The space between two keyframes on the same layer is a gap. Click the gap chip on the timeline to open its options in the right panel, and the inbetweens are generated there.</p>
        ${FIG.gapInbetween}
      ` },
      { id: 'ml', title: 'Machine learning', html: `
        <p>The default mode. A machine learning model generates the inbetween frames, which gives the most natural motion for complex art. This is where Khuwari shines.</p>
      ` },
      { id: 'squash', title: 'Squash and stretch', html: `
        <p>A stylized deformation for cartoon motion.</p>
        <ul>
          <li><strong>Amount</strong> controls how strong the deformation is, or set it to auto for a distance based value.</li>
          <li><strong>Curve</strong> picks the motion: anticipation (peak mid-gap), impact (builds to the end), ease (smooth) or linear.</li>
          <li><strong>Preserve</strong> keeps area or volume constant while deforming.</li>
        </ul>
        ${FIG.squash}
      ` },
      { id: 'none', title: 'No inbetweens', html: `
        <p>No inbetweens at all. The first keyframe simply holds until the next one starts. Good for flashes, cuts and text.</p>
      ` },
      { id: 'motion-blur', title: 'Motion blur', html: `
        <p>A per gap toggle. When on, the inbetweens smear along their motion, and the blur eases in and out with the movement.</p>
        <ul>
          <li>The <strong>intensity</strong> slider controls how strong the smear is.</li>
          <li>It is designed to mask small imperfections in generated frames.</li>
          <li>It works on color layers too.</li>
        </ul>
        ${FIG.motionBlur}
      ` },
      { id: 'regenerate', title: 'Regenerate', html: `
        <p>Inbetweens regenerate automatically whenever your keyframes change. To force a full refresh, use the regenerate button above the timeline, to the right of the play buttons.</p>
      ` }
    ]
  },
  {
    slug: 'color-layers', title: 'Color layers',
    blurb: 'Color dots that fill the layer above, with thresholds, grow, gradients and timing.',
    sections: [
      { id: 'what-they-do', title: 'What they do', html: `
        <p>A color layer holds dots instead of keyframes. Each dot acts like a smart bucket fill for the layer above it, so you can color in line art without touching the drawing.</p>
        ${FIG.colorFill}
      ` },
      { id: 'add-place', title: 'Add one and place dots', html: `
        <ol>
          <li>Use the <code>Layer</code> menu and choose <code>Add color layer</code>.</li>
          <li>Click on the canvas to place a dot.</li>
          <li>The dot fills everything inside the nearest lines of the layer above.</li>
        </ol>
        <p class="doc-note">New dots remember the last color you used, so coloring many regions is quick. You can also copy and paste a dot's properties onto other dots.</p>
      ` },
      { id: 'dot-properties', title: 'Dot properties', html: `
        <ul>
          <li><strong>Fill color</strong> is what the dot pours into the area.</li>
          <li><strong>Threshold</strong> is how strong a line must be to stop the fill.</li>
          <li><strong>Grow</strong> is a radius in pixels that tucks the color under soft edges.</li>
        </ul>
      ` },
      { id: 'gradients', title: 'Gradients', html: `
        <p>Turn on <code>Gradient</code> to give a dot a gradient instead of a flat fill.</p>
        <ul>
          <li><strong>Gradient color</strong> is the color the fill fades toward.</li>
          <li><strong>Height</strong> controls how tall the gradient is.</li>
          <li><strong>Direction</strong> picks top, bottom, left or right.</li>
        </ul>
      ` },
      { id: 'timing', title: 'Timing', html: `
        <p>Dots only work during the time you set. Use the start and end fields in the right panel, or drag the dot chip on the timeline and drag its edges to resize. Outside that window the dot does nothing.</p>
      ` }
    ]
  },
  {
    slug: 'onion-skinning', title: 'Onion skinning',
    blurb: 'Seeing the frames around the current one, and configuring the ghosts.',
    sections: [
      { id: 'what-it-is', title: 'What it is', html: `
        <p>Onion skinning shows the frames around the current one, so you can see where the motion is heading while you work. It is a toggle, like the view only keyframes button.</p>
        ${FIG.onion}
      ` },
      { id: 'turn-it-on', title: 'Turn it on', html: `
        <p>The onion button in the transport area toggles it on and off. The small arrow next to it opens the settings popup.</p>
      ` },
      { id: 'settings', title: 'Settings', html: `
        <ul>
          <li><strong>Frames before</strong> and <strong>after</strong> choose how many neighbors to show.</li>
          <li><strong>Opacity</strong> sets how strong the ghosts are.</li>
          <li><strong>Tint</strong> replaces the ghost look with a flat tint; pick the color and strength.</li>
        </ul>
      ` },
      { id: 'saved', title: 'Saved automatically', html: `
        <p>Your onion skin settings are saved in the browser, so they come back the next time you open Khuwari, even after loading a project.</p>
      ` }
    ]
  },
  {
    slug: 'blend-modes', title: 'Blend modes',
    blurb: '16 blend modes per keyframe, from multiply to luminosity.',
    sections: [
      { id: 'per-keyframe', title: 'Per keyframe blending', html: `
        <p>Each keyframe can blend with the layers below it in 16 different ways. Set the mode in the selection panel with a keyframe selected.</p>
        <table class="doc-table">
          <thead><tr><th>Group</th><th>Modes</th></tr></thead>
          <tbody>
            <tr><td>Normal</td><td>normal</td></tr>
            <tr><td>Darken</td><td>multiply, darken, color burn</td></tr>
            <tr><td>Lighten</td><td>screen, lighten, color dodge</td></tr>
            <tr><td>Contrast</td><td>overlay, hard light, soft light</td></tr>
            <tr><td>Invert</td><td>difference, exclusion</td></tr>
            <tr><td>Color</td><td>hue, saturation, color, luminosity</td></tr>
          </tbody>
        </table>
        ${FIG.blend}
      ` }
    ]
  },
  {
    slug: 'export', title: 'Export',
    blurb: 'PNG sequences, GIFs, video in five containers and exporting the current frame.',
    sections: [
      { id: 'formats', title: 'Formats', html: `
        <p>The <code>Export</code> button in the toolbar offers stills, a GIF, video in five containers and the current frame.</p>
        <table class="doc-table">
          <thead><tr><th>Format</th><th>Use it for</th></tr></thead>
          <tbody>
            <tr><td>PNG sequence (.zip)</td><td>frame by frame work, other tools</td></tr>
            <tr><td>Animated GIF</td><td>quick loops and web embeds</td></tr>
            <tr><td>MP4 video</td><td>the widest compatibility</td></tr>
            <tr><td>WebM video</td><td>small modern web videos</td></tr>
            <tr><td>MKV video</td><td>archival and everything inside one file</td></tr>
            <tr><td>MOV video</td><td>Apple and video editing workflows</td></tr>
            <tr><td>MPEG-TS video</td><td>broadcast and streaming</td></tr>
            <tr><td>Current frame (PNG)</td><td>a single still</td></tr>
          </tbody>
        </table>
        ${FIG.exportMenu}
      ` },
      { id: 'resolution', title: 'Resolution', html: `
        <p>Pick the export resolution from the export menu. Exports run in the background with a progress bar, and you can stop them if you change your mind.</p>
      ` }
    ]
  },
  {
    slug: 'settings', title: 'Settings',
    blurb: 'FPS, snapping, aspect ratios and the working size.',
    sections: [
      { id: 'fps', title: 'FPS', html: `
        <p>How many frames per second the timeline plays. Lower values are punchier and cheaper to generate, higher values are smoother.</p>
      ` },
      { id: 'snap', title: 'Snap to frames', html: `
        <p>Keeps the playhead and keyframes on whole frames, so times stay tidy. Turn it off for free placement.</p>
      ` },
      { id: 'aspect', title: 'Aspect ratio', html: `
        <p>Follow the first frame, pick a preset such as 16:9 or 1:1, or set a custom size or a manual ratio like 2.35.</p>
      ` },
      { id: 'work-size', title: 'Working size', html: `
        <p>The long edge of the working canvas, from 512 pixels down to 320. Smaller is noticeably faster to generate, and exports still come out at full resolution.</p>
        ${FIG.settingsMenu}
      ` }
    ]
  },
  {
    slug: 'shortcuts', title: 'Keyboard shortcuts',
    blurb: 'Playback and editing shortcuts, and when they are ignored.',
    sections: [
      { id: 'playback', title: 'Playback', html: `
        <table class="doc-table">
          <thead><tr><th>Key</th><th>Action</th></tr></thead>
          <tbody>
            <tr><td><kbd>Space</kbd></td><td>play or pause</td></tr>
            <tr><td><kbd>Left</kbd></td><td>step one frame back</td></tr>
            <tr><td><kbd>Right</kbd></td><td>step one frame forward</td></tr>
          </tbody>
        </table>
        ${FIG.keys}
      ` },
      { id: 'editing', title: 'Editing', html: `
        <table class="doc-table">
          <thead><tr><th>Key</th><th>Action</th></tr></thead>
          <tbody>
            <tr><td><kbd>Delete</kbd> or <kbd>Backspace</kbd></td><td>delete the selected keyframe</td></tr>
          </tbody>
        </table>
        <p>Shortcuts are ignored while you are typing in a field.</p>
      ` }
    ]
  },
  {
    slug: 'privacy', title: 'Privacy',
    blurb: 'How Khuwari stays local and what never leaves your machine.',
    sections: [
      { id: 'nothing-leaves', title: 'Nothing leaves your browser', html: `
        <p>Khuwari is a free and open source tool that runs entirely in your browser. No server, no backend, no cloud. The machine learning model downloads once and then runs locally on your machine.</p>
        <ul>
          <li>Your images never leave your machine.</li>
          <li>Your projects never leave your machine.</li>
          <li>Your exports never leave your machine.</li>
          <li>Your art is never sent anywhere and never used to train any model.</li>
          <li>There are no accounts and no tracking.</li>
        </ul>
      ` }
    ]
  }
];

const ALL_TITLES = CATEGORIES.map((c) => ({ slug: c.slug, title: c.title }));

function sidebar(activeSlug) {
  return `
  <nav class="doc-side-nav">
    ${ALL_TITLES.map((c) =>
      `<a href="${c.slug}.html"${c.slug === activeSlug ? ' class="active"' : ''}>${c.title}</a>`).join('\n    ')}
  </nav>`;
}

function page(cat, prev, next) {
  const prevNext = [];
  if (prev) prevNext.push(`<a class="pn-link" href="${prev.slug}.html"><span class="pn-dir">Previous</span>${prev.title}</a>`);
  else prevNext.push('<span class="pn-link pn-empty"></span>');
  if (next) prevNext.push(`<a class="pn-link next" href="${next.slug}.html"><span class="pn-dir">Next</span>${next.title}</a>`);
  else prevNext.push('<span class="pn-link pn-empty"></span>');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${cat.title} · Khuwari</title>
<meta name="description" content="${cat.blurb}">
<link rel="stylesheet" href="../site.css">
</head>
<body>

${NAV}

<div class="wrap doc-layout">

  <aside class="doc-side">
    <a class="doc-side-back" href="../docs.html">All docs</a>
    <div class="doc-side-title">Categories</div>
    ${sidebar(cat.slug)}
  </aside>

  <main class="doc-main">
    <nav class="crumbs rise" aria-label="Breadcrumb">
      <a href="../docs.html">Docs</a>
      <span class="crumb-sep">/</span>
      <span>${cat.title}</span>
    </nav>

    <header class="doc-head rise-1">
      <h1>${cat.title}</h1>
      <p>${cat.blurb}</p>
    </header>

    ${cat.sections.map((s, i) => `
    <section class="doc-sec" id="${s.id}">
      <h2>${s.title}</h2>
      ${s.html}
    </section>`).join('\n')}

    <nav class="pn-nav">
      ${prevNext.join('\n    ')}
    </nav>
  </main>

</div>

${FOOTER}

<script src="../site.js"></script>
</body>
</html>
`;
}

const idx = {};
CATEGORIES.forEach((c, i) => { idx[c.slug] = { cat: c, prev: CATEGORIES[i - 1] || null, next: CATEGORIES[i + 1] || null }; });

if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
CATEGORIES.forEach((c) => {
  const { prev, next } = idx[c.slug];
  fs.writeFileSync(path.join(OUT, c.slug + '.html'), page(c, prev, next));
  console.log('wrote', c.slug + '.html');
});
