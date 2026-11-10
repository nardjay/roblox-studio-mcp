import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

let Lua = null;
try {
  ({ Lua } = await import('@luau-rs/luau'));
} catch {
  Lua = null;
}

async function collect(dir, extension) {
  const entries = await readdir(path.join(ROOT, dir), { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) => path.join(entry.parentPath ?? entry.path, entry.name));
}

test(
  'every Luau source compiles',
  { skip: Lua ? false : 'devDependency @luau-rs/luau is not installed' },
  async () => {
    const lua = await Lua.create();
    const files = [...(await collect('plugin/src', '.luau')), ...(await collect('examples', '.luau'))].sort();
    assert.ok(files.length >= 6, `expected at least 6 Luau sources, found ${files.length}`);

    const failures = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      try {
        lua.compile(source, { optimizationLevel: 0 });
      } catch (error) {
        failures.push(`${path.relative(ROOT, file)}: ${error?.message ?? error}`);
      }
    }
    assert.deepEqual(failures, []);
  },
);
