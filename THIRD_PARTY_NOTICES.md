# Third-party code and dependencies

Giga Router builds on the original LLM Router implementation and reuses the
following open-source projects. The production dependencies below are MIT
licensed. Full dependency notices are also included in their npm packages.

| Project | Version / source | Use |
| --- | --- | --- |
| [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) | npm `@modelcontextprotocol/sdk` 1.32.1 | MCP clients, HTTP/SSE/stdio transports, gateway server |
| [Vercel Skills](https://github.com/vercel-labs/skills) | `13e4063a1cf913f5606d57d42ab83a86f5001e04`, `src/source-parser.ts` | GitHub parsing and path-safety logic adapted in `lib/github-source.js` |
| [Feather](https://github.com/feathericons/feather) | npm `feather-icons` 4.29.2 | Self-hosted UI icons |
| [js-yaml](https://github.com/nodeca/js-yaml) | 5.5.0 | SKILL.md YAML frontmatter |
| [fflate](https://github.com/101arrowz/fflate) | 0.8.3 | Skill bundle ZIP downloads |
| [Express](https://github.com/expressjs/express) | 4.22.3 | Existing HTTP server |
| [MCP Memory server](https://github.com/modelcontextprotocol/servers/tree/main/src/memory) | npm `@modelcontextprotocol/server-memory` 2025.11.25 | Included local knowledge-graph tool (MIT release) |
| [MCP Filesystem server](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem) | npm `@modelcontextprotocol/server-filesystem` 2025.12.18 | Included local shared-files tool (MIT release) |
| [MCP Sequential Thinking server](https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking) | npm `@modelcontextprotocol/server-sequential-thinking` 2025.12.18 | Included local structured-thinking tool (MIT release) |

The Vercel code was modified to support GitHub-only sources, explicit ref/path
overrides, strict host checking, and pre-URL-normalization traversal validation.
It does not include Vercel's CLI, telemetry, or agent installers.

## Vercel Skills license

MIT License

Copyright (c) 2026 Vercel, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## MCP SDK license

This MIT notice also applies to the pinned Anthropic-authored MIT releases of
the Memory, Filesystem, and Sequential Thinking server packages listed above.

MIT License

Copyright (c) 2024 Anthropic, PBC

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Feather license

The MIT License (MIT)

Copyright (c) 2013-2023 Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Marketplace content

The built-in catalogs contain unmodified `SKILL.md` files from the ten
MIT-licensed repositories listed in `marketplaces/builtin/manifest.json`.
Every compressed snapshot includes its original source URLs, pinned commit,
and full repository license text under `repositoryLicense.content`. File
trees contain path/hash metadata only; executable supporting files are not
bundled or run. Individual skill licenses are retained in their frontmatter.

Skills imported by users are independent of Giga Router's source code and retain
their own licenses. The marketplace displays repository/per-skill license
metadata. Installs include the repository license (when present) and a
`giga-router-source.json` provenance record containing the original URL, pinned
commit, and license.
