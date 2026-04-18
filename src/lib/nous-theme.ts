import type { ThemeRegistration } from 'shiki';

/**
 * Nous — a warm, typographic palette for Shiki, tuned to the Claude
 * Parchment aesthetic (editorial room, not sci-fi terminal).
 *
 * Rules (from the spec):
 * - Warm-only: no blue / purple / teal / cool grey.
 * - Low-saturation, muted, no neon.
 * - Terracotta = brand keyword colour; Sage = only green; Crimson = danger.
 * - Comments italic.
 */

const light = {
  fg: '#141413', // Near Black
  comment: '#87867f', // Stone Gray
  keyword: '#c96442', // Terracotta
  string: '#6b8e5e', // Sage
  func: '#3d3d3a', // Dark Warm
  prop: '#6e4a5a', // Plum
  num: '#4d4c48', // Charcoal Warm
  op: '#5e5d59', // Olive Gray
  important: '#b53333', // Crimson
  bg: '#faf9f5', // Ivory card
};

const dark = {
  fg: '#e8e6dc',
  comment: '#87867f',
  keyword: '#d97757', // Coral (terracotta's brighter twin)
  string: '#8fa67d', // Sage bright
  func: '#d5d2c6',
  prop: '#a68898', // Plum bright
  num: '#b0aea5', // Warm Silver
  op: '#a8a69a',
  important: '#e08585',
  bg: '#1f1e1d',
};

type Palette = typeof light;

