#!/usr/bin/env node
// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import stylelint from 'stylelint';
import { HtmlValidate } from 'html-validate';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const excluded = new Set(['.git', '.local', 'node_modules', 'coverage', 'dist', '__pycache__', '.ruff_cache']);
async function inventory(directory = '.') {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (excluded.has(entry.name) || entry.isSymbolicLink()) continue;
    const name = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await inventory(name));
    else if (entry.isFile()) files.push(name);
  }
  return files.sort();
}

const files = await inventory();
const eslint = new ESLint();
const javascript = await eslint.lintFiles(files.filter(name => /\.(?:mjs|js)$/.test(name)));
const css = await stylelint.lint({ files: files.filter(name => name.endsWith('.css')) });
const validator = new HtmlValidate(JSON.parse(await fs.readFile('.htmlvalidate.json', 'utf8')));
const htmlFiles = files.filter(name => name.endsWith('.html'));
const html = [];
for (const name of htmlFiles) html.push(...(await validator.validateFile(name)).results);
let errors = javascript.reduce((count, result) => count + result.errorCount + result.warningCount, 0);
for (const result of javascript) for (const message of result.messages) console.error(`${path.relative(root, result.filePath)}:${message.line}:${message.column} ${message.ruleId}: ${message.message}`);
for (const result of css.results) {
  for (const message of [...result.warnings, ...result.parseErrors, ...result.invalidOptionWarnings]) {
    errors++;
    console.error(`${path.relative(root, result.source)}:${message.line ?? 1} ${message.text}`);
  }
}
for (const result of html) for (const message of result.messages) {
  errors++;
  console.error(`${path.relative(root, result.filePath)}:${message.line}:${message.column} ${message.ruleId}: ${message.message}`);
}
const json = files.filter(name => name.endsWith('.json'));
for (const name of json) {
  try { JSON.parse(await fs.readFile(name, 'utf8')); }
  catch (error) { errors++; console.error(`${name}: ${error.message}`); }
}
console.log(JSON.stringify({ javascript: javascript.length, css: css.results.length, html: htmlFiles.length, json: json.length, errors }));
process.exitCode = errors || css.errored ? 1 : 0;
