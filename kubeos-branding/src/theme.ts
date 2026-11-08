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
    // NOT the colour to put on the lime row -- that text comes from
    // getContrastText(selectedBackground) and is already near black. Headlamp
    // uses selectedColor only for a *nested* selected row (e.g. Nodes under
    // Clusters), where it paints both the label and a 4px marker bar on the
    // sidebar background and no fill at all. Parked on the panel colour, the
    // label measured 1.06:1 against that background and vanished, which is
    // exactly what a submenu selection must never do.
    selectedColor: BRAND.lime.primary,
    actionBackground: BRAND.bg.panel,
  },

  navbar: {
    background: BRAND.bg.panel,
    color: BRAND.text.body,
  },

  radius: BRAND.radius,
  buttonTextTransform: "none",
};