function buildTokens(c: Palette) {
  return [
    // Baseline — any identifier-like token falls back to foreground.
    { scope: ['source', 'text', 'variable', 'variable.other'], settings: { foreground: c.fg } },

    // Punctuation & operators — the most "structural" ink, softer than fg.
    {
      scope: [
        'keyword.operator',
        'keyword.operator.arithmetic',
        'keyword.operator.assignment',
        'keyword.operator.comparison',
        'keyword.operator.logical',
        'keyword.operator.bitwise',
        'keyword.operator.ternary',
        'keyword.operator.type.annotation',
        'keyword.operator.accessor',
        'punctuation',
        'punctuation.separator',
        'punctuation.terminator',
        'punctuation.section',
        'meta.brace',
        'meta.bracket',
        'meta.delimiter',
      ],
      settings: { foreground: c.op },
    },

    // Keywords / storage / language-level identifiers — Terracotta brand.
    {
      scope: [
        'keyword',
        'keyword.control',
        'keyword.control.flow',
        'keyword.control.import',
        'keyword.control.export',
        'keyword.control.from',
        'keyword.control.conditional',
        'keyword.control.loop',
        'keyword.control.trycatch',
        'keyword.control.return',
        'keyword.other',
        'keyword.operator.new',
        'keyword.operator.expression',
        'keyword.operator.delete',
        'keyword.operator.typeof',
        'keyword.operator.instanceof',
        'keyword.operator.in',
        'storage',
        'storage.type',
        'storage.type.function',
        'storage.type.class',
        'storage.type.struct',
        'storage.type.enum',
        'storage.type.interface',
        'storage.type.trait',
        'storage.modifier',
        'storage.modifier.async',
        'variable.language',
        'variable.language.this',
        'variable.language.self',
        'variable.language.super',
        'constant.language.import-export-all',
        // HTML/JSX/Vue tags
        'entity.name.tag',
        'entity.name.tag.html',
        'entity.name.tag.jsx',
        'entity.name.tag.tsx',
        // CSS at-rules and tag selectors
        'keyword.control.at-rule',
        'meta.at-rule',
        'meta.at-rule keyword',
        'entity.name.tag.css',
        'punctuation.definition.keyword',
        // Decorators
        'meta.decorator variable.other',
        'meta.decorator punctuation.decorator',
      ],
      settings: { foreground: c.keyword },
    },

    // Strings — the only green allowed.
    {
      scope: [
        'string',
        'string.quoted',
        'string.quoted.single',
        'string.quoted.double',
        'string.quoted.triple',
        'string.unquoted',
        'string.template',
        'string.interpolated',
        'punctuation.definition.string',
        'punctuation.definition.string.begin',
        'punctuation.definition.string.end',
        'constant.character',
        'constant.character.escape',
        'constant.other.symbol',
      ],
      settings: { foreground: c.string },
    },

    // Numbers / boolean / null / constants.
    {
      scope: [
        'constant.numeric',
        'constant.numeric.integer',
        'constant.numeric.float',
        'constant.numeric.hex',
        'constant.language.boolean',
        'constant.language.true',
        'constant.language.false',
        'constant.language.null',
        'constant.language.undefined',
        'constant.language.nil',
        'constant.language',
        'constant.other',
        'support.constant',
        'variable.other.constant',
      ],
      settings: { foreground: c.num },
    },

    // Functions / classes / types — the "named things".
    {
      scope: [
        'entity.name.function',
        'entity.name.function.call',
        'entity.name.class',
        'entity.name.type',
        'entity.name.type.class',
        'entity.name.type.struct',
        'entity.name.type.enum',
        'entity.name.type.interface',
        'entity.name.type.trait',
        'entity.name.type.alias',
        'entity.name.namespace',
        'meta.function-call.generic',
        'meta.definition.function entity.name',
        'support.function',
        'support.function.builtin',
        'support.class',
        'support.type',
        'support.type.builtin',
      ],
      settings: { foreground: c.func },
    },

    // Object / property keys, HTML/JSX attributes, CSS properties.
    {
      scope: [
        'variable.other.property',
        'variable.other.object.property',
        'variable.object.property',
        'meta.object-literal.key',
        'meta.object.member',
        'meta.property.object.literal',
        'meta.property-name',
        'support.type.property-name',
        'support.type.property-name.css',
        'entity.other.attribute-name',
        'entity.other.attribute-name.html',
        'entity.other.attribute-name.class.css',
        'entity.other.attribute-name.id.css',
        'entity.other.attribute-name.pseudo-class.css',
        'entity.other.attribute-name.pseudo-element.css',
        // YAML mapping keys look like object keys.
        'entity.name.tag.yaml',
        'entity.name.tag.toml',
      ],
      settings: { foreground: c.prop },
    },

    // Errors / warnings / regex literals / !important — warm crimson.
    {
      scope: [
        'invalid',
        'invalid.illegal',
        'invalid.deprecated',
        'string.regexp',
        'punctuation.definition.string.begin.regexp',
        'punctuation.definition.string.end.regexp',
        'keyword.other.important',
        'keyword.other.important.css',
      ],
      settings: { foreground: c.important },
    },

    // Comments — stone gray, italic. Placed last so `fontStyle` isn't
    // clobbered by earlier rules sharing scope prefixes.
    {
      scope: [
        'comment',
        'comment.line',
        'comment.block',
        'comment.block.documentation',
        'punctuation.definition.comment',
        'string.comment',
      ],
      settings: { foreground: c.comment, fontStyle: 'italic' },
    },
  ];
}

/**
 * Content-derived hash used in the theme `name`. Shiki's singleton highlighter
 * caches themes by name — without a changing suffix, editing the palette has
 * no effect in a long-lived session because the old registration keeps being
 * reused. Hashing the palette object keeps the cache honest across HMR and
 * between releases.
 */
function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

const lightTokens = buildTokens(light);
const darkTokens = buildTokens(dark);
const lightHash = hash(JSON.stringify([light, lightTokens]));
const darkHash = hash(JSON.stringify([dark, darkTokens]));

export const nousLight: ThemeRegistration = {
  name: `nous-light-${lightHash}`,
  type: 'light',
  colors: {
    'editor.background': light.bg,
    'editor.foreground': light.fg,
  },
  tokenColors: lightTokens,
};

export const nousDark: ThemeRegistration = {
  name: `nous-dark-${darkHash}`,
  type: 'dark',
  colors: {
    'editor.background': dark.bg,
    'editor.foreground': dark.fg,
  },
  tokenColors: darkTokens,
};
