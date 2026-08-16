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
    <a href="https://github.com/TheShovel/ijwta">GitHub</a>
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
      <a href="https://github.com/TheShovel/ijwta">GitHub</a>
    </div>
    <p class="footer-license">Khuwari is open source under the AGPL-3.0 license. Frame interpolation animation, right in your browser.</p>
  </div>
</footer>`;

// Shared SVG figure library. Every figure mirrors the real app UI (same
// palette and layout) so it reads like a screenshot; animated ones use the
// .fig-* CSS animations in site.css and pause under prefers-reduced-motion.
// Figures are authored at a 720-unit viewBox with fonts sized to match their
// boxes (no post-scaling), so text never overflows or clips.
const FIG = {
  // Full app window: toolbar, asset panel, canvas, selection panel, timeline.
  // Figures are authored at a 720-unit viewBox with fonts sized to match their
  // boxes (no post-scaling), so text never overflows or clips.
  appWindow: `
<figure class="doc-fig">
  <svg viewBox="0 0 720 480" role="img" aria-label="The Khuwari window with the toolbar on top, assets on the left, the canvas in the center, the selection panel on the right and the timeline along the bottom" class="fig-border">
    <!-- toolbar -->
    <rect x="8" y="8" width="704" height="44" rx="8" fill="rgba(34,39,46,0.92)" stroke="#39414d"/>
    <circle cx="28" cy="30" r="4.5" fill="#8aa3b9"/>
    <text x="40" y="35" font-size="14" fill="#e6e9ee" font-weight="650">Khuwari</text>
    <rect x="448" y="16" width="60" height="28" rx="7" fill="#2a3038" stroke="#39414d"/>
    <text x="478" y="34" font-size="13" fill="#e6e9ee" text-anchor="middle">File</text>
    <rect x="516" y="16" width="66" height="28" rx="7" fill="#2a3038" stroke="#39414d"/>
    <text x="549" y="34" font-size="13" fill="#e6e9ee" text-anchor="middle">Settings</text>
    <rect x="590" y="16" width="60" height="28" rx="7" fill="#2a3038" stroke="#39414d"/>
    <text x="620" y="34" font-size="13" fill="#e6e9ee" text-anchor="middle">Export</text>
    <rect x="658" y="16" width="46" height="28" rx="7" fill="#2a3038" stroke="#39414d"/>
    <text x="681" y="34" font-size="13" fill="#e6e9ee" text-anchor="middle">Help</text>
    <!-- assets panel -->
    <rect x="8" y="60" width="150" height="310" rx="8" fill="#22272e" stroke="#39414d"/>
    <text x="20" y="84" font-size="12" fill="#98a1ad" font-weight="700" letter-spacing="1">ASSETS</text>
    <rect x="16" y="92" width="134" height="28" rx="6" fill="#2a3038" stroke="#39414d"/>
    <text x="83" y="110" font-size="13" fill="#e6e9ee" text-anchor="middle">Add images…</text>
    <rect x="16" y="130" width="56" height="56" rx="6" fill="#0d0f12" stroke="#39414d"/>
    <circle cx="44" cy="158" r="12" fill="#8aa3b9"/>
    <rect x="80" y="130" width="56" height="56" rx="6" fill="#0d0f12" stroke="#39414d"/>
    <circle cx="108" cy="158" r="12" fill="#c3ab7d"/>
    <rect x="16" y="194" width="56" height="56" rx="6" fill="#0d0f12" stroke="#39414d"/>
    <rect x="26" y="212" width="36" height="24" rx="5" fill="#8fb0a2"/>
    <rect x="80" y="194" width="56" height="56" rx="6" fill="#0d0f12" stroke="#39414d"/>
    <circle cx="108" cy="222" r="12" fill="#c48181"/>
    <text x="16" y="264" font-size="12" fill="#98a1ad">hero.png</text>
    <text x="80" y="264" font-size="12" fill="#98a1ad">ball.png</text>
    <text x="16" y="280" font-size="12" fill="#98a1ad">bg.png</text>
    <text x="80" y="280" font-size="12" fill="#98a1ad">star.png</text>
    <!-- canvas -->
    <rect x="166" y="60" width="390" height="310" rx="8" fill="#161a20" stroke="#39414d"/>
    <g class="fig-anim fig-bob">
      <circle cx="361" cy="180" r="36" fill="none" stroke="#8aa3b9" stroke-width="3"/>
      <path d="M327 244 q34 -30 68 0 l-8 40 h-52 z" fill="none" stroke="#c3ab7d" stroke-width="3"/>
    </g>
    <circle cx="343" cy="232" r="5" fill="#c3ab7d"/>
    <circle cx="379" cy="232" r="5" fill="#c3ab7d"/>
    <rect x="333" y="254" width="56" height="24" rx="6" fill="none" stroke="#8fb0a2" stroke-width="2"/>
    <!-- selection panel -->
    <rect x="564" y="60" width="148" height="310" rx="8" fill="#22272e" stroke="#39414d"/>
    <text x="576" y="84" font-size="12" fill="#98a1ad" font-weight="700" letter-spacing="1">KEYFRAME</text>
    <rect x="576" y="92" width="52" height="52" rx="6" fill="#0d0f12" stroke="#c3ab7d"/>
    <circle cx="602" cy="118" r="14" fill="#8aa3b9"/>
    <text x="636" y="112" font-size="13.5" fill="#e6e9ee" font-weight="600">hero.png</text>
    <text x="636" y="128" font-size="12" fill="#98a1ad">0.00s</text>
    <text x="576" y="154" font-size="12.5" fill="#98a1ad">Time (s)</text>
    <rect x="576" y="160" width="124" height="28" rx="6" fill="#1e232a" stroke="#39414d"/>
    <text x="590" y="178" font-size="13" fill="#e6e9ee">0.00</text>
    <text x="576" y="196" font-size="12.5" fill="#98a1ad">Blend mode</text>
    <rect x="576" y="202" width="124" height="28" rx="6" fill="#1e232a" stroke="#39414d"/>
    <text x="590" y="220" font-size="13" fill="#e6e9ee">Normal</text>
    <rect x="576" y="240" width="60" height="30" rx="6" fill="#2a3038" stroke="#39414d"/>
    <text x="606" y="259" font-size="13" fill="#e6e9ee" text-anchor="middle">Replace</text>
    <rect x="640" y="240" width="60" height="30" rx="6" fill="#2a3038" stroke="#39414d"/>
    <text x="670" y="259" font-size="13" fill="#c48181" text-anchor="middle">Delete</text>
    <!-- timeline -->
    <rect x="8" y="378" width="704" height="28" fill="#191d23"/>
    <line x1="8" y1="406" x2="712" y2="406" stroke="#39414d"/>
    <text x="116" y="398" font-size="12" font-family="ui-monospace,Menlo,monospace" fill="#98a1ad">0s</text>
    <text x="326" y="398" font-size="12" font-family="ui-monospace,Menlo,monospace" fill="#98a1ad">1s</text>
    <text x="536" y="398" font-size="12" font-family="ui-monospace,Menlo,monospace" fill="#98a1ad">2s</text>
    <rect x="8" y="406" width="704" height="66" fill="#1b1f25"/>
    <rect x="8" y="406" width="96" height="66" fill="#22272e"/>
    <line x1="104" y1="406" x2="104" y2="472" stroke="#39414d"/>
    <text x="18" y="446" font-size="13.5" fill="#e6e9ee">Layer 1</text>
    <circle cx="88" cy="436" r="1.8" fill="#98a1ad" opacity="0.6"/><circle cx="88" cy="443" r="1.8" fill="#98a1ad" opacity="0.6"/><circle cx="88" cy="450" r="1.8" fill="#98a1ad" opacity="0.6"/>
    <rect x="120" y="418" width="54" height="54" rx="9" fill="rgba(195,171,125,0.09)" stroke="rgba(195,171,125,0.35)"/>
    <rect x="122" y="420" width="40" height="40" rx="6" fill="#0d0f12" stroke="#c3ab7d" stroke-width="2"/>
    <circle cx="142" cy="440" r="10" fill="none" stroke="#8aa3b9" stroke-width="2.5"/>
    <text x="124" y="468" font-size="12" font-family="ui-monospace,Menlo,monospace" fill="#cfd6e2">0.00s</text>
    <rect x="174" y="440" width="294" height="22" rx="5" fill="rgba(143,176,162,0.09)"/>
    <rect x="468" y="418" width="54" height="54" rx="9" fill="rgba(195,171,125,0.09)" stroke="rgba(195,171,125,0.35)"/>
    <rect x="470" y="420" width="40" height="40" rx="6" fill="#0d0f12" stroke="#c3ab7d" stroke-width="2"/>
    <circle cx="490" cy="440" r="10" fill="none" stroke="#8fb0a2" stroke-width="2.5"/>
    <text x="472" y="468" font-size="12" font-family="ui-monospace,Menlo,monospace" fill="#cfd6e2">2.00s</text>
    <g class="fig-anim fig-playhead">
      <line x1="330" y1="382" x2="330" y2="472" stroke="#c48181" stroke-width="2"/>
      <path d="M326 382 h8 l-4 6 z" fill="#c48181"/>
    </g>
  </svg>
  <figcaption>The whole Khuwari window. Your image library sits on the left, the canvas is in the middle, the selection panel is on the right, and the timeline runs along the bottom.</figcaption>
