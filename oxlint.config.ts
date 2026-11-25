import { defineConfig } from "oxlint";

// `no-restricted-syntax` is not implemented by oxlint; this local JS plugin
// provides it with the same selector options. It reports as
// `local/no-restricted-syntax`.
const restrictedSyntaxPlugin = "./scripts/oxlint/restricted-syntax-plugin.mjs";

const sandboxImplementationImports = [
  {
    regex: "(?:^|/)sandbox-repository(?:\\.[cm]?[jt]sx?)?$",
    message:
      "Only session composition constructs SandboxRepository. Consumers use sandbox-ports; lifecycle effects use their storage port.",
  },
  {
    regex: "(?:^|/)lifecycle/manager(?:\\.[cm]?[jt]sx?)?$",
    importNames: ["SandboxLifecycleManager"],
    message:
      "Only session composition constructs the lifecycle manager. Consumers depend on focused lifecycle ports.",
  },
  {
    regex: "(?:^|/)lifecycle/launch-context(?:\\.[cm]?[jt]sx?)?$",
    message: "Launch inputs are internal to lifecycle composition. Consumers use lifecycle ports.",
  },
  {
    regex: "(?:^|/)lifecycle/sandbox-access(?:\\.[cm]?[jt]sx?)?$",
    message:
      "Access mechanics are internal to lifecycle composition. Consumers use lifecycle ports and session access readers.",
  },
  {
    regex: "(?:^|/)lifecycle/vm-startup-reconciliation(?:\\.[cm]?[jt]sx?)?$",
    message:
      "VM startup reconciliation is internal to the lifecycle manager. Consumers use lifecycle ports.",
  },
  {
    regex: "(?:^|/)lifecycle/allocation-cleanup(?:\\.[cm]?[jt]sx?)?$",
    message:
      "Allocation cleanup is internal to the lifecycle manager. Consumers use lifecycle ports.",
  },
  {
    regex: "(?:^|/)lifecycle/provider-stop(?:\\.[cm]?[jt]sx?)?$",
    message:
      "Bounded provider-stop mechanics are internal to lifecycle. Consumers use lifecycle ports.",
  },
  {
    regex: "(?:^|/)lifecycle/startup-errors(?:\\.[cm]?[jt]sx?)?$",
    message:
      "Startup abandonment errors are internal to lifecycle. Consumers use lifecycle outcomes.",
  },
  {
    regex: "(?:^|/)lifecycle/watchdog-effects(?:\\.[cm]?[jt]sx?)?$",
    message:
      "Watchdog effects are internal to the lifecycle manager. Consumers use lifecycle ports.",
  },
];

const compositionRootImport = {
  regex: "(?:^|/)components(?:\\.[cm]?[jt]sx?)?$",
  message:
    "Only the platform adapters (cloudflare/durable-object.ts, node/host.ts) may import the composition root. Take dependencies as constructor inputs instead.",
};

const platformAdapterImport = {
  regex: "(?:^|/)durable-object(?:\\.[cm]?[jt]sx?)?$",
  message:
    "Only the worker entrypoint (src/index.ts) may import the platform adapter. Depend on the session collaborators, not the Durable Object.",
};

const nodeHostImport = {
  // The directory and anything under it, by relative path or the `@/` alias,
  // at any depth: `../node`, `../node/x`, `@/node/y/z`. Package subpaths such
  // as `better-auth/node` are not ours.
  regex: "^(?:\\.\\.?/(?:.*/)?|@/)node(?:/|$)",
  message:
    "Only the Node host (src/node/**) may import its adapters; the worker bundle must not reach node:* modules.",
};

