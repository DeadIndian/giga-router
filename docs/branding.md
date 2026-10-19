# Giga Router branding

Giga Router is a self-hosted router for models, tools, and skills. Its promise is
simple setup and clear routing: connect once, choose what you need, and get on
with your work.

## Name and message

- Product name: **Giga Router**.
- Repository, folder, and package: `giga-router`.
- Tagline: **Routing without the fuss.**
- Short description: **A no-fuss router for your models, tools, and skills.**

Explain what a person can do next. Use concrete words such as connect, choose,
route, copy, and install. Keep instructions short, make optional settings clear,
and show useful errors. Describe supported behavior without promising that
upstream providers never fail.

## One logo

[public/favicon.svg](../public/favicon.svg) is the only logo source. Use this
same file for the browser favicon, dashboard, login screen, and README. Display
it at its original square aspect ratio with space around it. Do not recreate it
in CSS, substitute a letter monogram, or maintain a second SVG copy.

The lime square and dark routing arrow should remain legible at small sizes.
The dashboard uses 38 px on desktop and 30 px on mobile; the README uses 80 px.

Run the **CI** workflow manually to refresh the screenshots. Its screenshot job
uses temporary configuration with no upstream providers, checks the dashboard
at desktop and mobile widths, and uploads a `branding-screenshots` artifact.
Replace the README images with the corresponding captures after review.

## Colors and layout

| Role | Color |
| --- | --- |
| Primary action and logo background | `#d5f879` |
| Main background and logo arrow | `#17191d` |
| Sidebar | `#131519` |
| Panels | `#1f2227` |
| Main text | `#f1f2ed` |
| Secondary text | `#bbc0c7` |

Use system fonts, simple panels, and familiar controls. Put routing and connection
status first, keep primary actions easy to find, and keep decoration light.
