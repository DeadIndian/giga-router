// GitHub parsing and sanitizeSubpath adapted from vercel-labs/skills (MIT),
// src/source-parser.ts @ 13e4063a1cf913f5606d57d42ab83a86f5001e04.
// Modified for a GitHub-only dashboard and explicit ref/path inputs.
// Copyright (c) 2026 Vercel, Inc. See THIRD_PARTY_NOTICES.md.
const { inputError } = require('./validation');

function sanitizeSubpath(subpath = '') {
  if (typeof subpath !== 'string') throw inputError('Repository path must be a string');
  const normalized = subpath.replace(/\\/g, '/');
  if (normalized.split('/').some((part) => part === '..') || normalized.startsWith('/') || normalized.includes('\0') || /^[A-Za-z]:/.test(normalized)) {
    throw inputError('Repository paths cannot escape the repository root');
  }
  return normalized.split('/').filter((part) => part && part !== '.').join('/');
}

function parseGitHubSource(input, overrides = {}) {
  if (typeof input !== 'string' || !input.trim() || input.length > 2000) throw inputError('Enter a GitHub repository URL or owner/repo');
  let raw = input.trim().replace(/^github:/, '');
  let decoded;
  try { decoded = decodeURIComponent(raw); } catch { throw inputError('Invalid GitHub path encoding'); }
  if (decoded.replace(/\\/g, '/').split(/[/?#]/).some((part) => part === '..')) throw inputError('Repository paths cannot escape the repository root');
  if (!raw.includes('://')) raw = `https://github.com/${raw}`;
  let url;
  try { url = new URL(raw); } catch { throw inputError('Invalid GitHub URL'); }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password) throw inputError('Sources must be hosted on https://github.com');
  let parts;
  try { parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent); } catch { throw inputError('Invalid GitHub path encoding'); }
  const [owner, rawRepo, marker, treeRef, ...tail] = parts;
  const repo = (rawRepo || '').replace(/\.git$/, '');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(owner || '') || !/^[a-zA-Z0-9_.-]+$/.test(repo) || repo === '.' || repo === '..') throw inputError('Enter a GitHub URL containing an owner and repository');
  if (marker && !['tree', 'blob'].includes(marker)) throw inputError('Use a repository, directory, or SKILL.md URL');
  if (marker && !treeRef) throw inputError('A tree/blob URL needs a branch or commit');
  const ref = overrides.ref || treeRef || url.hash.slice(1) || '';
  if (typeof ref !== 'string' || ref.length > 200 || /[\x00-\x20]/.test(ref)) throw inputError('Invalid branch or commit');
  let subpath = overrides.path !== undefined ? overrides.path : tail.join('/');
  if (marker === 'blob' && /(^|\/)SKILL\.md$/.test(subpath)) subpath = subpath.replace(/(^|\/)SKILL\.md$/, '');
  subpath = sanitizeSubpath(subpath);
  return { owner, repo, ref, path: subpath, url: `https://github.com/${owner}/${repo}` };
}

module.exports = { parseGitHubSource, sanitizeSubpath };
