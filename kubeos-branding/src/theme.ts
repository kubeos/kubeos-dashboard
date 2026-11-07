/**
 * The KubeOS theme registered into Headlamp.
 *
 * Deliberately limited to the AppTheme fields that exist in
 * @kinvolk/headlamp-plugin 0.14.0 (the release paired with Headlamp v0.46.0).
 * 0.15.0-alpha adds `terminal` and `secondaryContrastText`, but shipping a
 * product against an alpha plugin is not worth an extra colour ramp: unknown
 * fields are ignored by the older runtime anyway, so nothing breaks by
 * staying inside the 0.14 surface.
 */
import { registerAppTheme } from "@kinvolk/headlamp-plugin/lib";
import { BRAND } from "./brand";

/** Whatever shape the installed plugin version expects -- no hard-coded copy of the type. */
type RegisteredTheme = Parameters<typeof registerAppTheme>[0];

export const kubeosTheme: RegisteredTheme = {
  name: "KubeOS",
  base: "dark",

  primary: BRAND.lime.primary,
  secondary: BRAND.glow,

  text: { primary: BRAND.text.body },
  link: { color: BRAND.lime.light },

  background: {
    default: BRAND.bg.base,
    surface: BRAND.bg.panel,
    muted: BRAND.bg.muted,
  },

  sidebar: {
    // Panel colour, not the page colour: with both at #050B05 the sidebar and
    // the content area are separated by a hairline and the app looks flat.
    background: BRAND.bg.panel,
    color: BRAND.text.body,
    // Selected row: solid lime with near-black text, the same inversion the
    // KubeOS installer uses for its highlighted rows.
    selectedBackground: BRAND.lime.primary,
    selectedColor: BRAND.bg.base,
    actionBackground: BRAND.bg.panel,
  },

  navbar: {
    background: BRAND.bg.panel,
    color: BRAND.text.body,
  },

  radius: BRAND.radius,
  buttonTextTransform: "none",
};