</figure>`,

  browserBar: `
<figure class="doc-fig">
  <svg viewBox="0 0 720 120" role="img" aria-label="A browser address bar showing localhost:4000" class="fig-border">
    <rect x="8" y="34" width="704" height="52" rx="10" fill="#22272e" stroke="#39414d"/>
    <circle cx="36" cy="60" r="5" fill="#c48181"/><circle cx="56" cy="60" r="5" fill="#c3ab7d"/><circle cx="76" cy="60" r="5" fill="#8fb0a2"/>
    <rect x="120" y="48" width="480" height="24" rx="12" fill="#1e232a" stroke="#39414d"/>
    <text x="200" y="64" font-size="15" fill="#98a1ad">localhost:4000</text>
  </svg>
  <figcaption>Serve the project folder, then open localhost:4000 in your browser.</figcaption>
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
  <figcaption>A project is one plain JSON file, easy to save, share and version.</figcaption>
</figure>`,

  assetsPanel: `
<figure class="doc-fig">
  <svg viewBox="0 0 720 270" role="img" aria-label="The assets panel with an image grid" class="fig-border">
    <rect x="8" y="8" width="210" height="254" rx="8" fill="#22272e" stroke="#39414d"/>
    <text x="20" y="32" font-size="12" fill="#98a1ad" font-weight="700" letter-spacing="1">ASSETS</text>
    <rect x="16" y="42" width="194" height="30" rx="6" fill="#2a3038" stroke="#39414d"/>
    <text x="113" y="61" font-size="13" fill="#e6e9ee" text-anchor="middle">Add images…</text>
    <rect x="16" y="84" width="56" height="56" rx="6" fill="#0d0f12" stroke="#39414d"/>
    <circle cx="44" cy="112" r="14" fill="#8aa3b9"/>
    <rect x="80" y="84" width="56" height="56" rx="6" fill="#0d0f12" stroke="#39414d"/>
    <circle cx="108" cy="112" r="14" fill="#c3ab7d"/>
    <rect x="144" y="84" width="56" height="56" rx="6" fill="#0d0f12" stroke="#39414d"/>
    <rect x="154" y="100" width="36" height="24" rx="5" fill="#8fb0a2"/>
    <rect x="16" y="148" width="56" height="56" rx="6" fill="#0d0f12" stroke="#39414d"/>
    <circle cx="44" cy="176" r="14" fill="#c48181"/>
    <rect x="80" y="148" width="56" height="56" rx="6" fill="#0d0f12" stroke="#39414d"/>
    <rect x="90" y="164" width="32" height="24" rx="5" fill="#8aa3b9"/>
    <text x="16" y="214" font-size="12" fill="#98a1ad">hero.png</text>
    <text x="80" y="214" font-size="12" fill="#98a1ad">ball.png</text>
    <text x="144" y="214" font-size="12" fill="#98a1ad">bg.png</text>
    <text x="16" y="230" font-size="12" fill="#98a1ad">star.png</text>
    <text x="80" y="230" font-size="12" fill="#98a1ad">box.png</text>
    <g>
      <circle cx="66" cy="94" r="9" fill="#c48181"/>
      <path d="M63 97 l6 -6 M69 97 l-6 -6" stroke="#161a20" stroke-width="1.5"/>
    </g>
    <text x="250" y="60" font-size="16.5" fill="#e6e9ee" font-weight="600">Your image library</text>
    <circle cx="258" cy="88" r="3.5" fill="#8aa3b9"/><text x="270" y="92" font-size="15" fill="#98a1ad">add images, then drag them onto the</text>
    <circle cx="258" cy="108" r="3.5" fill="#8aa3b9"/><text x="270" y="112" font-size="15" fill="#98a1ad">timeline to make keyframes</text>
    <circle cx="258" cy="128" r="3.5" fill="#8aa3b9"/><text x="270" y="132" font-size="15" fill="#98a1ad">hover a tile to delete it</text>
    <circle cx="258" cy="148" r="3.5" fill="#8aa3b9"/><text x="270" y="152" font-size="15" fill="#98a1ad">dragging a tile swings it around</text>
  </svg>
  <figcaption>The assets panel. Drag any tile onto the timeline to turn it into a keyframe.</figcaption>
</figure>`,

  previewFilmstrip: `