// Repo-wide import bans. Oxlint has one `no-restricted-imports` rule (ESLint
// ran this as a separate typescript-eslint rule that stacked with the base
// rule), and a later override REPLACES the rule's config for files it matches,
// so every block below that configures the rule spreads these paths back in.
const sharedEntrypointPaths = [
  {
    name: "@open-inspect/shared",
    importNames: [
      "TOKEN_VALIDITY_MS",
      "timingSafeEqual",
      "bytesToHex",
      "computeHmacHex",
      "generateInternalToken",
      "verifyCallbackSignature",
      "verifyCallbackFromControlPlane",
    ],
    message: "Import auth-owned names from @open-inspect/shared/auth.",
  },
  {
    name: "@open-inspect/shared",
    importNames: [
      "ACTOR_HEADER",
      "ControlPlaneFetcher",
      "OutboundBinaryBody",
      "OutboundCredentialEnv",
      "OutboundRequestToSign",
      "OutboundServiceCredential",
      "SERVICE_HEADER",
      "SERVICE_NAMES",
      "SERVICE_SIGNATURE_HEADER",
      "SIG1_PREFIX",
      "ServiceName",
      "ServiceSignatureFailure",
      "ServiceSignatureHeaderParse",
      "ServiceSignatureResult",
      "SignedFetchInit",
      "buildCanonicalRequestString",
      "buildOutboundAuthHeaders",
      "buildServiceAuthHeaders",
      "canonicalizeQuery",
      "isServiceName",
      "parseServiceSignatureHeader",
      "resolveOutboundCredential",
      "sha256Hex",
      "signedControlPlaneFetch",
      "verifyServiceSignature",
    ],
    message: "Import service-auth-owned names from @open-inspect/shared/service-auth.",
  },
];

const envDbBan = {
  selector: 'MemberExpression[property.name="DB"]',
  message:
    "Use the injected SqlDatabase (ctx.db / this.db / a db param) instead of env.DB; the binding is read only at composition roots.",
};

const controlPlaneTests = "packages/control-plane/src/**/*.test.ts";

