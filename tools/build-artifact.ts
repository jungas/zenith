/**
 * Packs the whole app into one self-contained HTML file.
 *
 * Why a bundler at all: an Artifact is a single file, so the module graph has
 * to collapse into one document. Concatenating the ES modules into one scope
 * would collide on every same-named local (`render`, `state`, `money`, …), so
 * instead tsc emits CommonJS and each module is wrapped in a function with its
 * own scope, registered by path and required lazily.
 *
 * What the single-file build gives up, and why:
 *   · the service worker — a worker must be a separate same-origin script at
 *     the scope it controls, and there is only one file here
 *   · installability — that needs the worker plus a linked manifest
 * Everything else, including localStorage persistence, works unchanged.
 *
 * Run with: npm run build:artifact
 */

import { execFileSync } from 'node:child_process';
import { globSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_DIR = join(ROOT, '.artifact-build');
const OUT_DIR = join(ROOT, 'dist-artifact');
const OUT_FILE = join(OUT_DIR, 'zenith.html');

/** Stylesheets, in cascade order. */
const STYLES = [
  'styles/tokens.css', 'styles/base.css', 'styles/components.css', 'styles/views.css',
  // Last, as in index.html: the glass layer overrides the flat surfaces above it.
  'styles/glass.css',
];

const read = (file: string): string => readFileSync(join(ROOT, file), 'utf8');

function compile(): void {
  rmSync(BUILD_DIR, { recursive: true, force: true });
  execFileSync('npx', ['tsc', '-p', 'tsconfig.artifact.json'], { cwd: ROOT, stdio: 'inherit' });
}

/** '.artifact-build/core/model.js' -> 'core/model' */
function moduleId(file: string): string {
  return relative(BUILD_DIR, file).replaceAll('\\', '/').replace(/\.js$/, '');
}

/**
 * Rewrite `require('./dom.js')` to the registry id the module was stored under,
 * resolved relative to the requiring module.
 */
function rewriteRequires(source: string, id: string): string {
  const dir = posix.dirname(id);
  return source.replace(/require\((["'])(\.[^"']+)\1\)/g, (_match, _quote, specifier: string) => {
    const target = posix.normalize(posix.join(dir, specifier)).replace(/\.js$/, '');
    return `__require(${JSON.stringify(target)})`;
  });
}

function bundle(): string {
  const files = globSync('**/*.js', { cwd: BUILD_DIR })
    .map((file) => join(BUILD_DIR, file))
    .sort();
  if (!files.length) throw new Error('nothing was compiled into .artifact-build');

  const modules = files.map((file) => {
    const id = moduleId(file);
    const body = rewriteRequires(readFileSync(file, 'utf8'), id);
    return `__define(${JSON.stringify(id)}, function (exports, module, __require) {\n${body}\n});`;
  });

  return `(function () {
  'use strict';

  // Minimal CommonJS registry: modules are registered eagerly and evaluated on
  // first require, so import order never matters.
  var __registry = Object.create(null);
  var __cache = Object.create(null);

  function __define(id, factory) {
    __registry[id] = factory;
  }

  function __require(id) {
    if (__cache[id]) return __cache[id].exports;
    var factory = __registry[id];
    if (!factory) throw new Error('Zenith bundle is missing module: ' + id);
    var module = { exports: {} };
    __cache[id] = module;
    factory(module.exports, module, __require);
    return module.exports;
  }

${modules.join('\n\n')}

  return __require;
})()`;
}

function buildHtml(bundleSource: string): string {
  const css = STYLES.map((file) => `/* ${file} */\n${read(file)}`).join('\n\n');

  return `<title>Zenith — Budget &amp; Cards</title>
<meta name="color-scheme" content="light dark" />

<style>
${css}

/* Single-file build: the page is the app, so it fills the frame. */
html,
body {
  min-height: 100%;
}
</style>

<a class="skip-link" href="#main">Skip to content</a>
<div id="app" class="app">
  <div class="boot"><p class="boot-text">Loading Zenith…</p></div>
</div>

<script>
  // Tells the app it is running as a single embedded file: no service worker to
  // register, and the host — not the app — owns the light/dark switch.
  window.__ZENITH_EMBEDDED__ = true;
</script>
<script>
  var __zenithRequire = ${bundleSource};

  (function () {
    var saved = null;
    try {
      saved = window.localStorage.getItem('zenith.state.v1');
    } catch (error) {
      // A sandboxed frame can deny storage outright. The app still runs, it
      // just cannot save between visits.
    }

    // Open with the worked example rather than an empty shell, since a shared
    // page gets no chance to explain itself first. Settings → Delete all data
    // clears it. Seeding through the store rather than straight into storage
    // means the page still fills with content where storage is unavailable.
    if (!saved) {
      try {
        __zenithRequire('store').replaceState(__zenithRequire('core/seed').seedState());
      } catch (error) {
        console.warn('Could not load the sample budget.', error);
      }
    }

    __zenithRequire('app').start();
  })();
</script>
`;
}

compile();
mkdirSync(OUT_DIR, { recursive: true });
const html = buildHtml(bundle());
writeFileSync(OUT_FILE, html);
rmSync(BUILD_DIR, { recursive: true, force: true });

console.log(`wrote ${relative(ROOT, OUT_FILE)} (${(html.length / 1024).toFixed(0)} KB)`);