<figure class="doc-fig">
  <svg viewBox="0 0 720 260" role="img" aria-label="The preview canvas with the filmstrip below it" class="fig-border">
    <rect x="8" y="8" width="704" height="150" rx="8" fill="#161a20" stroke="#39414d"/>
    <g class="fig-anim fig-bob">
      <circle cx="360" cy="90" r="36" fill="none" stroke="#8aa3b9" stroke-width="3"/>
      <path d="M326 152 q34 -30 68 0 l-8 40 h-52 z" fill="none" stroke="#c3ab7d" stroke-width="3"/>
    </g>
    <rect x="8" y="166" width="704" height="86" rx="8" fill="#22272e" stroke="#39414d"/>
    <rect x="20" y="182" width="68" height="54" rx="6" fill="#0d0f12" stroke="#39414d"/>
    <circle cx="54" cy="202" r="11" fill="#8aa3b9" opacity="0.5"/>
    <text x="20" y="231" font-size="12" font-family="ui-monospace,Menlo,monospace" fill="#cfd6e2">0.00s</text>
    <rect x="96" y="182" width="68" height="54" rx="6" fill="#0d0f12" stroke="#39414d"/>
    <circle cx="130" cy="202" r="11" fill="#8aa3b9" opacity="0.5"/>
    <text x="96" y="231" font-size="12" font-family="ui-monospace,Menlo,monospace" fill="#cfd6e2">0.08s</text>
    <rect x="172" y="182" width="68" height="54" rx="6" fill="#0d0f12" stroke="#8aa3b9" stroke-width="2"/>
    <circle cx="206" cy="202" r="11" fill="#8aa3b9"/>
    <text x="172" y="231" font-size="12" font-family="ui-monospace,Menlo,monospace" fill="#cfd6e2">0.17s</text>
    <rect x="248" y="182" width="68" height="54" rx="6" fill="#0d0f12" stroke="#39414d"/>
    <circle cx="282" cy="202" r="11" fill="#8aa3b9" opacity="0.5"/>
    <text x="248" y="231" font-size="12" font-family="ui-monospace,Menlo,monospace" fill="#cfd6e2">0.25s</text>
    <rect x="324" y="182" width="68" height="54" rx="6" fill="#0d0f12" stroke="#c3ab7d"/>
    <circle cx="358" cy="202" r="11" fill="#c3ab7d"/>
    <text x="324" y="231" font-size="12" font-family="ui-monospace,Menlo,monospace" fill="#cfd6e2">key</text>
    <text x="410" y="206" font-size="15" fill="#98a1ad">every frame gets a thumb</text>
    <text x="410" y="222" font-size="15" fill="#98a1ad">keyframes are gold, the current</text>
    <text x="410" y="238" font-size="15" fill="#98a1ad">frame has a blue ring</text>
  </svg>
  <figcaption>The preview canvas with the filmstrip below. Click any thumb to jump to that frame.</figcaption>
</figure>`,

  timelineLayers: `
<figure class="doc-fig">
  <svg viewBox="0 0 720 310" role="img" aria-label="The timeline with two layers, keyframe chips and a gap" class="fig-border">
    <rect x="8" y="8" width="704" height="28" fill="#191d23"/>
    <line x1="8" y1="36" x2="712" y2="36" stroke="#39414d"/>
    <text x="116" y="28" font-size="12" font-family="ui-monospace,Menlo,monospace" fill="#98a1ad">0s</text>
    <text x="326" y="28" font-size="12" font-family="ui-monospace,Menlo,monospace" fill="#98a1ad">1s</text>
    <text x="536" y="28" font-size="12" font-family="ui-monospace,Menlo,monospace" fill="#98a1ad">2s</text>
    <rect x="8" y="36" width="704" height="66" fill="#1b1f25"/>
    <rect x="8" y="36" width="96" height="66" fill="#22272e"/>
    <line x1="104" y1="36" x2="104" y2="102" stroke="#39414d"/>
    <text x="18" y="76" font-size="13.5" fill="#e6e9ee">Layer 1</text>
    <circle cx="88" cy="66" r="1.8" fill="#98a1ad" opacity="0.6"/><circle cx="88" cy="73" r="1.8" fill="#98a1ad" opacity="0.6"/><circle cx="88" cy="80" r="1.8" fill="#98a1ad" opacity="0.6"/>
    <rect x="120" y="48" width="54" height="54" rx="9" fill="rgba(195,171,125,0.09)" stroke="rgba(195,171,125,0.35)"/>
    <rect x="122" y="50" width="40" height="40" rx="6" fill="#0d0f12" stroke="#c3ab7d" stroke-width="2"/>
    <circle cx="142" cy="70" r="10" fill="none" stroke="#8aa3b9" stroke-width="2.5"/>
    <text x="124" y="98" font-size="12" font-family="ui-monospace,Menlo,monospace" fill="#cfd6e2">0.00s</text>
    <rect x="174" y="70" width="294" height="22" rx="5" fill="rgba(143,176,162,0.09)"/>
    <rect x="240" y="54" width="84" height="18" rx="5" fill="#313844" stroke="#39414d"/>
    <text x="246" y="67" font-size="12" font-family="ui-monospace,Menlo,monospace" fill="#98a1ad">11 frames</text>
    <g class="fig-anim fig-dots">
      <circle cx="196" cy="81" r="3.5" fill="#8fb0a2"/>
      <circle cx="236" cy="81" r="3.5" fill="#8fb0a2"/>
      <circle cx="296" cy="81" r="3.5" fill="#8fb0a2"/>
      <circle cx="336" cy="81" r="3.5" fill="#8fb0a2"/>
      <circle cx="376" cy="81" r="3.5" fill="#8fb0a2"/>
      <circle cx="416" cy="81" r="3.5" fill="#8fb0a2"/>
      <circle cx="456" cy="81" r="3.5" fill="#8fb0a2"/>
    </g>
    <rect x="468" y="48" width="54" height="54" rx="9" fill="rgba(195,171,125,0.09)" stroke="rgba(195,171,125,0.35)"/>
    <rect x="470" y="50" width="40" height="40" rx="6" fill="#0d0f12" stroke="#c3ab7d" stroke-width="2"/>
    <circle cx="490" cy="70" r="10" fill="none" stroke="#8fb0a2" stroke-width="2.5"/>
    <text x="472" y="98" font-size="12" font-family="ui-monospace,Menlo,monospace" fill="#cfd6e2">2.00s</text>
    <line x1="8" y1="102" x2="712" y2="102" stroke="#39414d" opacity="0.5"/>
    <rect x="8" y="102" width="704" height="62" fill="#1b1f25"/>
    <rect x="8" y="102" width="96" height="62" fill="#22272e"/>
    <line x1="104" y1="102" x2="104" y2="164" stroke="#39414d"/>
    <text x="18" y="138" font-size="13.5" fill="#98a1ad">Color 2</text>
    <circle cx="88" cy="128" r="1.8" fill="#98a1ad" opacity="0.6"/><circle cx="88" cy="135" r="1.8" fill="#98a1ad" opacity="0.6"/><circle cx="88" cy="142" r="1.8" fill="#98a1ad" opacity="0.6"/>
    <rect x="180" y="109" width="140" height="22" rx="7" fill="rgba(79,143,255,0.12)" stroke="rgba(79,143,255,0.4)"/>
    <circle cx="191" cy="120" r="6" fill="#4f8fff" stroke="rgba(255,255,255,0.35)"/>
    <text x="202" y="124" font-size="12" font-family="ui-monospace,Menlo,monospace" fill="#c3cbd6">0.00-1.00</text>
    <rect x="314" y="109" width="6" height="22" rx="3" fill="rgba(255,255,255,0.12)"/>
    <rect x="180" y="135" width="140" height="22" rx="7" fill="rgba(79,143,255,0.12)" stroke="rgba(79,143,255,0.4)"/>
    <circle cx="191" cy="146" r="6" fill="#c3ab7d" stroke="rgba(255,255,255,0.35)"/>
    <text x="202" y="150" font-size="12" font-family="ui-monospace,Menlo,monospace" fill="#c3cbd6">0.00-1.00</text>
    <rect x="314" y="135" width="6" height="22" rx="3" fill="rgba(255,255,255,0.12)"/>
    <line x1="8" y1="164" x2="712" y2="164" stroke="#39414d" opacity="0.5"/>
    <g class="fig-anim fig-playhead">
      <line x1="330" y1="12" x2="330" y2="164" stroke="#c48181" stroke-width="2"/>
      <path d="M326 12 h8 l-4 6 z" fill="#c48181"/>
    </g>
    <text x="410" y="196" font-size="15" fill="#98a1ad">chips sit on each layer track</text>
    <text x="410" y="214" font-size="15" fill="#98a1ad">the space between chips is a gap</text>
    <text x="410" y="232" font-size="15" fill="#98a1ad">color layers stay thin and hold dots</text>
  </svg>
  <figcaption>The timeline. Keyframes are chips on their layer's track; the playhead sweeps through as it plays.</figcaption>
