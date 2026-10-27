# Project website

The public Giga Router website lives in `site/`. It is plain HTML, CSS, and
JavaScript, built for GitHub Pages with no framework or third-party runtime
assets. The router runs separately on your own computer or server.

## Preview locally

With Node.js 22.12 or newer installed:

```bash
npm run preview:site
```

Open the printed URL. The preview builds `_site/` and serves it on a random
loopback port under `/giga-router/`, matching a GitHub Pages project path.
Press **Ctrl+C** to stop. Run the command again after editing the source files.
No dependency installation or router configuration is needed for this preview.

## Publish on GitHub Pages

1. Commit and push the website files and `.github/workflows/pages.yml` to `main`.
2. In the repository, open **Settings → Pages → Build and deployment**.
   Set **Source** to **GitHub Actions**.
3. Open **Actions → Project website → Run workflow**, select `main`, and run it.
4. Open the deployment URL shown by the completed workflow.

For `DeadIndian/giga-router`, the default URL is
**https://deadindian.github.io/giga-router/**. Subsequent pushes to `main` that
change website sources, the logo, the build script, package metadata, or the
Pages workflow deploy automatically. Enabling Pages is a one-time repository
setting; adding the workflow alone does not publish the site.

The workflow builds a static artifact and uploads only `_site/`. Forks use their
own `GITHUB_REPOSITORY` for source links, clone commands, and the default site
URL. Pages supplies the configured URL, including a custom domain when set.

## Edit and build

| File | Purpose |
| --- | --- |
| `site/index.html` | Content, accessible navigation, feature sections, installation guides, FAQ |
| `site/styles.css` | Responsive charcoal-and-lime design using system fonts |
| `site/site.js` | Local routing illustration, keyboard tabs, mobile menu, copy buttons |
| `public/favicon.svg` | The single maintained logo source |
| `scripts/build-site.cjs` | Repository/URL substitution and static artifact assembly |
| `scripts/preview-site.cjs` | Loopback preview of the built artifact |
| `scripts/check-site.cjs` | Browser interaction and responsive layout checks |

```bash
npm run build:site
```

Build output is ignored by Git and excluded from the router's Docker image.
Edit `site/`, then rebuild. The builder copies the existing favicon into the
artifact; keep `public/favicon.svg` as the only maintained logo.

Set `GITHUB_REPOSITORY=owner/repository` and `SITE_URL=https://example.com` in your
environment to override links and canonical metadata for a local/custom build.
Assets use relative paths so the same artifact works at a domain root or a
project subpath.

## Checks

`npm run check` includes website JavaScript. CI also runs `npm run test:site`
with Playwright and Chromium, using a temporary build and random loopback port.
It checks project-path assets, fork-specific links, copy buttons, keyboard tabs,
routing scenarios, mobile navigation, FAQ, reduced motion, and basic no-JavaScript
content. Layouts are checked at 360, 390, 768, 1024, and 1440 pixels; desktop and
mobile captures are uploaded as the `website-screenshots` artifact.

To run the browser checks locally, install the same tools outside the project:

```bash
npm install --prefix /path/to/browser-tools --no-save playwright@1.58.2
/path/to/browser-tools/node_modules/.bin/playwright install chromium
NODE_PATH=/path/to/browser-tools/node_modules npm run test:site
```

On PowerShell, set `$env:NODE_PATH` to the installed `node_modules` directory
before running `npm run test:site`. Set `SITE_SCREENSHOT_DIR` to save screenshots.