export default defineConfig({
  plugins: ["typescript"],
  jsPlugins: [restrictedSyntaxPlugin],
  // Only the rules below run, mirroring ESLint's `recommended` presets rather
  // than oxlint's default `correctness` category.
  categories: { correctness: "off" },
  env: { builtin: true },
  ignorePatterns: [
    "**/node_modules/**",
    "**/dist/**",
    "**/.cloudflare/**",
    "**/.vinext/**",
    "**/.next/**",
    "**/.source/**",
    "**/build/**",
    "**/.wrangler/**",
    "**/coverage/**",
    "**/.venv/**",
    "**/venv/**",
    ".cache/sandbox-images/**",
    "opencode-reference/**",
    "**/*.d.ts",
    // Bundled/generated files
    "packages/modal-infra/**/*.js",
    // Sandbox runtime JS/TS files run inside sandboxes (Node.js), not part of the TS project
    "packages/sandbox-runtime/**",
  ],

  // eslint:recommended + typescript-eslint recommended
  rules: {
    "constructor-super": "error",
    "for-direction": "error",
    "getter-return": "error",
    "no-async-promise-executor": "error",
    "no-case-declarations": "error",
    "no-class-assign": "error",
    "no-compare-neg-zero": "error",
    "no-cond-assign": "error",
    "no-const-assign": "error",
    "no-constant-binary-expression": "error",
    "no-constant-condition": "error",
    "no-control-regex": "error",
    "no-debugger": "error",
    "no-delete-var": "error",
    "no-dupe-class-members": "error",
    "no-dupe-else-if": "error",
    "no-dupe-keys": "error",
    "no-duplicate-case": "error",
    "no-empty": "error",
    "no-empty-character-class": "error",
    "no-empty-pattern": "error",
    "no-empty-static-block": "error",
    "no-ex-assign": "error",
    "no-extra-boolean-cast": "error",
    "no-fallthrough": "error",
    "no-func-assign": "error",
    "no-global-assign": "error",
    "no-import-assign": "error",
    "no-invalid-regexp": "error",
    "no-irregular-whitespace": "error",
    "no-loss-of-precision": "error",
    "no-misleading-character-class": "error",
    "no-new-native-nonconstructor": "error",
    "no-nonoctal-decimal-escape": "error",
    "no-obj-calls": "error",
    "no-prototype-builtins": "error",
    "no-redeclare": "error",
    "no-regex-spaces": "error",
    "no-self-assign": "error",
    "no-setter-return": "error",
    "no-shadow-restricted-names": "error",
    "no-sparse-arrays": "error",
    "no-this-before-super": "error",
    "no-unreachable": "error",
    "no-unsafe-finally": "error",
    "no-unsafe-negation": "error",
    "no-unsafe-optional-chaining": "error",
    "no-unused-labels": "error",
    "no-unused-private-class-members": "error",
    "no-unused-vars": "error",
    "no-useless-backreference": "error",
    "no-useless-catch": "error",
    "no-useless-escape": "error",
    "no-with": "error",
    "require-yield": "error",
    "use-isnan": "error",
    "valid-typeof": "error",
    "no-array-constructor": "error",
    "no-unused-expressions": "error",
    "typescript/ban-ts-comment": "error",
    "typescript/no-duplicate-enum-values": "error",
    "typescript/no-empty-object-type": "error",
    "typescript/no-explicit-any": "error",
    "typescript/no-extra-non-null-assertion": "error",
    "typescript/no-misused-new": "error",
    "typescript/no-namespace": "error",
    "typescript/no-non-null-asserted-optional-chain": "error",
    "typescript/no-require-imports": "error",
    "typescript/no-this-alias": "error",
    "typescript/no-unnecessary-type-constraint": "error",
    "typescript/no-unsafe-declaration-merging": "error",
    "typescript/no-unsafe-function-type": "error",
    "typescript/no-wrapper-object-types": "error",
    "typescript/prefer-as-const": "error",
    "typescript/prefer-namespace-keyword": "error",
    "typescript/triple-slash-reference": "error",
  },

  overrides: [
    // typescript-eslint's `eslint-recommended` overlay: the compiler already
    // checks these in TypeScript files.
    {
      files: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"],
      rules: {
        "constructor-super": "off",
        "getter-return": "off",
        "no-class-assign": "off",
        "no-const-assign": "off",
        "no-dupe-class-members": "off",
        "no-dupe-keys": "off",
        "no-func-assign": "off",
        "no-import-assign": "off",
        "no-new-native-nonconstructor": "off",
        "no-obj-calls": "off",
        "no-redeclare": "off",
        "no-setter-return": "off",
        "no-this-before-super": "off",
        "no-unreachable": "off",
        "no-unsafe-negation": "off",
        "no-with": "off",
        "no-var": "error",
        "prefer-const": "error",
        "prefer-rest-params": "error",
        "prefer-spread": "error",
      },
    },

    // Repository-authored and runtime-injected OpenCode extensions run under Node.js.
    {
      files: [".opencode/**/*.{js,ts}"],
      env: { node: true },
      rules: { "no-unused-vars": ["error", { argsIgnorePattern: "^_" }] },
    },

    // Plain Node scripts that run outside a bundler: the compose smoke's driver
    // and its stand-in sandbox host.
    {
      files: ["**/*.mjs"],
      env: { node: true, es2022: true },
    },

    // TypeScript files configuration
    {
      files: ["packages/**/*.{ts,tsx}"],
      env: { node: true, es2022: true },
      rules: {
        "no-unused-vars": [
          "error",
          { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
        ],
        "typescript/no-explicit-any": "warn",
        "typescript/consistent-type-imports": [
          "error",
          { prefer: "type-imports", fixStyle: "separate-type-imports" },
        ],
        "no-restricted-imports": ["error", { paths: sharedEntrypointPaths }],
        // Allow console in backend/server code - disable per-file if needed
        "no-console": "off",
      },
    },

    // Control-plane data-layer boundary: all production code must use the
    // injected SqlDatabase (ctx.db, a DO's db field, or a db parameter), never
    // the raw env.DB binding — reading the binding elsewhere would silently
    // bypass the injection path and, on request paths, query instrumentation.
    // The only legitimate reads are the composition roots (the Worker entry,
    // the Hono lifecycle, the Durable Object constructor), each carrying an
    // inline disable comment with justification.
    //
    // Platform boundary, same family: Cloudflare's binding types are named
    // only where the Worker's bindings are turned into the platform ports
    // (src/cloudflare/** and src/index.ts). Everything else depends on the
    // port — SqlDatabase, CacheStore, ObjectStorage, SessionRuntimeClient,
    // FetchClient, the queue ports — so it compiles unchanged on the Node host.
    // A later override's config for the same rule REPLACES the earlier one for
    // files both match, so the exempted files re-declare the env.DB ban that
    // still applies to them.
    {
      files: ["packages/control-plane/src/**/*.ts"],
      excludeFiles: [
        controlPlaneTests,
        "packages/control-plane/src/cloudflare/**/*.ts",
        "packages/control-plane/src/index.ts",
      ],
      rules: {
        "local/no-restricted-syntax": [
          "error",
          envDbBan,
          {
            selector:
              "TSTypeReference[typeName.name=/^(D1Database|D1PreparedStatement|KVNamespace|R2Bucket|DurableObjectNamespace|Fetcher|Queue)$/]",
            message:
              "Cloudflare binding types are named only in src/cloudflare/** and src/index.ts; depend on the platform port (see Platform in types.ts) instead.",
          },
        ],
      },
    },
    {
      files: [
        "packages/control-plane/src/cloudflare/**/*.ts",
        "packages/control-plane/src/index.ts",
      ],
      excludeFiles: [controlPlaneTests],
      rules: { "local/no-restricted-syntax": ["error", envDbBan] },
    },

    // Session boundary rules, in the same family as the env.DB ban above:
    //  - the composition root (session/components.ts) is the platform adapter's
    //    private wiring: only cloudflare/durable-object.ts may import it —
    //    services take their dependencies as constructor inputs, never by
    //    reaching into the root;
    //  - the platform adapter (cloudflare/durable-object.ts) is the Cloudflare
    //    edge of the session: only the worker entrypoint may import it, so
    //    nothing the factory builds can hold a reference back to the DO.
    //  - the Node host's adapters (src/node/**) import Node built-ins that the
    //    worker bundle marks external: nothing outside that directory may
    //    import them, so the workerd build cannot pick them up.
    // As above, this general block carries all the bans and each exempted file
    // re-declares the ban that still applies to it.
    {
      files: ["packages/control-plane/src/**/*.ts"],
      excludeFiles: [
        "packages/control-plane/src/cloudflare/durable-object.ts",
        "packages/control-plane/src/index.ts",
        controlPlaneTests,
        "packages/control-plane/src/node/**/*.ts",
      ],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            paths: sharedEntrypointPaths,
            patterns: [
              ...sandboxImplementationImports,
              compositionRootImport,
              platformAdapterImport,
              nodeHostImport,
            ],
          },
        ],
      },
    },
    // The Node host's adapters may import each other but not the Cloudflare
    // edge or the composition root. The Node host itself (src/node/host.ts)
    // is the Node counterpart of the Durable Object adapter: it builds the
    // session runtime, so it may import the composition root, and it alone.
    {
      files: ["packages/control-plane/src/node/**/*.ts"],
      excludeFiles: [controlPlaneTests, "packages/control-plane/src/node/host.ts"],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            paths: sharedEntrypointPaths,
            patterns: [
              ...sandboxImplementationImports,
              compositionRootImport,
              platformAdapterImport,
            ],
          },
        ],
      },
    },
    {
      files: ["packages/control-plane/src/node/host.ts"],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            paths: sharedEntrypointPaths,
            patterns: [...sandboxImplementationImports, platformAdapterImport],
          },
        ],
      },
    },
    // The worker entrypoint may import the adapter (it exports the DO class to
    // the runtime) but not the composition root.
    {
      files: ["packages/control-plane/src/index.ts"],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            paths: sharedEntrypointPaths,
            patterns: [...sandboxImplementationImports, compositionRootImport, nodeHostImport],
          },
        ],
      },
    },

    // The Cloudflare host composes the session runtime, not individual implementations.
    {
      files: ["packages/control-plane/src/cloudflare/durable-object.ts"],
      rules: {
        "no-restricted-imports": [
          "error",
          { paths: sharedEntrypointPaths, patterns: sandboxImplementationImports },
        ],
      },
    },

    // Cloudflare Workers specific config
    {
      files: ["packages/control-plane/**/*.ts"],
      env: { worker: true },
    },

    // React-specific configuration for browser packages
    {
      files: ["packages/{docs,web}/**/*.{ts,tsx}"],
      plugins: ["typescript", "react"],
      env: { browser: true },
      rules: {
        // eslint-plugin-react recommended
        "react/display-name": "error",
        "react/jsx-key": "error",
        "react/jsx-no-comment-textnodes": "error",
        "react/jsx-no-duplicate-props": "error",
        "react/jsx-no-target-blank": "error",
        "react/jsx-no-undef": "error",
        "react/no-children-prop": "error",
        "react/no-danger-with-children": "error",
        "react/no-direct-mutation-state": "error",
        "react/no-find-dom-node": "error",
        "react/no-is-mounted": "error",
        "react/no-render-return-value": "error",
        "react/no-string-refs": "error",
        "react/no-unescaped-entities": "error",
        "react/no-unknown-property": "error",
        "react/react-in-jsx-scope": "off",
        // eslint-plugin-react-hooks recommended (oxlint exposes these under `react/`)
        "react/rules-of-hooks": "error",
        "react/exhaustive-deps": "warn",
        "react/static-components": "error",
        "react/use-memo": "error",
        "react/incompatible-library": "warn",
        "react/immutability": "error",
        "react/globals": "error",
        "react/error-boundaries": "error",
        "react/purity": "error",
        "react/set-state-in-render": "error",
        "react/unsupported-syntax": "warn",
        // eslint-plugin-react-hooks 7 folds the React Compiler checks into
        // `recommended`. These apps do not run the compiler, and the three rules
        // below flag established patterns (fetch-and-sync effects, latest-value
        // refs, hand-written memoization) across dozens of components. Rewriting
        // them would change render timing for no runtime gain, so they stay off
        // until the compiler is adopted. The other compiler rules stay on.
        "react/set-state-in-effect": "off",
        "react/refs": "off",
        "react/preserve-manual-memoization": "off",
      },
    },

    // Web code depends on app-owned auth and request seams. OAuth and session
    // protocol code is owned by the control plane.
    {
      files: ["packages/web/src/**/*.{ts,tsx}"],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            paths: [
              ...sharedEntrypointPaths,
              {
                name: "next-auth",
                message: "Use the app-owned browser authentication seams.",
              },
            ],
            patterns: [
              {
                group: ["next-auth/*"],
                message: "Use the app-owned browser authentication seams.",
              },
              {
                regex: "(?:^|/)lib/auth$",
                message: "Use getServerAuthSession from @/lib/server-auth-session.",
              },
            ],
          },
        ],
      },
    },
    {
      files: ["packages/web/src/**/*.{ts,tsx}"],
      excludeFiles: [
        "**/*.test.{ts,tsx}",
        "**/*.spec.{ts,tsx}",
        "packages/web/src/lib/browser-api-fetch.ts",
        "packages/web/src/lib/control-plane-transport.ts",
      ],
      rules: {
        "no-restricted-globals": [
          "error",
          { name: "fetch", message: "Use an app-owned HTTP transport instead of raw fetch." },
        ],
      },
    },
    {
      files: ["packages/web/src/**/*.tsx"],
      rules: {
        "local/no-restricted-syntax": [
          "error",
          {
            selector: 'JSXOpeningElement[name.name="select"]',
            message:
              "Use Select / SelectTrigger / SelectContent / SelectItem from @/components/ui/select instead of a native <select>.",
          },
        ],
      },
    },

    // Test files configuration
    {
      files: ["**/*.test.{ts,tsx}", "**/*.spec.{ts,tsx}"],
      rules: {
        "typescript/no-explicit-any": "off",
        "no-console": "off",
        // Oxlint sees through `(x?.y as T).z` casts, which ESLint's rule does
        // not; tests use them on mock call records that are known to exist.
        "no-unsafe-optional-chaining": "off",
      },
    },
  ],
});
