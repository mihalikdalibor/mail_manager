import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // .claude/: agent tooling (security probes), not app code — outside tsconfig and the build.
  { ignores: ['dist/', 'coverage/', 'node_modules/', '.claude/'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['eslint.config.js'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  // Core logic must not print; only the CLI shell talks to the terminal.
  { files: ['src/core/**/*.ts'], rules: { 'no-console': 'error' } },
);
