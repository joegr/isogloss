# Speaker map

One dot per speaker, at their birthplace, on a D3 globe — the Speech Accent
Archive's 3,031 speakers to start with, and anyone you add. Creating a dot runs a
cascade on the backend: the record with every field, the place (the pin plus the
birthplace geocoded), named entities in the text (each place linked to a point
and drawn on the globe), and audio — converted to 16 kHz WAV in the browser, so
MP3s need nothing on the server.

**This directory is the frontend only**: a static site built with Vite and
deployed to GitHub Pages at <https://joegr.github.io/isogloss/speaker-map/>,
beside the synthesiser. The API is the Demogi/Isogloss backend, which lives in
a private repository; this site reaches it through one setting.

## Pointing it at the backend

`public/config.js` is plain JavaScript, loaded before the bundle and never
compiled:

```js
window.SPEAKER_MAP_CONFIG = { apiBase: "https://api.example.org" };
```

* **On GitHub Pages** set the repository variable `API_BASE` (Settings → Secrets
  and variables → Actions → Variables) and re-run the workflow; it writes
  `config.js` from it. It must be `https://` — Pages is HTTPS, and browsers block
  calls from it to plain HTTP.
* **Anywhere else** build with `API_BASE=https://… npm run build`, or edit
  `config.js` in the built `dist/` by hand.
* **Empty** means same origin — what local development uses.

The backend must allow this site's origin: on the Demogi API that is
`GEOMAP_CORS_ORIGINS=https://joegr.github.io`. Until a backend is configured and
reachable, the site says so instead of showing an empty globe.

## Develop

```bash
npm ci
npm run dev        # http://localhost:5173, proxying /api to the backend on :5050
npm test           # unit tests
npm run build      # dist/, ready for any static host
```

Set `SPEAKER_MAP_BACKEND` to proxy somewhere other than `http://127.0.0.1:5050`.

The browser tests drive the real thing — dots, a record, creating a speaker
with an MP3, attaching a folder of archive files — against a running backend
(see the header of `playwright.speakers.config.ts`):

```bash
SPK_FIXTURES=/path/to/audio E2E_BASE_URL=http://127.0.0.1:5173 npm run test:e2e
```

## Deploy

The `speaker map` job in the repository's `.github/workflows/pages.yml`
typechecks, runs the unit tests, builds, and writes `config.js` from `API_BASE`
on every push and pull request; on `main` the deploy job publishes the build
under `speaker-map/` of the Isogloss Pages site.

## Where it came from

The globe, theme and shell are [Demogi](https://github.com/joegr/demogi)'s
GeoCRM frontend; the speaker module was built for Isogloss
(joegr/isogloss#1, `frontend/src/speakers/`).
The world map is Natural Earth via `world-atlas`; Inter is self-hosted.