</figure>`,

  selectionPanel: `
<figure class="doc-fig">
  <svg viewBox="0 0 720 300" role="img" aria-label="The selection panel with a selected keyframe" class="fig-border">
    <rect x="8" y="8" width="260" height="284" rx="8" fill="#22272e" stroke="#39414d"/>
    <text x="20" y="32" font-size="12" fill="#98a1ad" font-weight="700" letter-spacing="1">KEYFRAME</text>
    <rect x="20" y="44" width="60" height="60" rx="8" fill="#0d0f12" stroke="#c3ab7d"/>
    <circle cx="50" cy="74" r="15" fill="#8aa3b9"/>
    <text x="92" y="68" font-size="14.5" fill="#e6e9ee" font-weight="600">hero.png</text>
    <text x="92" y="86" font-size="12" fill="#98a1ad">0.00s</text>
    <text x="20" y="124" font-size="12.5" fill="#98a1ad">Time (s)</text>
    <rect x="20" y="130" width="236" height="30" rx="7" fill="#1e232a" stroke="#39414d"/>
    <text x="34" y="150" font-size="13.5" fill="#e6e9ee">0.00</text>
    <text x="20" y="182" font-size="12.5" fill="#98a1ad">Blend mode</text>
    <rect x="20" y="188" width="236" height="30" rx="7" fill="#1e232a" stroke="#39414d"/>
    <text x="34" y="208" font-size="13.5" fill="#e6e9ee">Normal</text>
    <path d="M236 198 l6 6 10 -10" stroke="#8aa3b9" stroke-width="2" fill="none"/>
    <rect x="20" y="232" width="114" height="32" rx="7" fill="#2a3038" stroke="#39414d"/>
    <text x="77" y="253" font-size="13.5" fill="#e6e9ee" text-anchor="middle">Replace image</text>
    <rect x="142" y="232" width="114" height="32" rx="7" fill="#2a3038" stroke="#39414d"/>
    <text x="199" y="253" font-size="13.5" fill="#c48181" text-anchor="middle">Delete</text>
    <text x="300" y="70" font-size="16.5" fill="#e6e9ee" font-weight="600">What you can do here</text>
    <circle cx="308" cy="100" r="3.5" fill="#8aa3b9"/><text x="320" y="104" font-size="15" fill="#98a1ad">move the frame to an exact time</text>
    <circle cx="308" cy="126" r="3.5" fill="#8aa3b9"/><text x="320" y="130" font-size="15" fill="#98a1ad">pick one of 16 blend modes</text>
    <circle cx="308" cy="152" r="3.5" fill="#8aa3b9"/><text x="320" y="156" font-size="15" fill="#98a1ad">swap in different art</text>
    <circle cx="308" cy="178" r="3.5" fill="#8aa3b9"/><text x="320" y="182" font-size="15" fill="#98a1ad">remove the keyframe</text>
  </svg>
  <figcaption>Select a keyframe and its details appear in the right panel.</figcaption>
</figure>`,

  kfChip: `
<figure class="doc-fig">
  <svg viewBox="0 0 720 210" role="img" aria-label="A keyframe chip being dragged, with resize handles at its edges" class="fig-border">
    <rect x="8" y="8" width="704" height="28" fill="#191d23"/>
    <line x1="8" y1="36" x2="712" y2="36" stroke="#39414d"/>
    <text x="116" y="28" font-size="12" font-family="ui-monospace,Menlo,monospace" fill="#98a1ad">0s</text>
    <text x="326" y="28" font-size="12" font-family="ui-monospace,Menlo,monospace" fill="#98a1ad">1s</text>
    <text x="536" y="28" font-size="12" font-family="ui-monospace,Menlo,monospace" fill="#98a1ad">2s</text>
    <rect x="8" y="36" width="704" height="66" fill="#1b1f25"/>
    <rect x="8" y="36" width="96" height="66" fill="#22272e"/>
    <line x1="104" y1="36" x2="104" y2="102" stroke="#39414d"/>
    <text x="18" y="76" font-size="13.5" fill="#e6e9ee">Layer 1</text>
    <rect x="150" y="48" width="60" height="54" rx="8" fill="none" stroke="#39414d" stroke-dasharray="4 4"/>
    <g class="fig-anim fig-drag">
      <rect x="250" y="48" width="60" height="54" rx="8" fill="rgba(195,171,125,0.12)" stroke="#c3ab7d" stroke-width="2"/>
      <rect x="252" y="50" width="34" height="34" rx="5" fill="#0d0f12" stroke="#c3ab7d" stroke-width="2"/>
      <circle cx="269" cy="67" r="8" fill="none" stroke="#8aa3b9" stroke-width="2.5"/>
      <text x="254" y="98" font-size="12" font-family="ui-monospace,Menlo,monospace" fill="#cfd6e2">1.00s</text>
      <rect x="302" y="48" width="8" height="54" rx="4" fill="rgba(195,171,125,0.22)"/>
      <rect x="305" y="65" width="2" height="20" rx="1" fill="rgba(195,171,125,0.5)"/>
    </g>
    <text x="390" y="60" font-size="15" fill="#98a1ad">drag the body to move the frame</text>
    <text x="390" y="80" font-size="15" fill="#98a1ad">drag the edges to change the hold</text>
  </svg>
  <figcaption>Drag the chip to retime it; drag its edges to change how long it holds.</figcaption>
</figure>`,

  gapInbetween: `
