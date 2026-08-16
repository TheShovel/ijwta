/* Home page feature figures: inlined SVGs that mirror the real app UI,
 * injected into the .feat-shot containers on the home page by site.js. */
window.HOME_FIGS = {
  ml: `<svg viewBox="0 0 720 104" role="img" aria-label="The timeline with two keyframes and the generated frames between them" class="fig-border">
    <!-- timeline ruler -->
    <rect x="8" y="8" width="704" height="26" fill="#191d23"/>
    <line x1="8" y1="34" x2="712" y2="34" stroke="#39414d"/>
    <text x="20" y="24" font-size="11" font-family="ui-monospace,Menlo,monospace" fill="#98a1ad">0s</text>
    <text x="252" y="24" font-size="11" font-family="ui-monospace,Menlo,monospace" fill="#98a1ad">1s</text>
    <text x="484" y="24" font-size="11" font-family="ui-monospace,Menlo,monospace" fill="#98a1ad">2s</text>
    <!-- layer row -->
    <rect x="8" y="34" width="704" height="62" fill="#1b1f25"/>
    <rect x="8" y="34" width="96" height="62" fill="#22272e"/>
    <line x1="104" y1="34" x2="104" y2="96" stroke="#39414d"/>
    <text x="18" y="70" font-size="13" fill="#e6e9ee">Layer 1</text>
    <circle cx="88" cy="60" r="1.6" fill="#98a1ad" opacity="0.6"/>
    <circle cx="88" cy="66" r="1.6" fill="#98a1ad" opacity="0.6"/>
    <circle cx="88" cy="72" r="1.6" fill="#98a1ad" opacity="0.6"/>
    <!-- keyframe chip A -->
    <rect x="120" y="46" width="54" height="50" rx="9" fill="rgba(195,171,125,0.09)" stroke="rgba(195,171,125,0.35)"/>
    <rect x="122" y="48" width="38" height="38" rx="6" fill="#0d0f12" stroke="#c3ab7d" stroke-width="2"/>
    <circle cx="141" cy="67" r="9" fill="none" stroke="#8aa3b9" stroke-width="2.5"/>
    <text x="124" y="93" font-size="9" font-family="ui-monospace,Menlo,monospace" fill="#cfd6e2">0.00s</text>
    <!-- gap overlay + label + generated frame dots -->
    <rect x="174" y="66" width="330" height="22" rx="5" fill="rgba(143,176,162,0.09)"/>
    <rect x="256" y="50" width="86" height="16" rx="5" fill="#313844" stroke="#39414d"/>
    <text x="262" y="61" font-size="9.5" font-family="ui-monospace,Menlo,monospace" fill="#98a1ad">11 frames</text>
    <g class="fig-anim fig-dots">
      <circle cx="198" cy="77" r="3" fill="#8fb0a2"/>
      <circle cx="238" cy="77" r="3" fill="#8fb0a2"/>
      <circle cx="298" cy="77" r="3" fill="#8fb0a2"/>
      <circle cx="338" cy="77" r="3" fill="#8fb0a2"/>
      <circle cx="378" cy="77" r="3" fill="#8fb0a2"/>
      <circle cx="418" cy="77" r="3" fill="#8fb0a2"/>
      <circle cx="458" cy="77" r="3" fill="#8fb0a2"/>
    </g>
    <!-- keyframe chip B -->
    <rect x="504" y="46" width="54" height="50" rx="9" fill="rgba(195,171,125,0.09)" stroke="rgba(195,171,125,0.35)"/>
    <rect x="506" y="48" width="38" height="38" rx="6" fill="#0d0f12" stroke="#c3ab7d" stroke-width="2"/>
    <circle cx="525" cy="67" r="9" fill="none" stroke="#8fb0a2" stroke-width="2.5"/>
    <text x="508" y="93" font-size="9" font-family="ui-monospace,Menlo,monospace" fill="#cfd6e2">2.00s</text>
    <line x1="8" y1="96" x2="712" y2="96" stroke="#39414d" opacity="0.5"/>
    <!-- playhead sweeps -->
    <g class="fig-anim fig-playhead">
      <line x1="360" y1="10" x2="360" y2="96" stroke="#c48181" stroke-width="2"/>
      <path d="M356 10 h8 l-4 6 z" fill="#c48181"/>
    </g>
  </svg>`,
  layers: `<svg viewBox="0 0 720 170" role="img" aria-label="The timeline with a normal layer and a thin color layer with stacked dot chips" class="fig-border">
    <rect x="8" y="8" width="704" height="26" fill="#191d23"/>
    <line x1="8" y1="34" x2="712" y2="34" stroke="#39414d"/>
    <text x="20" y="24" font-size="11" font-family="ui-monospace,Menlo,monospace" fill="#98a1ad">0s</text>
    <text x="252" y="24" font-size="11" font-family="ui-monospace,Menlo,monospace" fill="#98a1ad">1s</text>
    <text x="484" y="24" font-size="11" font-family="ui-monospace,Menlo,monospace" fill="#98a1ad">2s</text>
    <!-- layer 1 (normal, 62px) -->
    <rect x="8" y="34" width="704" height="62" fill="#1b1f25"/>
    <rect x="8" y="34" width="96" height="62" fill="#22272e"/>
    <line x1="104" y1="34" x2="104" y2="96" stroke="#39414d"/>
    <text x="18" y="70" font-size="13" fill="#e6e9ee">Layer 1</text>
    <circle cx="88" cy="60" r="1.6" fill="#98a1ad" opacity="0.6"/><circle cx="88" cy="66" r="1.6" fill="#98a1ad" opacity="0.6"/><circle cx="88" cy="72" r="1.6" fill="#98a1ad" opacity="0.6"/>
    <rect x="120" y="46" width="54" height="50" rx="9" fill="rgba(195,171,125,0.09)" stroke="rgba(195,171,125,0.35)"/>
    <rect x="122" y="48" width="38" height="38" rx="6" fill="#0d0f12" stroke="#c3ab7d" stroke-width="2"/>
    <circle cx="141" cy="67" r="9" fill="none" stroke="#8aa3b9" stroke-width="2.5"/>
    <rect x="174" y="66" width="330" height="22" rx="5" fill="rgba(143,176,162,0.09)"/>
    <rect x="504" y="46" width="54" height="50" rx="9" fill="rgba(195,171,125,0.09)" stroke="rgba(195,171,125,0.35)"/>
    <rect x="506" y="48" width="38" height="38" rx="6" fill="#0d0f12" stroke="#c3ab7d" stroke-width="2"/>
    <circle cx="525" cy="67" r="9" fill="none" stroke="#8fb0a2" stroke-width="2.5"/>
    <line x1="8" y1="96" x2="712" y2="96" stroke="#39414d" opacity="0.5"/>
    <!-- layer 2: thin color layer, two stacked dot chips -->
    <rect x="8" y="96" width="704" height="58" fill="#1b1f25"/>
    <rect x="8" y="96" width="96" height="58" fill="#22272e"/>
    <line x1="104" y1="96" x2="104" y2="154" stroke="#39414d"/>
    <text x="18" y="130" font-size="13" fill="#98a1ad">Color 2</text>
    <circle cx="88" cy="120" r="1.6" fill="#98a1ad" opacity="0.6"/><circle cx="88" cy="126" r="1.6" fill="#98a1ad" opacity="0.6"/><circle cx="88" cy="132" r="1.6" fill="#98a1ad" opacity="0.6"/>
    <rect x="180" y="103" width="150" height="20" rx="7" fill="rgba(79,143,255,0.12)" stroke="rgba(79,143,255,0.4)"/>
    <circle cx="191" cy="113" r="5" fill="#4f8fff" stroke="rgba(255,255,255,0.35)"/>
    <text x="202" y="116" font-size="9" font-family="ui-monospace,Menlo,monospace" fill="#c3cbd6">0.00-1.00</text>
    <rect x="324" y="103" width="6" height="20" rx="3" fill="rgba(255,255,255,0.12)"/>
    <rect x="180" y="127" width="150" height="20" rx="7" fill="rgba(79,143,255,0.12)" stroke="rgba(79,143,255,0.4)"/>
    <circle cx="191" cy="137" r="5" fill="#c3ab7d" stroke="rgba(255,255,255,0.35)"/>
    <text x="202" y="140" font-size="9" font-family="ui-monospace,Menlo,monospace" fill="#c3cbd6">0.00-1.00</text>
    <rect x="324" y="127" width="6" height="20" rx="3" fill="rgba(255,255,255,0.12)"/>
    <line x1="8" y1="154" x2="712" y2="154" stroke="#39414d" opacity="0.5"/>
    <!-- playhead -->
    <g class="fig-anim fig-playhead">
      <line x1="330" y1="10" x2="330" y2="154" stroke="#c48181" stroke-width="2"/>
      <path d="M326 10 h8 l-4 6 z" fill="#c48181"/>
    </g>
  </svg>`,
  fill: `<svg viewBox="0 0 720 296" role="img" aria-label="A color dot flooding the area inside line art on the canvas, with its chip on the color layer below" class="fig-border">
    <!-- canvas -->
    <rect x="8" y="8" width="704" height="204" rx="8" fill="#161a20" stroke="#39414d"/>
    <rect x="255" y="44" width="210" height="130" rx="10" fill="none" stroke="#22272e" stroke-width="16"/>
    <rect x="255" y="44" width="210" height="130" rx="10" fill="none" stroke="#0d0f12" stroke-width="14"/>
    <g class="fig-anim fig-fillc">
      <rect x="269" y="58" width="182" height="102" rx="10" fill="rgba(79,143,255,0.55)"/>
    </g>
    <circle cx="360" cy="109" r="7" fill="#4f8fff" stroke="#8aa3b9" stroke-width="2"/>
    <!-- color layer with the dot chip -->
    <rect x="8" y="222" width="704" height="58" fill="#1b1f25"/>
    <rect x="8" y="222" width="96" height="58" fill="#22272e"/>
    <line x1="104" y1="222" x2="104" y2="280" stroke="#39414d"/>
    <text x="18" y="256" font-size="13" fill="#98a1ad">Color 1</text>
    <rect x="150" y="229" width="170" height="20" rx="7" fill="rgba(79,143,255,0.12)" stroke="rgba(79,143,255,0.4)"/>
    <circle cx="161" cy="239" r="5" fill="#4f8fff" stroke="rgba(255,255,255,0.35)"/>
    <text x="172" y="242" font-size="9" font-family="ui-monospace,Menlo,monospace" fill="#c3cbd6">0.00-2.00</text>
    <rect x="314" y="229" width="6" height="20" rx="3" fill="rgba(255,255,255,0.12)"/>
  </svg>`,
  onion: `<svg viewBox="0 0 720 210" role="img" aria-label="Onion skinning showing ghost frames behind the current one, with the onion settings menu" class="fig-border">
    <!-- canvas with ghosts -->
    <rect x="8" y="8" width="520" height="190" rx="8" fill="#161a20" stroke="#39414d"/>
    <g class="fig-anim fig-fade">
      <circle cx="160" cy="100" r="26" fill="none" stroke="#8aa3b9" stroke-width="3"/>
      <path d="M136 152 q24 -22 48 0 l-6 30 h-36 z" fill="none" stroke="#c3ab7d" stroke-width="3"/>
    </g>
    <g class="fig-anim fig-fade fig-fade-1">
      <circle cx="280" cy="100" r="26" fill="none" stroke="#8aa3b9" stroke-width="3"/>
      <path d="M256 152 q24 -22 48 0 l-6 30 h-36 z" fill="none" stroke="#c3ab7d" stroke-width="3"/>
    </g>
    <!-- current frame -->
    <circle cx="400" cy="100" r="26" fill="none" stroke="#e6e9ee" stroke-width="3"/>
    <path d="M376 152 q24 -22 48 0 l-6 30 h-36 z" fill="none" stroke="#e6e9ee" stroke-width="3"/>
    <!-- onion settings menu -->
    <rect x="540" y="8" width="172" height="190" rx="10" fill="#2a3038" stroke="#39414d"/>
    <text x="552" y="30" font-size="11" font-weight="600" fill="#e6e9ee">Onion skin</text>
    <text x="552" y="56" font-size="9.5" fill="#98a1ad">Frames before <tspan fill="#c3cbd6" font-family="ui-monospace,Menlo,monospace">2</tspan></text>
    <rect x="552" y="62" width="148" height="4" rx="2" fill="#39414d"/>
    <rect x="552" y="62" width="70" height="4" rx="2" fill="#8aa3b9"/>
    <circle cx="622" cy="64" r="7" fill="#8aa3b9" stroke="#161a20" stroke-width="2"/>
    <text x="552" y="88" font-size="9.5" fill="#98a1ad">Frames after <tspan fill="#c3cbd6" font-family="ui-monospace,Menlo,monospace">2</tspan></text>
    <rect x="552" y="94" width="148" height="4" rx="2" fill="#39414d"/>
    <rect x="552" y="94" width="70" height="4" rx="2" fill="#8aa3b9"/>
    <circle cx="622" cy="96" r="7" fill="#8aa3b9" stroke="#161a20" stroke-width="2"/>
    <text x="552" y="120" font-size="9.5" fill="#98a1ad">Opacity <tspan fill="#c3cbd6" font-family="ui-monospace,Menlo,monospace">28%</tspan></text>
    <rect x="552" y="126" width="148" height="4" rx="2" fill="#39414d"/>
    <rect x="552" y="126" width="48" height="4" rx="2" fill="#8aa3b9"/>
    <circle cx="600" cy="128" r="7" fill="#8aa3b9" stroke="#161a20" stroke-width="2"/>
    <rect x="552" y="146" width="12" height="12" rx="3" fill="#8aa3b9"/>
    <path d="M555 152 l2.5 2.5 4.5 -4.5" stroke="#161a20" stroke-width="2" fill="none"/>
    <text x="572" y="156" font-size="10" fill="#e6e9ee">Tint</text>
    <rect x="552" y="170" width="26" height="18" rx="4" fill="#1e232a" stroke="#39414d"/>
    <rect x="556" y="174" width="18" height="10" rx="2" fill="#ff3b30"/>
  </svg>`,
  blur: `<svg viewBox="0 0 720 220" role="img" aria-label="A shape smearing along its motion, with the motion blur gap options" class="fig-border">
    <!-- canvas -->
    <rect x="8" y="8" width="420" height="200" rx="8" fill="#161a20" stroke="#39414d"/>
    <line x1="40" y1="120" x2="396" y2="120" stroke="#39414d" stroke-dasharray="4 4"/>
    <circle cx="90" cy="120" r="26" fill="#c3ab7d"/>
    <circle cx="346" cy="120" r="26" fill="#c3ab7d"/>
    <g class="fig-anim fig-blur">
      <circle cx="218" cy="120" r="26" fill="#8aa3b9" opacity="0.85"/>
    </g>
    <!-- gap options panel -->
    <rect x="440" y="8" width="272" height="200" rx="10" fill="#22272e" stroke="#39414d"/>
    <text x="456" y="34" font-size="10.5" fill="#98a1ad" font-weight="700" letter-spacing="1">GAP</text>
    <text x="456" y="60" font-size="13" fill="#e6e9ee" font-weight="600">Motion blur</text>
    <rect x="456" y="70" width="14" height="14" rx="4" fill="#8aa3b9"/>
    <path d="M459 77 l2.5 2.5 4.5 -4.5" stroke="#161a20" stroke-width="2" fill="none"/>
    <text x="456" y="112" font-size="10" fill="#98a1ad">Blur intensity <tspan fill="#c3cbd6" font-family="ui-monospace,Menlo,monospace">50%</tspan></text>
    <rect x="456" y="118" width="240" height="5" rx="2.5" fill="#39414d"/>
    <rect x="456" y="118" width="120" height="5" rx="2.5" fill="#8aa3b9"/>
    <circle cx="576" cy="120" r="8" fill="#8aa3b9" stroke="#161a20" stroke-width="2"/>
  </svg>`,
  export: `<svg viewBox="0 0 720 300" role="img" aria-label="The export menu with format and resolution options, and the export progress overlay" class="fig-border">
    <!-- export menu, matches the app -->
    <rect x="8" y="8" width="300" height="284" rx="10" fill="#2a3038" stroke="#39414d"/>
    <text x="28" y="40" font-size="11" fill="#98a1ad">Format</text>
    <rect x="28" y="48" width="260" height="32" rx="7" fill="#1e232a" stroke="#39414d"/>
    <text x="44" y="69" font-size="13" fill="#e6e9ee">Animated GIF</text>
    <path d="M268 58 l6 6 10 -10" stroke="#8aa3b9" stroke-width="2" fill="none"/>
    <text x="28" y="108" font-size="11" fill="#98a1ad">Resolution</text>
    <rect x="28" y="116" width="260" height="32" rx="7" fill="#1e232a" stroke="#39414d"/>
    <text x="44" y="137" font-size="13" fill="#e6e9ee">1920 × 1080</text>
    <path d="M268 126 l6 6 10 -10" stroke="#8aa3b9" stroke-width="2" fill="none"/>
    <line x1="28" y1="168" x2="288" y2="168" stroke="#39414d"/>
    <rect x="28" y="184" width="260" height="38" rx="8" fill="#8aa3b9"/>
    <text x="158" y="208" font-size="15" fill="#161a20" font-weight="600" text-anchor="middle">Export</text>
    <!-- dimmed app behind, with the export progress overlay -->
    <rect x="340" y="8" width="372" height="284" rx="10" fill="#161a20" stroke="#39414d"/>
    <rect x="340" y="8" width="372" height="284" rx="10" fill="rgba(27,31,37,0.45)"/>
    <rect x="404" y="96" width="244" height="108" rx="10" fill="#22272e" stroke="#39414d"/>
    <circle cx="430" cy="122" r="10" fill="none" stroke="#8aa3b9" stroke-width="2"/>
    <path d="M426 122 l5 4 9 -12" stroke="#8aa3b9" stroke-width="2" fill="none"/>
    <text x="452" y="126" font-size="14" fill="#e6e9ee" font-weight="600">Exporting</text>
    <text x="404" y="152" font-size="11" fill="#98a1ad">writing frame 24 of 50</text>
    <rect x="404" y="162" width="244" height="7" rx="3.5" fill="#39414d"/>
    <rect x="404" y="162" width="117" height="7" rx="3.5" fill="#8aa3b9"/>
  </svg>`,
};
