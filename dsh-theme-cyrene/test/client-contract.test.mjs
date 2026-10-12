/**
 * The client-bundle contract.
 *
 * `dsh.client` in `package.json` is read by `dsh-client-modules`, and it reads
 * exactly two fields:
 *
 *     if (typeof decl.platform !== "string") throw new Error(`... dsh.client.platform must be ...`);
 *     const external = optionalStringArray(pkgName, "dsh.client.external", decl.external);
 *
 * Anything else in that object is **silently ignored** — no warning, no error, no
 * failed request. This file shipped for several rounds with
 * `dsh.client.inject: ["@deepseek-ai/dsh-client-ui-theme"]`, which looked like it
 * declared a dependency and declared nothing at all. The real mechanism for
 * needing another client plugin's service is the Cordis `inject` on the plugin
 * itself (`exports.inject = ["theme"]` in the bundle), which is a different thing
 * in a different place.
 *
 * So these tests pin the two halves of the contract that actually exist: the
 * manifest may only carry fields the loader reads, and every module the bundle
 * asks for must be declared.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The package manifest. */
function manifest() {
  return JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8'));
}

/** The built bundle, as text. */
function bundle() {
  return readFileSync(join(PROJECT_ROOT, 'lib', 'client.js'), 'utf8');
}

test('the bundle is a classic script that registers itself exactly once', () => {
  const source = bundle();
  // A client plugin is loaded as a plain <script>, so module syntax would be a
  // parse error in the browser rather than anything the build could notice.
  assert.equal(
    /^\s*(?:import|export)\s/mu.test(source),
    false,
    'the bundle must not use ESM syntax: it is loaded as a classic script'
  );
  const registrations = [...source.matchAll(/__ModuleLoader__\.load\(/gu)];
  assert.equal(registrations.length, 1, 'the bundle must register exactly one module');
  assert.ok(source.includes('id: "dsh-theme-cyrene"'), 'and register under the package id');
  assert.ok(source.includes('factory: (require) =>'), 'with a factory the loader can materialise lazily');
});

test('every module the bundle asks for is declared as external', () => {
  const source = bundle();
  const requested = new Set(
    [...source.matchAll(/require(?:\.async)?\(\s*"([^"]+)"/gu)].map((match) => match[1])
  );
  const declared = new Set(manifest().dsh.client.external ?? []);
  for (const specifier of requested) {
    assert.ok(
      declared.has(specifier),
      `the bundle requires "${specifier}" but dsh.client.external does not declare it`
    );
  }
  // And the other direction: a declaration nothing uses would make the loader wait
  // on a module that is never wanted.
  for (const specifier of declared) {
    assert.ok(requested.has(specifier), `dsh.client.external declares "${specifier}" but nothing requires it`);
  }
});

test('the client declaration carries only fields the loader reads', () => {
  const client = manifest().dsh.client;
  assert.equal(typeof client.platform, 'string');
  assert.equal(client.platform, 'web', 'the web shell only mounts web client plugins');

  // Read out of `dsh-client-modules/lib/index.js`. A key outside this set is not
  // an error the loader reports — it is a key the loader never looks at, which is
  // worse, because it reads like a declaration that works.
  const read = new Set(['platform', 'external']);
  for (const key of Object.keys(client)) {
    assert.ok(read.has(key), `dsh.client.${key} is never read by the loader; it declares nothing`);
  }
});

test('the plugin injects its service, rather than claiming it in the manifest', () => {
  // The service dependency lives on the plugin, not in package.json. Cordis waits
  // for `theme` before running apply, and simply never runs it if nothing provides
  // the service — a far quieter failure mode than a missing manifest field, which
  // is why the declaration must not pretend to cover it.
  const source = bundle();
  // Matched by pattern rather than by the literal array: the list grows as the
  // client half takes on services, and pinning the exact rendering made a correct
  // change look like a regression.
  const declared = /exports\.inject\s*=\s*\[([^\]]*)\]/u.exec(source);
  assert.ok(declared !== null, 'the plugin must declare its service dependencies');
  assert.ok(declared[1].includes('"theme"'), 'the theme service must be injected');
  assert.ok(
    !JSON.stringify(manifest().dsh.client).includes('inject'),
    'dsh.client.inject is not a field the loader reads'
  );
});
