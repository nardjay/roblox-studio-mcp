#!/usr/bin/env node
/**
 * Packs plugin/src/*.luau into a single Studio plugin model (plugin/RobloxMCP.rbxmx).
 *
 * Studio loads `.rbxmx` files dropped into its Plugins folder directly, so this
 * keeps distribution to one file while the source stays split into modules.
 */
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, 'src');
const OUT = path.join(here, 'RobloxMCP.rbxmx');
const MODULE_ORDER = ['Api', 'Codec', 'Ops', 'Paths'];

const escapeXml = (text) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function item(className, name, source, referent, children = '') {
  return [
    `  <Item class="${className}" referent="RBX${referent}">`,
    '    <Properties>',
    `      <string name="Name">${escapeXml(name)}</string>`,
    `      <ProtectedString name="Source">${escapeXml(source)}</ProtectedString>`,
    '    </Properties>',
    children,
    '  </Item>',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

async function main() {
  const files = (await readdir(SRC)).filter((file) => file.endsWith('.luau'));
  const entryFile = files.find((file) => file === 'init.server.luau');
  if (!entryFile) throw new Error('plugin/src/init.server.luau is missing');

  const entrySource = await readFile(path.join(SRC, entryFile), 'utf8');

  const modules = [];
  let referent = 1;
  for (const name of MODULE_ORDER) {
    const file = `${name}.luau`;
    if (!files.includes(file)) throw new Error(`plugin/src/${file} is missing`);
    const source = await readFile(path.join(SRC, file), 'utf8');
    modules.push(item('ModuleScript', name, source, referent++));
  }

  const unexpected = files.filter(
    (file) => file !== entryFile && !MODULE_ORDER.map((name) => `${name}.luau`).includes(file),
  );
  if (unexpected.length > 0) throw new Error(`unexpected plugin sources: ${unexpected.join(', ')}`);

  const body = item('Script', 'RobloxMCP', entrySource, 0, modules.join('\n'));
  const xml = [
    '<roblox xmlns:xmime="http://www.w3.org/2005/05/xmlmime" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.roblox.com/roblox.xsd" version="4">',
    body,
    '</roblox>',
    '',
  ].join('\n');

  await mkdir(here, { recursive: true });
  await writeFile(OUT, xml, 'utf8');

  const bytes = Buffer.byteLength(xml);
  process.stdout.write(`wrote ${path.relative(process.cwd(), OUT)} (${bytes} bytes, ${modules.length} modules)\n`);
}

await main();
