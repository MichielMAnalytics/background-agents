// Oxlint JS plugin that provides ESLint's `no-restricted-syntax`, which oxlint
// does not implement natively. Options are the same as ESLint's: a list of
// `{ selector, message }` objects, where `selector` is an esquery AST selector.
export default {
  meta: { name: "local" },
  rules: {
    "no-restricted-syntax": {
      meta: {
        schema: {
          type: "array",
          items: {
            type: "object",
            properties: { selector: { type: "string" }, message: { type: "string" } },
            required: ["selector"],
            additionalProperties: false,
          },
        },
      },
      create(context) {
        const visitor = {};
        for (const { selector, message } of context.options) {
          const previous = visitor[selector];
          visitor[selector] = (node) => {
            previous?.(node);
            context.report({ node, message });
          };
        }
        return visitor;
      },
    },
  },
};
