import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'dist-electron', 'node_modules'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    files: ['electron/**/*.ts', 'scripts/**/*.mjs', 'tests/**/*.ts', '*.config.{mts,mjs}'],
    languageOptions: { globals: globals.node },
  },
  {
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: "CallExpression[callee.name='eval']", message: 'eval is forbidden.' },
        { selector: "NewExpression[callee.name='Function']", message: 'new Function is forbidden.' },
      ],
      'no-restricted-properties': [
        'error',
        { property: 'innerHTML', message: 'Render through React; do not assign innerHTML.' },
      ],
    },
  },
);
