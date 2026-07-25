/**
 * PWA plumbing that is easy to break silently: a new module that never gets
 * precached, or a manifest icon that does not exist on disk.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, globSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(join(ROOT, file), 'utf8');

/** The `SHELL` array in sw.js, as repo-relative paths. */
function precachedPaths() {
  const source = read('sw.js');
  const block = source.slice(source.indexOf('const SHELL = ['), source.indexOf('];', source.indexOf('const SHELL = [')));
  return [...block.matchAll(/'\.\/([^']*)'/g)].map((match) => match[1]).filter(Boolean);
}

function appFiles() {
  return globSync(['src/**/*.js', 'styles/*.css', 'assets/icons/*', 'index.html', 'manifest.webmanifest'], {
    cwd: ROOT,
  });
}

test('every app file is precached by the service worker', () => {
  const listed = new Set(precachedPaths());
  const missing = appFiles().filter((file) => !listed.has(file));
  assert.deepEqual(missing, [], `add these to SHELL in sw.js: ${missing.join(', ')}`);
});

test('the service worker does not precache files that no longer exist', () => {
  const stale = precachedPaths().filter((path) => !existsSync(join(ROOT, path)));
  assert.deepEqual(stale, [], `remove these from SHELL in sw.js: ${stale.join(', ')}`);
});

test('the manifest declares what an installable PWA needs', () => {
  const manifest = JSON.parse(read('manifest.webmanifest'));
  assert.ok(manifest.name, 'name');
  assert.ok(manifest.short_name, 'short_name');
  assert.ok(manifest.start_url, 'start_url');
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.theme_color, 'theme_color');
  assert.ok(manifest.background_color, 'background_color');

  const sizes = manifest.icons.map((entry) => entry.sizes);
  assert.ok(sizes.includes('192x192'), 'a 192px icon');
  assert.ok(sizes.includes('512x512'), 'a 512px icon');
  assert.ok(
    manifest.icons.some((entry) => entry.purpose === 'maskable'),
    'a maskable icon, or Android crops the artwork',
  );
});

test('every icon the manifest references exists', () => {
  const manifest = JSON.parse(read('manifest.webmanifest'));
  const referenced = new Set([
    ...manifest.icons.map((entry) => entry.src),
    ...(manifest.shortcuts ?? []).flatMap((s) => (s.icons ?? []).map((i) => i.src)),
  ]);
  for (const src of referenced) {
    assert.ok(existsSync(join(ROOT, src.replace('./', ''))), `${src} is missing`);
  }
});

test('index.html wires up the manifest, icons and theme colour', () => {
  const html = read('index.html');
  assert.match(html, /rel="manifest" href="\.\/manifest\.webmanifest"/);
  assert.match(html, /name="theme-color"/);
  assert.match(html, /rel="apple-touch-icon"/);
  assert.match(html, /viewport-fit=cover/, 'needed for safe-area insets on iOS');
  assert.match(html, /<noscript>/, 'say something useful when scripts are blocked');
});

test('the icon generator produces real PNGs', () => {
  for (const file of ['icon-192.png', 'icon-512.png', 'maskable-192.png', 'maskable-512.png']) {
    const bytes = readFileSync(join(ROOT, 'assets/icons', file));
    assert.deepEqual(
      [...bytes.subarray(0, 8)],
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      `${file} is not a PNG`,
    );
    // IHDR carries the dimensions; check they match the filename's promise.
    const expected = Number(file.match(/(\d+)\.png$/)[1]);
    assert.equal(bytes.readUInt32BE(16), expected, `${file} width`);
    assert.equal(bytes.readUInt32BE(20), expected, `${file} height`);
  }
});