<figure class="doc-fig">
  <svg viewBox="0 0 720 230" role="img" aria-label="Two keyframes with generated inbetween frames appearing between them" class="fig-border">
    <rect x="8" y="8" width="704" height="28" fill="#191d23"/>
    <line x1="8" y1="36" x2="712" y2="36" stroke="#39414d"/>
    <text x="116" y="28" font-size="12" font-family="ui-monospace,Menlo,monospace" fill="#98a1ad">0s</text>
    <text x="326" y="28" font-size="12" font-family="ui-monospace,Menlo,monospace" fill="#98a1ad">1s</text>
    <rect x="8" y="36" width="704" height="66" fill="#1b1f25"/>
    <rect x="8" y="36" width="96" height="66" fill="#22272e"/>
    <line x1="104" y1="36" x2="104" y2="102" stroke="#39414d"/>
    <text x="18" y="76" font-size="13.5" fill="#e6e9ee">Layer 1</text>
    <rect x="120" y="48" width="54" height="54" rx="9" fill="rgba(195,171,125,0.09)" stroke="rgba(195,171,125,0.35)"/>
    <rect x="122" y="50" width="40" height="40" rx="6" fill="#0d0f12" stroke="#c3ab7d" stroke-width="2"/>
    <circle cx="142" cy="70" r="10" fill="none" stroke="#8aa3b9" stroke-width="2.5"/>
    <rect x="174" y="70" width="330" height="22" rx="5" fill="rgba(143,176,162,0.09)"/>
    <rect x="272" y="54" width="84" height="18" rx="5" fill="#313844" stroke="#39414d"/>
    <text x="278" y="67" font-size="12" font-family="ui-monospace,Menlo,monospace" fill="#98a1ad">11 frames</text>
    <g class="fig-anim fig-dots">
      <circle cx="200" cy="81" r="3.5" fill="#8fb0a2"/>
      <circle cx="240" cy="81" r="3.5" fill="#8fb0a2"/>
      <circle cx="300" cy="81" r="3.5" fill="#8fb0a2"/>
      <circle cx="340" cy="81" r="3.5" fill="#8fb0a2"/>
      <circle cx="380" cy="81" r="3.5" fill="#8fb0a2"/>
      <circle cx="420" cy="81" r="3.5" fill="#8fb0a2"/>
      <circle cx="460" cy="81" r="3.5" fill="#8fb0a2"/>
    </g>
    <rect x="504" y="48" width="54" height="54" rx="9" fill="rgba(195,171,125,0.09)" stroke="rgba(195,171,125,0.35)"/>
    <rect x="506" y="50" width="40" height="40" rx="6" fill="#0d0f12" stroke="#c3ab7d" stroke-width="2"/>
    <circle cx="526" cy="70" r="10" fill="none" stroke="#8fb0a2" stroke-width="2.5"/>
    <text x="120" y="140" font-size="15" fill="#98a1ad">between two keyframes is a gap</text>
    <text x="120" y="158" font-size="15" fill="#98a1ad">the sage band means it is generated and ready</text>
    <text x="120" y="176" font-size="15" fill="#98a1ad">the dots are the frames the model made</text>
  </svg>
  <figcaption>Between two keyframes is a gap. Khuwari generates the inbetween frames for it.</figcaption>
</figure>`,

  squash: `
<figure class="doc-fig">
  <svg viewBox="0 0 720 240" role="img" aria-label="A shape squashing and stretching across a gap, with the squash gap options" class="fig-border">
    <rect x="8" y="8" width="400" height="210" rx="8" fill="#161a20" stroke="#39414d"/>
    <line x1="40" y1="120" x2="376" y2="120" stroke="#39414d" stroke-dasharray="4 4"/>
    <rect x="60" y="86" width="60" height="60" rx="10" fill="#c3ab7d" opacity="0.9"/>
    <rect x="300" y="86" width="60" height="60" rx="10" fill="#c3ab7d" opacity="0.9"/>
    <g class="fig-anim fig-squash">
      <rect x="165" y="98" width="60" height="34" rx="12" fill="#8aa3b9"/>
    </g>
    <text x="208" y="190" font-size="14" fill="#98a1ad" text-anchor="middle">squash flattens the shape mid-gap</text>
    <rect x="416" y="8" width="296" height="210" rx="10" fill="#22272e" stroke="#39414d"/>
    <text x="432" y="34" font-size="12" fill="#98a1ad" font-weight="700" letter-spacing="1">GAP</text>
    <text x="432" y="60" font-size="12.5" fill="#98a1ad">Interpolation</text>
    <rect x="432" y="66" width="264" height="32" rx="7" fill="#1e232a" stroke="#39414d"/>
    <text x="448" y="86" font-size="13.5" fill="#e6e9ee">Squash</text>
    <path d="M676 76 l6 6 10 -10" stroke="#8aa3b9" stroke-width="2" fill="none"/>
    <text x="432" y="120" font-size="12.5" fill="#98a1ad">Squash amount <tspan fill="#c3cbd6" font-family="ui-monospace,Menlo,monospace">auto</tspan></text>
    <rect x="432" y="126" width="264" height="5" rx="2.5" fill="#39414d"/>
    <rect x="432" y="126" width="110" height="5" rx="2.5" fill="#8aa3b9"/>
    <circle cx="542" cy="128" r="8" fill="#8aa3b9" stroke="#161a20" stroke-width="2"/>
    <text x="432" y="160" font-size="12.5" fill="#98a1ad">Curve</text>
    <rect x="432" y="166" width="264" height="32" rx="7" fill="#1e232a" stroke="#39414d"/>
    <text x="448" y="186" font-size="13.5" fill="#e6e9ee">Anticipation</text>
    <path d="M676 176 l6 6 10 -10" stroke="#8aa3b9" stroke-width="2" fill="none"/>
  </svg>
  <figcaption>Squash mode deforms the inbetweens for cartoon motion.</figcaption>
</figure>`,

  motionBlur: `
<figure class="doc-fig">
  <svg viewBox="0 0 720 240" role="img" aria-label="A shape smearing horizontally to show motion blur, with the blur gap options" class="fig-border">
    <rect x="8" y="8" width="400" height="210" rx="8" fill="#161a20" stroke="#39414d"/>
    <line x1="40" y1="120" x2="376" y2="120" stroke="#39414d" stroke-dasharray="4 4"/>
    <circle cx="90" cy="120" r="28" fill="#c3ab7d"/>
    <circle cx="330" cy="120" r="28" fill="#c3ab7d"/>
    <g class="fig-anim fig-blur">
      <circle cx="210" cy="120" r="28" fill="#8aa3b9" opacity="0.85"/>
    </g>
    <text x="208" y="190" font-size="14" fill="#98a1ad" text-anchor="middle">the frame stretches along its motion</text>
    <rect x="416" y="8" width="296" height="210" rx="10" fill="#22272e" stroke="#39414d"/>
    <text x="432" y="34" font-size="12" fill="#98a1ad" font-weight="700" letter-spacing="1">GAP</text>
    <text x="432" y="60" font-size="15" fill="#e6e9ee" font-weight="600">Motion blur</text>
    <rect x="432" y="70" width="16" height="16" rx="4" fill="#8aa3b9"/>
    <path d="M435 78 l2.5 2.5 4.5 -4.5" stroke="#161a20" stroke-width="2" fill="none"/>
    <text x="456" y="83" font-size="13" fill="#98a1ad">on for this gap</text>
    <text x="432" y="114" font-size="12.5" fill="#98a1ad">Blur intensity <tspan fill="#c3cbd6" font-family="ui-monospace,Menlo,monospace">50%</tspan></text>
    <rect x="432" y="120" width="264" height="5" rx="2.5" fill="#39414d"/>
    <rect x="432" y="120" width="132" height="5" rx="2.5" fill="#8aa3b9"/>
    <circle cx="564" cy="122" r="8" fill="#8aa3b9" stroke="#161a20" stroke-width="2"/>
    <text x="432" y="156" font-size="13" fill="#98a1ad">eases in and out with how much</text>
    <text x="432" y="172" font-size="13" fill="#98a1ad">the frame changed in between</text>
    <text x="432" y="192" font-size="13" fill="#98a1ad">hides small imperfections</text>
  </svg>
  <figcaption>Motion blur smears the inbetweens along their movement, easing in and out.</figcaption>
