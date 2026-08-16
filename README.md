# Khuwari

Frame interpolation animation, right in your browser.

Khuwari is a browser based animation tool that fills in the frames between your keyframes with machine learning. You bring the art, it brings the inbetweens. Everything runs locally, so your images and projects never leave your machine.

> I just want to animate.

## What you can do

- **ML inbetweens** — a machine learning model generates the frames between your keyframes, with a pure JavaScript mesh warp fallback and a squash and stretch mode per gap.
- **Layer based timeline** — backgrounds, characters and effects each live on their own layer, with their own keyframes and gaps.
- **Color fill dots** — drop dots on a color layer and they fill the line art on the layer above, each with its own threshold, grow radius, gradient and timing.
- **Onion skinning** — see the frames around the one you are working on, as ghosts or tinted, with configurable frame counts.
- **Motion blur** — per gap motion blur that eases in and out with the movement, to mask small interpolation imperfections.
- **Blend modes** — 16 blend modes per keyframe.
- **Export** — PNG sequence, animated GIF or MP4, at the resolution you pick.
- **Local and private** — the whole tool runs in your browser. No accounts, no uploads, no tracking.

## Try it

Khuwari is a static site, so any file server works:

```sh
python3 -m http.server 4000
```

Then open http://localhost:4000 to browse the site, and http://localhost:4000/editor.html for the editor itself. Load the example project from the editor's start screen and press play.

## Documentation

The website lives at the root of the repo: the home page is `index.html`, the docs hub is [docs.html](docs.html) with a live search across every category, each category has its own page under [docs/](docs/), and the credits page is [credits.html](credits.html).

## How it works

1. Add images to the asset library.
2. Drag them onto the timeline as keyframes.
3. Set how each gap behaves and let the machine generate the inbetweens.
4. Play, tweak, and export a video, GIF or frame sequence.

Projects save as single `.khuwari` files, which are plain JSON.

## Credits

Khuwari is built with RIFE and ONNX Runtime Web for machine learning interpolation, gifenc for GIF encoding and mp4-muxer for MP4 muxing. Everything else was written for Khuwari. See the [credits page](credits.html) for the full list.

## License

Khuwari is open source under the GNU Affero General Public License v3. See [LICENSE](LICENSE).
