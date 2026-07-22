import js from '@eslint/js';
import globals from 'globals';

// Deliberately narrow. The point is to catch real defects — typos that become
// implicit globals, unused bindings, unreachable code — not to enforce a style
// on 2000-odd lines of working code. In particular `no-var` is NOT enabled:
// the source uses `var` throughout, and flipping that wholesale would be a
// 300-finding diff with real risk (var is function-scoped, let is block-scoped)
// for no behavioural gain. Convert incrementally if ever, file by file.

export default [
  {
    ignores: ['dist/**', 'node_modules/**'],
  },

  js.configs.recommended,

  // Library and demo code runs in the browser.
  {
    files: ['src/**/*.js', 'demo/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.browser,
    },
    rules: {
      // Real-bug rules, as errors.
      'no-implicit-globals': 'error',
      'no-undef': 'error',
      'no-unused-vars': ['error', { args: 'none', varsIgnorePattern: '^_' }],

      // Genuine hazards in this codebase, surfaced but not blocking. These are
      // a backlog, not a gate: `npm run lint` stays green so that a *new* error
      // is visible immediately.
      eqeqeq: ['warn', 'smart'],          // ~45 loose comparisons
      'no-redeclare': 'warn',             // ~31 repeated `var` in one function —
                                          // harmless under var's function scope,
                                          // but a trap when converting to let
      'no-shadow': 'warn',
      'no-fallthrough': 'warn',
    },
  },

  // demo/*.js are loaded as classic scripts and share globals across files.
  {
    files: ['demo/**/*.js'],
    languageOptions: { sourceType: 'script' },
    rules: {
      'no-implicit-globals': 'off',
      'no-unused-vars': 'off',            // demo generators are consumed by inline <script>
    },
  },

  // Tests and dev scripts run in Node.
  {
    files: ['test/**/*.mjs', 'scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      'no-unused-vars': ['error', { args: 'none', varsIgnorePattern: '^_' }],
    },
  },
];