</figure>`,

  colorFill: `
<figure class="doc-fig">
  <svg viewBox="0 0 720 290" role="img" aria-label="A dot filling the area inside a line art ring, with its chip on the color layer" class="fig-border">
    <rect x="8" y="8" width="420" height="210" rx="8" fill="#161a20" stroke="#39414d"/>
    <rect x="118" y="50" width="200" height="128" rx="10" fill="none" stroke="#22272e" stroke-width="16"/>
    <rect x="118" y="50" width="200" height="128" rx="10" fill="none" stroke="#0d0f12" stroke-width="14"/>
    <g class="fig-anim fig-fillc">
      <rect x="132" y="64" width="172" height="114" rx="10" fill="rgba(79,143,255,0.55)"/>
    </g>
    <circle cx="218" cy="114" r="7" fill="#4f8fff" stroke="#8aa3b9" stroke-width="2"/>
    <rect x="8" y="226" width="420" height="58" fill="#1b1f25"/>
    <rect x="8" y="226" width="96" height="58" fill="#22272e"/>
    <line x1="104" y1="226" x2="104" y2="284" stroke="#39414d"/>
    <text x="18" y="260" font-size="13.5" fill="#98a1ad">Color 1</text>
    <rect x="150" y="233" width="160" height="22" rx="7" fill="rgba(79,143,255,0.12)" stroke="rgba(79,143,255,0.4)"/>
    <circle cx="161" cy="244" r="6" fill="#4f8fff" stroke="rgba(255,255,255,0.35)"/>
    <text x="172" y="248" font-size="12" font-family="ui-monospace,Menlo,monospace" fill="#c3cbd6">0.00-2.00</text>
    <rect x="304" y="233" width="6" height="22" rx="3" fill="rgba(255,255,255,0.12)"/>
    <text x="452" y="60" font-size="16.5" fill="#e6e9ee" font-weight="600">One dot fills a region</text>
    <circle cx="460" cy="92" r="3.5" fill="#8aa3b9"/><text x="472" y="96" font-size="15" fill="#98a1ad">place the dot inside the lines</text>
    <circle cx="460" cy="118" r="3.5" fill="#8aa3b9"/><text x="472" y="122" font-size="15" fill="#98a1ad">it floods the connected region</text>
    <circle cx="460" cy="144" r="3.5" fill="#8aa3b9"/><text x="472" y="148" font-size="15" fill="#98a1ad">threshold sets line strength</text>
    <circle cx="460" cy="170" r="3.5" fill="#8aa3b9"/><text x="472" y="174" font-size="15" fill="#98a1ad">needed to block the fill</text>
    <circle cx="460" cy="196" r="3.5" fill="#8aa3b9"/><text x="472" y="200" font-size="15" fill="#98a1ad">grow tucks color under edges</text>
    <circle cx="460" cy="222" r="3.5" fill="#8aa3b9"/><text x="472" y="226" font-size="15" fill="#98a1ad">the chip sets its active window</text>
  </svg>
  <figcaption>Each dot flood-fills the connected area inside the nearest lines.</figcaption>
</figure>`,

  dotStack: `
<figure class="doc-fig">
  <svg viewBox="0 0 720 250" role="img" aria-label="Overlapping dot chips stacking into separate rows" class="fig-border">
    <rect x="8" y="8" width="704" height="28" fill="#191d23"/>
    <line x1="8" y1="36" x2="712" y2="36" stroke="#39414d"/>
    <text x="116" y="28" font-size="12" font-family="ui-monospace,Menlo,monospace" fill="#98a1ad">0s</text>
    <text x="326" y="28" font-size="12" font-family="ui-monospace,Menlo,monospace" fill="#98a1ad">1s</text>
    <rect x="8" y="36" width="704" height="92" fill="#1b1f25"/>
    <rect x="8" y="36" width="96" height="92" fill="#22272e"/>
    <line x1="104" y1="36" x2="104" y2="128" stroke="#39414d"/>
    <text x="18" y="86" font-size="13.5" fill="#98a1ad">Color 1</text>
    <circle cx="88" cy="76" r="1.8" fill="#98a1ad" opacity="0.6"/><circle cx="88" cy="83" r="1.8" fill="#98a1ad" opacity="0.6"/><circle cx="88" cy="90" r="1.8" fill="#98a1ad" opacity="0.6"/>
    <g class="fig-anim fig-drop">
      <rect x="180" y="43" width="130" height="22" rx="7" fill="rgba(79,143,255,0.12)" stroke="rgba(79,143,255,0.4)"/>
      <circle cx="191" cy="54" r="6" fill="#4f8fff" stroke="rgba(255,255,255,0.35)"/>
      <text x="202" y="58" font-size="12" font-family="ui-monospace,Menlo,monospace" fill="#c3cbd6">0.00-1.00</text>
    </g>
    <g class="fig-anim fig-drop fig-drop-1">
      <rect x="180" y="69" width="130" height="22" rx="7" fill="rgba(79,143,255,0.12)" stroke="rgba(79,143,255,0.4)"/>
      <circle cx="191" cy="80" r="6" fill="#c3ab7d" stroke="rgba(255,255,255,0.35)"/>
      <text x="202" y="84" font-size="12" font-family="ui-monospace,Menlo,monospace" fill="#c3cbd6">0.00-1.00</text>
    </g>
    <g class="fig-anim fig-drop fig-drop-2">
      <rect x="180" y="95" width="130" height="22" rx="7" fill="rgba(79,143,255,0.12)" stroke="rgba(79,143,255,0.4)"/>
      <circle cx="191" cy="106" r="6" fill="#8fb0a2" stroke="rgba(255,255,255,0.35)"/>
      <text x="202" y="110" font-size="12" font-family="ui-monospace,Menlo,monospace" fill="#c3cbd6">1.00-2.00</text>
    </g>
    <text x="350" y="60" font-size="16.5" fill="#e6e9ee" font-weight="600">Dots that overlap stack</text>
    <text x="350" y="86" font-size="15" fill="#98a1ad">each one gets its own row, so chips</text>
    <text x="350" y="102" font-size="15" fill="#98a1ad">never cover each other</text>
    <text x="350" y="130" font-size="15" fill="#98a1ad">the layer grows to fit however many</text>
    <text x="350" y="146" font-size="15" fill="#98a1ad">dots you add. there is no limit</text>
  </svg>
  <figcaption>Overlapping dots stack into their own rows, and the layer grows to fit.</figcaption>
</figure>`,

  onion: `
