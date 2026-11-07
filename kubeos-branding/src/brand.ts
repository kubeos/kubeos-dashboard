/**
 * KubeOS brand tokens.
 *
 * Every value here is copied from the KubeOS platform tree. None is invented, and
 * none should be "tidied up" here -- if the platform palette changes, this file
 * changes with it. Provenance for each value is in the comment beside it.
 */
export const BRAND = {
  /** Lime ramp, light -> primary -> deep. KubeOS HANDOFF.md, brand palette. */
  lime: {
    light: '#DBFF7A',
    primary: '#A3F000',
    deep: '#63C400',
  },
  /** The accent glow used on the splash and lockup artwork. */
  glow: '#96FF28',

  bg: {
    /** Page background. GRUB desktop-color and plymouth backdrop. */
    base: '#050B05',
    /** Panels, navbar, popups. Console "panel background" index. */
    panel: '#0B140B',
    /**
     * DERIVED, not from the platform tree: one step up from `panel` so that
     * muted surfaces (table stripes, disabled rows) stay distinguishable from
     * cards. Flagged for review -- replace if KubeOS defines one.
     */
    muted: '#0F180F',
  },

  text: {
    /** Body text. KubeOS console palette, index 0. */
    body: '#E8F2DC',
    /** Emphasis / maximum contrast. Console palette, index 15. */
    emphasis: '#F4FFE8',
    /** Secondary text. Console palette, index 8 (dark grey). */
    muted: '#6E7D64',
  },

  /** Button corner radius. Not from the platform tree; matches the 6px GTK radius. */
  radius: 6,
} as const;

/**
 * Page title and short name used wherever the product introduces itself.
 */
export const PRODUCT_NAME = 'KubeOS';
