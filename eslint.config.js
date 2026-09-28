import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import globals from "globals";

/**
 * Flat ESLint config. TypeScript-aware (non type-checked, so it stays fast and
 * needs no parserOptions.project), with Prettier last to switch off any rules
 * that would fight the formatter. The CLI-managed addons and build output are
 * excluded — see .prettierignore for why touching addons/ is a bad idea.
 */
export default tseslint.config(
  {
    ignores: ["dist/**", "dist-game/**", "node_modules/**", "addons/**", "public/**", "src/lib/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    /*
     * Build-time tooling that runs in Node, not in a browser or the sandbox: it legitimately uses
     * `process`, `console`, `fetch` and timers, which are undefined as far as the browser-facing
     * config above is concerned.
     */
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ["**/*.ts"],
    rules: {
      // No-op lifecycle seams (reserved hooks) are intentional in this codebase.
      "@typescript-eslint/no-empty-function": "off",
      // Allow deliberately-unused args/vars when prefixed with `_`.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
  prettier,
);