<figure class="doc-fig">
  <svg viewBox="0 0 720 260" role="img" aria-label="Onion skinning showing ghost frames behind the current one, with the onion settings menu" class="fig-border">
    <rect x="8" y="8" width="500" height="200" rx="8" fill="#161a20" stroke="#39414d"/>
    <g class="fig-anim fig-fade">
      <circle cx="150" cy="104" r="28" fill="none" stroke="#8aa3b9" stroke-width="3"/>
      <path d="M124 158 q26 -24 52 0 l-6 32 h-40 z" fill="none" stroke="#c3ab7d" stroke-width="3"/>
    </g>
    <g class="fig-anim fig-fade fig-fade-1">
      <circle cx="270" cy="104" r="28" fill="none" stroke="#8aa3b9" stroke-width="3"/>
      <path d="M244 158 q26 -24 52 0 l-6 32 h-40 z" fill="none" stroke="#c3ab7d" stroke-width="3"/>
    </g>
    <circle cx="390" cy="104" r="28" fill="none" stroke="#e6e9ee" stroke-width="3"/>
    <path d="M364 158 q26 -24 52 0 l-6 32 h-40 z" fill="none" stroke="#e6e9ee" stroke-width="3"/>
    <rect x="520" y="8" width="192" height="200" rx="10" fill="#2a3038" stroke="#39414d"/>
    <text x="536" y="32" font-size="14" font-weight="600" fill="#e6e9ee">Onion skin</text>
    <text x="536" y="60" font-size="12.5" fill="#98a1ad">Frames before <tspan fill="#c3cbd6" font-family="ui-monospace,Menlo,monospace">2</tspan></text>
    <rect x="536" y="66" width="160" height="5" rx="2.5" fill="#39414d"/>
    <rect x="536" y="66" width="80" height="5" rx="2.5" fill="#8aa3b9"/>
    <circle cx="616" cy="68" r="8" fill="#8aa3b9" stroke="#161a20" stroke-width="2"/>
    <text x="536" y="92" font-size="12.5" fill="#98a1ad">Frames after <tspan fill="#c3cbd6" font-family="ui-monospace,Menlo,monospace">2</tspan></text>
    <rect x="536" y="98" width="160" height="5" rx="2.5" fill="#39414d"/>
    <rect x="536" y="98" width="80" height="5" rx="2.5" fill="#8aa3b9"/>
    <circle cx="616" cy="100" r="8" fill="#8aa3b9" stroke="#161a20" stroke-width="2"/>
    <text x="536" y="124" font-size="12.5" fill="#98a1ad">Opacity <tspan fill="#c3cbd6" font-family="ui-monospace,Menlo,monospace">28%</tspan></text>
    <rect x="536" y="130" width="160" height="5" rx="2.5" fill="#39414d"/>
    <rect x="536" y="130" width="52" height="5" rx="2.5" fill="#8aa3b9"/>
    <circle cx="588" cy="132" r="8" fill="#8aa3b9" stroke="#161a20" stroke-width="2"/>
    <rect x="536" y="150" width="16" height="16" rx="4" fill="#8aa3b9"/>
    <path d="M539 158 l2.5 2.5 4.5 -4.5" stroke="#161a20" stroke-width="2" fill="none"/>
    <text x="560" y="163" font-size="13" fill="#e6e9ee">Tint</text>
    <rect x="536" y="178" width="28" height="20" rx="4" fill="#1e232a" stroke="#39414d"/>
    <rect x="540" y="182" width="20" height="12" rx="2" fill="#ff3b30"/>
    <text x="360" y="232" font-size="15" fill="#98a1ad" text-anchor="middle">ghosts fade in from both sides; the tint option recolors them</text>
  </svg>
  <figcaption>Onion skinning keeps the neighboring frames faintly visible while you work.</figcaption>
</figure>`,

  blend: `
<figure class="doc-fig">
  <svg viewBox="0 0 720 230" role="img" aria-label="Two overlapping shapes showing a blend mode" class="fig-border">
    <rect x="8" y="8" width="400" height="200" rx="8" fill="#161a20" stroke="#39414d"/>
    <circle cx="170" cy="108" r="60" fill="rgba(138,163,185,0.55)"/>
    <g class="fig-anim fig-blend">
      <circle cx="290" cy="108" r="60" fill="rgba(195,171,125,0.55)"/>
    </g>
    <text x="208" y="184" font-size="14" fill="#98a1ad" text-anchor="middle">the overlap changes with the blend mode</text>
    <rect x="420" y="8" width="292" height="200" rx="10" fill="#22272e" stroke="#39414d"/>
    <text x="436" y="34" font-size="12" fill="#98a1ad" font-weight="700" letter-spacing="1">KEYFRAME</text>
    <text x="436" y="60" font-size="12.5" fill="#98a1ad">Blend mode</text>
    <rect x="436" y="66" width="260" height="32" rx="7" fill="#1e232a" stroke="#39414d"/>
    <text x="452" y="86" font-size="13.5" fill="#e6e9ee">Multiply</text>
    <path d="M676 76 l6 6 10 -10" stroke="#8aa3b9" stroke-width="2" fill="none"/>
    <text x="436" y="118" font-size="13" fill="#98a1ad">16 modes, from normal to</text>
    <text x="436" y="134" font-size="13" fill="#98a1ad">luminosity, per keyframe</text>
    <text x="436" y="164" font-size="13" fill="#98a1ad">great for shading passes,</text>
    <text x="436" y="180" font-size="13" fill="#98a1ad">highlights and overlays</text>
  </svg>
  <figcaption>Each keyframe can blend with the layers below it in 16 different ways.</figcaption>
</figure>`,

  exportMenu: `
<figure class="doc-fig">
  <svg viewBox="0 0 720 330" role="img" aria-label="The export menu with the video format dropdown open and resolution options" class="fig-border">
    <rect x="8" y="8" width="300" height="314" rx="10" fill="#2a3038" stroke="#39414d"/>
    <text x="28" y="40" font-size="13.5" fill="#98a1ad">Format</text>
    <rect x="28" y="48" width="260" height="150" rx="7" fill="#1e232a" stroke="#39414d"/>
    <rect x="36" y="58" width="244" height="26" rx="6" fill="#313844"/>
    <text x="44" y="76" font-size="14" fill="#e6e9ee">MP4 video</text>
    <text x="44" y="102" font-size="14" fill="#e6e9ee">WebM video</text>
    <text x="44" y="128" font-size="14" fill="#e6e9ee">MKV video</text>
    <text x="44" y="154" font-size="14" fill="#e6e9ee">MOV video</text>
    <text x="44" y="180" font-size="14" fill="#e6e9ee">MPEG-TS video</text>
    <path d="M272 120 l7 7 7 -7" stroke="#8aa3b9" stroke-width="2" fill="none"/>
    <text x="28" y="222" font-size="13.5" fill="#98a1ad">Resolution</text>
    <rect x="28" y="230" width="260" height="34" rx="7" fill="#1e232a" stroke="#39414d"/>
    <text x="44" y="252" font-size="14" fill="#e6e9ee">1920 × 1080</text>
    <path d="M268 242 l6 6 10 -10" stroke="#8aa3b9" stroke-width="2" fill="none"/>
    <line x1="28" y1="278" x2="288" y2="278" stroke="#39414d"/>
    <rect x="28" y="288" width="260" height="36" rx="8" fill="#8aa3b9"/>
    <text x="158" y="312" font-size="16" fill="#161a20" font-weight="600" text-anchor="middle">Export</text>
    <text x="360" y="54" font-size="16.5" fill="#e6e9ee" font-weight="600">Pick your container</text>
    <circle cx="368" cy="88" r="3.5" fill="#8aa3b9"/><text x="380" y="92" font-size="15" fill="#98a1ad">MP4 for the widest compatibility</text>
    <circle cx="368" cy="118" r="3.5" fill="#8aa3b9"/><text x="380" y="122" font-size="15" fill="#98a1ad">WebM and MKV for sharing and archives</text>
    <circle cx="368" cy="148" r="3.5" fill="#8aa3b9"/><text x="380" y="152" font-size="15" fill="#98a1ad">MOV for Apple workflows</text>
    <circle cx="368" cy="178" r="3.5" fill="#8aa3b9"/><text x="380" y="182" font-size="15" fill="#98a1ad">MPEG-TS for broadcast pipelines</text>
    <circle cx="368" cy="208" r="3.5" fill="#8aa3b9"/><text x="380" y="212" font-size="15" fill="#98a1ad">every format picks the best codec your browser can encode</text>
    <circle cx="368" cy="238" r="3.5" fill="#8aa3b9"/><text x="380" y="242" font-size="15" fill="#98a1ad">exports match playback exactly</text>
  </svg>
  <figcaption>The export menu. Pick a format and resolution, then hit Export.</figcaption>
