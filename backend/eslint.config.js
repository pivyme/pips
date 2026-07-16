// @ts-check
// ESLint 10 flat config. The old .eslintrc.cjs was dead twice over: ESLint 9+ dropped the eslintrc
// format, and its default parser never understood TypeScript syntax anyway. This wires the
// typescript-eslint parser so .ts actually lints, and keeps the ruleset deliberately conservative
// (warnings, not errors) so the gate stays green on this existing codebase while still catching real
// mistakes. Tighten rules to errors incrementally, not in one sweep.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // Source is entirely TypeScript; skip generated code and the JS/CJS tooling config files
    // (eslint.config.js, .prettierrc.js) so they don't trip core rules meant for source.
    ignores: ['node_modules/**', 'prisma/generated/**', 'dist/**', 'build/**', '**/*.js', '**/*.cjs', '**/*.mjs'],
  },
  js.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        // Bun/Node runtime globals. The runtime is Bun (Fetch, Bun, process are all present).
        process: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        Bun: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        queueMicrotask: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        Buffer: 'readonly',
        WebSocket: 'readonly',
        crypto: 'readonly',
        structuredClone: 'readonly',
        globalThis: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    rules: {
      // TS handles undefined-symbol resolution far better than eslint's core rule (which flags every
      // type name); keep it off for TS, this is typescript-eslint's own recommendation.
      'no-undef': 'off',
      // Unused vars are a warning, not a build failure. `_`-prefixed args are intentional throwaways.
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // Empty catch/blocks are used deliberately for best-effort self-healing paths; warn, don't fail.
      'no-empty': 'warn',
      // `while (true)` loops and intentional constant guards exist in the worker/retry code.
      'no-constant-condition': ['warn', { checkLoops: false }],
      // ESLint 10 promoted these to recommended-error; they are good practice but retrofitting the
      // whole codebase is out of scope here, so surface them as warnings to fix incrementally.
      'preserve-caught-error': 'warn',
      'no-useless-assignment': 'warn',
    },
  },
);
