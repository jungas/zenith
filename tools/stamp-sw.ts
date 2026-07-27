/**
 * Stamps the built service worker with a version derived from the shell's
 * contents.
 *
 * Why this exists: the worker's cache names are `zenith-shell-${VERSION}` and
 * `zenith-runtime-${VERSION}`, and `activate` deletes every cache whose name is
 * not one of those two. So the version *is* the cache-busting mechanism — while
 * it stays the same, a returning visitor keeps being served the shell files
 * already in their cache, and a redesign can ship without anyone seeing it.
 *
 * Hand-bumping a constant is exactly the step that gets forgotten, so the build
 * derives it instead: a hash of every source the shell is built from. Identical
 * inputs produce an identical version — deploys that change nothing do not force
 * anybody to re-download the app — and any real change produces a new one.
 *
 * The hash covers *sources* rather than the emitted `dist/` files so that
 * `tests/pwa.test.ts` can recompute the expected value without a build.
 */

import { createHash } from 'node:crypto';
import { globSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Everything the app shell is built from, in a stable order. */
export const SHELL_SOURCES = [
  'src/**/*.ts',
  'styles/*.css',
  'index.html',
  'manifest.webmanifest',
  'assets/icons/*',
];

export function shellVersion(root: string = ROOT): string {
  const files = globSync(SHELL_SOURCES, { cwd: root })
    .map((file) => file.replaceAll('\\', '/'))
    .sort();
  const hash = createHash('sha256');
  for (const file of files) {
    // The name goes in too, so that renaming a file changes the version even
    // when its bytes do not.
    hash.update(file);
    hash.update(readFileSync(join(root, file)));
  }
  return `v${hash.digest('hex').slice(0, 12)}`;
}

function main(): void {
  const target = join(ROOT, 'sw.js');
  let source: string;
  try {
    source = readFileSync(target, 'utf8');
  } catch {
    console.error('stamp-sw: sw.js not found — run tsc -p tsconfig.sw.json first');
    process.exitCode = 1;
    return;
  }

  const version = shellVersion();
  const stamped = source.replace(/const VERSION = '[^']*';/, `const VERSION = '${version}';`);
  if (stamped === source) {
    console.error('stamp-sw: no VERSION constant found in sw.js');
    process.exitCode = 1;
    return;
  }

  writeFileSync(target, stamped);
  console.log(`stamped sw.js with ${version}`);
}

// Only stamp when run as a command; the test imports `shellVersion` directly.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main();
