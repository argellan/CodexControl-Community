// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/**', '.local/**', 'coverage/**', 'dist/**'] },
  {
    files: ['**/*.mjs', '**/*.js'],
    ...js.configs.recommended,
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: globals.node },
    rules: {
      ...js.configs.recommended.rules,
      // These validators deliberately reject ASCII controls at trust boundaries.
      'no-control-regex': 'off',
      // Public errors deliberately exclude raw upstream errors and private paths.
      'preserve-caught-error': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['error', { args: 'after-used', caughtErrors: 'none', ignoreRestSiblings: true }],
    },
  },
  { files: ['public/**/*.mjs', 'public/**/*.js'], languageOptions: { globals: { ...Object.fromEntries(Object.keys(globals.node).map(name => [name, 'off'])), ...globals.browser } } },
];