</figure>`,

  settingsMenu: `
<figure class="doc-fig">
  <svg viewBox="0 0 720 310" role="img" aria-label="The settings menu with FPS, snapping, aspect ratio and working size" class="fig-border">
    <rect x="8" y="8" width="320" height="294" rx="10" fill="#2a3038" stroke="#39414d"/>
    <text x="28" y="44" font-size="13.5" fill="#98a1ad">FPS</text>
    <rect x="28" y="52" width="130" height="32" rx="7" fill="#1e232a" stroke="#39414d"/>
    <text x="44" y="73" font-size="14" fill="#e6e9ee">12</text>
    <text x="28" y="112" font-size="13.5" fill="#98a1ad">Snap to frames</text>
    <rect x="28" y="122" width="18" height="18" rx="4" fill="#8aa3b9"/>
    <path d="M32 131 l5 5 9 -9" stroke="#161a20" stroke-width="2" fill="none"/>
    <text x="28" y="172" font-size="13.5" fill="#98a1ad">Aspect ratio</text>
    <rect x="28" y="180" width="260" height="32" rx="7" fill="#1e232a" stroke="#39414d"/>
    <text x="44" y="201" font-size="14" fill="#e6e9ee">16:9</text>
    <path d="M268 191 l6 6 10 -10" stroke="#8aa3b9" stroke-width="2" fill="none"/>
    <text x="28" y="240" font-size="13.5" fill="#98a1ad">Working size (long edge)</text>
    <rect x="28" y="248" width="260" height="32" rx="7" fill="#1e232a" stroke="#39414d"/>
    <text x="44" y="269" font-size="14" fill="#e6e9ee">512px</text>
    <path d="M268 259 l6 6 10 -10" stroke="#8aa3b9" stroke-width="2" fill="none"/>
    <text x="380" y="80" font-size="16.5" fill="#e6e9ee" font-weight="600">Tune the timeline</text>
    <circle cx="388" cy="112" r="3.5" fill="#8aa3b9"/><text x="400" y="116" font-size="15" fill="#98a1ad">fps sets frames per second</text>
    <circle cx="388" cy="140" r="3.5" fill="#8aa3b9"/><text x="400" y="144" font-size="15" fill="#98a1ad">snapping keeps whole-frame times</text>
    <circle cx="388" cy="168" r="3.5" fill="#8aa3b9"/><text x="400" y="172" font-size="15" fill="#98a1ad">aspect sets the canvas shape</text>
    <circle cx="388" cy="196" r="3.5" fill="#8aa3b9"/><text x="400" y="200" font-size="15" fill="#98a1ad">working size sets speed vs detail</text>
  </svg>
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
        <p>The easiest way is to open the app straight from the Khuwari website in your browser. No install, nothing to set up, everything runs in the tab. This is the recommended way to use Khuwari.</p>
        <p>You can also host it yourself. Khuwari is a static site, so any file server works.</p>
        <ol>
          <li>Serve the project folder, for example with <code>python3 -m http.server 4000</code>.</li>
          <li>Open <code>http://localhost:4000</code> in your browser.</li>
        </ol>
        <p>From the start screen you can start a new project, load an existing <code>.khuwari</code> file, or try the bundled example project. The example project is the fastest way to see a finished animation. Load it and press play.</p>
        ${FIG.browserBar}
      ` },
      { id: 'project-files', title: 'Project files', html: `
        <p>Projects save as <code>.khuwari</code> files. They are plain JSON files, which makes them easy to version and share.</p>
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
          <li>Click a gap to open its interpolation options.</li>
        </ul>
        ${FIG.timelineLayers}
      ` },
      { id: 'selection-panel', title: 'The selection panel', html: `
        <p>The panel on the right shows the details of whatever you have selected, whether that is a keyframe, a gap or a color dot.</p>
        <ul>
          <li>Set exact times and blend modes for keyframes.</li>
          <li>Choose how a gap should interpolate, and tune squash and motion blur.</li>
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
    slug: 'gaps', title: 'Gaps & interpolation',
    blurb: 'Machine learning, squash and stretch, no interpolation, motion blur and regeneration.',
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
      { id: 'none', title: 'No interpolation', html: `
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
          <li><strong>Grow</strong> is a radius in pixels that tucks the color under anti-aliased edges.</li>
        </ul>
        <p>Each dot has its own values, so tune them per region.</p>
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
      ` },
      { id: 'stacking', title: 'Stacking', html: `
        <p>Dots that overlap in time stack into their own rows in the timeline, so they never cover each other and stay easy to find. The color layer grows to fit the stack, no matter how many dots overlap.</p>
        ${FIG.dotStack}
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
            <tr><td>Normal</td><td>source-over</td></tr>
            <tr><td>Darken</td><td>multiply, darken, color burn</td></tr>
            <tr><td>Lighten</td><td>screen, lighten, color dodge</td></tr>
            <tr><td>Contrast</td><td>overlay, hard light, soft light</td></tr>
            <tr><td>Invert</td><td>difference, exclusion</td></tr>
            <tr><td>Color</td><td>hue, saturation, color, luminosity</td></tr>
          </tbody>
        </table>
        <p>Inbetweens between two keyframes use the normal blend, so the blending itself stays stable across the gap.</p>
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
            <tr><td>MPEG-TS video</td><td>broadcast and streaming pipelines</td></tr>
            <tr><td>Current frame (PNG)</td><td>a single still</td></tr>
          </tbody>
        </table>
        <p>Every video container picks the best codec your browser can actually encode, so you get a playable file wherever the format is supported.</p>
        ${FIG.exportMenu}
      ` },
      { id: 'resolution', title: 'Resolution', html: `
        <p>Pick the export resolution from the export menu. Exports run in the background with a progress bar, and you can stop them if you change your mind.</p>
      ` },
      { id: 'wysiwyg', title: 'What you see is what you get', html: `
        <p>Exports render through the same composite as playback, so the video, GIF and sequence all match what you see in the preview, including blend modes and color fills.</p>
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
        <p>The long edge of the working canvas, from 512 pixels down to 320. Smaller is noticeably faster to generate, and exports still render at full resolution.</p>
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
