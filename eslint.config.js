// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      // packages/docs is a Nuxt app: it ships its own flat @nuxt/eslint config
      // (Vue SFC parser + Nuxt auto-import globals + generated .nuxt files) via
      // its local `lint` script. The strict typescript-eslint config here would
      // fight Nuxt's generated code and Vue templates, so lint it in-package.
      "packages/docs/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Boring defaults for a fresh scaffold; tighten per-package as real
      // code lands.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Plain Node runtime scripts (Dockerfile entrypoints, healthchecks, tooling)
    // run under Node with its globals — not part of the TS type-checked source.
    files: ["**/*.mjs", "**/*.cjs"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        URL: "readonly",
        AbortController: "readonly",
        Buffer: "readonly",
        __dirname: "readonly",
        require: "readonly",
        module: "readonly",
        fetch: "readonly",
      },
    },
  },
  // Must be last: disables stylistic rules that would conflict with Prettier.
  eslintConfigPrettier,
);
