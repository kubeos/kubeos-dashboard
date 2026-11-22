/**
 * KubeOS branding plugin for Headlamp.
 *
 * Two visible surfaces are covered here -- the theme and the logo -- plus the
 * document title and favicon, which the theme API cannot reach.
 */
import {
  AppLogoProps,
  registerAppLogo,
  registerAppTheme,
} from "@kinvolk/headlamp-plugin/lib";
import { FAVICON, MARK, WORDMARK } from "./assets";
import { BRAND, PRODUCT_NAME } from "./brand";
// Disks is imported FIRST of the KubeOS pages: Headlamp appends plugin entries after its own, and the
// order of these imports is the order they appear. It used to be moved into position with DOM surgery,
// which broke other groups' child lists (see the note in disks.tsx).
import "./disks";
// The "Add node" page: join further machines to this cluster from the dashboard.
// Imported for its side effect -- it registers its own route and sidebar entry.
import "./addnode";
// The "Helm" section: the releases on this node and the operations on them (install,
// upgrade, rollback, uninstall). It runs helm on the host through kubeos-console.service,
// so no button creates a Pod.
import "./helm";
// The "NFS" page: attaches an existing NFS export as a PersistentVolume. It
// registers itself INSIDE Headlamp's Storage section (sidebar parent 'storage'),
// because that is where a user looks for storage.
import "./nfs";
// Restart / Power off / Shell buttons in the top bar. Imported for its side
// effect: it calls registerAppBarAction. They act on the NODE, so they belong in
// the header rather than on a resource page.
import "./nodeactions";
// The node health card on the Node page: systemd, disks and versions, read from the host.
import "./nodehealth";
// The etcd snapshots page: take/list/download backups through the node's own console.
import "./snapshots";
// The "Rebalance" page: move pods off over-full nodes onto the ones with room.
// Kubernetes never moves a running pod by itself, so this is a deliberate action.
import "./rebalance";
import { kubeosTheme } from "./theme";

/**
 * Logo metrics. The mark and the wordmark are separate images on purpose: the
 * collapsed sidebar has roughly 32px of width and can only carry the mark,
 * while the expanded one shows mark + wordmark side by side.
 */
const SMALL_HEIGHT = 26;
const LARGE = { mark: 24, gap: 9, wordmark: 15 } as const;

function KubeOSLogo({ logoType = "large", className }: AppLogoProps) {
  if (logoType === "small") {
    return (
      <img
        src={MARK}
        alt={PRODUCT_NAME}
        className={className}
        style={{ height: SMALL_HEIGHT, width: "auto", display: "block" }}
      />
    );
  }

  return (
    <span
      className={className}
      style={{ display: "inline-flex", alignItems: "center" }}
    >
      <img
        src={MARK}
        alt=""
        aria-hidden="true"
        style={{ height: LARGE.mark, width: "auto", display: "block" }}
      />
      <img
        src={WORDMARK}
        alt={PRODUCT_NAME}
        style={{
          height: LARGE.wordmark,
          width: "auto",
          display: "block",
          marginLeft: LARGE.gap,
        }}
      />
    </span>
  );
}

/**
 * Headlamp's RouteSwitcher rebuilds document.title as
 * `[cluster, page, productName].join(' - ')` on every navigation, so one
 * assignment is not enough -- the title element has to be watched.
 *
 * `productName` itself comes from a build-time env var
 * (REACT_APP_HEADLAMP_PRODUCT_NAME), which only a frontend rebuild can change.
 * We deliberately do not rebuild the frontend (it is the vendored upstream bundle), so the
 * DOM is the only lever a plugin has. Cost of that choice: the About/version
 * strings still say Headlamp.
 */
function brandDocument() {
  const rewrite = () => {
    const next = document.title.replace(/Headlamp/g, PRODUCT_NAME);
    if (next !== document.title) {
      document.title = next;
    }
  };

  rewrite();

  const title = document.querySelector("title");
  if (title) {
    // Terminates on its own: once the title says KubeOS, replace() is a no-op
    // and no further mutation is queued.
    new MutationObserver(rewrite).observe(title, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  }

  applyLinkColour();
  applyChartColour();

  const icons = document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]');
  if (icons.length === 0) {
    const link = document.createElement("link");
    link.rel = "icon";
    document.head.appendChild(link);
    link.type = "image/png";
    link.href = FAVICON;
  }
  icons.forEach((link) => {
    link.type = "image/png";
    link.href = FAVICON;
  });
}

/**
 * Headlamp keeps the user's theme choice in localStorage under this key and has
 * no API for "this theme is the product default": registerAppTheme() only makes
 * the theme *available*, so a fresh browser lands on Light.
 *
 * Seeding the preference once, and only when nothing is stored, gives the
 * appliance its own look out of the box while still letting a user pick Light
 * or Dark later -- that choice is a real value in this key and is never touched
 * again.
 */
const THEME_PREFERENCE_KEY = "headlampThemePreference";
const SEEDED_FLAG = "kubeosThemeSeeded";

function defaultToKubeOSTheme() {
  let seeded = false;

  try {
    if (localStorage.getItem(THEME_PREFERENCE_KEY) === null) {
      localStorage.setItem(THEME_PREFERENCE_KEY, kubeosTheme.name);
      seeded = true;
    }
  } catch {
    // Private mode / storage disabled: the theme stays one click away in Settings.
    return;
  }

  if (!seeded) {
    return;
  }

  // Headlamp resolves the theme once, before plugin code runs, so a seeded
  // preference only takes effect on the next boot. Reload once, on the very
  // first visit, and mark the tab first so this can never loop -- even if the
  // localStorage write silently failed.
  try {
    if (sessionStorage.getItem(SEEDED_FLAG) === null) {
      sessionStorage.setItem(SEEDED_FLAG, "1");
      location.reload();
    }
  } catch {
    // No session storage, no reload: first paint stays Light, next visit is KubeOS.
  }
}

defaultToKubeOSTheme();

/**
 * Headlamp hardcodes the link colour for dark themes (#6CB6F2) inside
 * createMuiTheme, which overrides whatever AppTheme.link.color says -- so a
 * KubeOS theme still renders pod names, namespaces and IPs in blue.
 *
 * A stylesheet rule is the only lever a plugin has here. !important is required
 * because MUI injects its own emotion styles ahead of ours.
 */
const LINK_OVERRIDE_ID = "kubeos-branding-links";

function applyLinkColour() {
  if (document.getElementById(LINK_OVERRIDE_ID)) {
    return;
  }
  const style = document.createElement("style");
  style.id = LINK_OVERRIDE_ID;
  style.textContent = `
    .MuiLink-root { color: ${BRAND.lime.light} !important; }
    .MuiLink-root:hover { color: ${BRAND.lime.primary} !important; }
  `;
  document.head.appendChild(style);
}

/**
 * The Overview gauges are recharts donuts whose "healthy" slice is painted with
 * theme.palette.success.main -- MUI green[50], a pale mint unrelated to KubeOS.
 * `success` is not a field of AppTheme, so registerAppTheme cannot reach it and
 * the SVG fill attribute is the only lever a plugin has.
 *
 * Matching on the fill the app actually painted keeps the rule honest. The
 * "not ready" (error) and "degraded" (warning) slices keep their own colours,
 * so losing a pod still reads as red instead of turning lime. If a future
 * Headlamp changes these fills, the selector stops matching and the gauges fall
 * back to Headlamp's own colours: no breakage, and never a wrong colour.
 */
const CHART_OVERRIDE_ID = "kubeos-branding-charts";

/**
 * The only two fills Headlamp uses for "the thing being measured":
 * `success.main` on the Ready/Not Ready rings and `chartStyles.fillColor` on the
 * CPU and memory usage rings. Everything semantic is deliberately absent -- error
 * red, warning amber, the grey-ish "total" slice
 * (rgba(20, 20, 20, 0.1)) that is invisible on a dark background anyway.
 */
const HEADLAMP_MEASURE_FILLS = ["#e8f5e9", "#929191"];

function applyChartColour() {
  if (document.getElementById(CHART_OVERRIDE_ID)) {
    return;
  }
  const style = document.createElement("style");
  style.id = CHART_OVERRIDE_ID;
  // A presentation attribute loses to any stylesheet rule, so no !important is
  // needed here -- unlike the link colour, which fights MUI's emotion styles.
  style.textContent = HEADLAMP_MEASURE_FILLS.map(
    (fill) =>
      `.recharts-pie .recharts-sector[fill="${fill}" i] { fill: ${BRAND.lime.primary}; }`
  ).join("\n");
  document.head.appendChild(style);
}

registerAppLogo(KubeOSLogo);
registerAppTheme(kubeosTheme);

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", brandDocument);
} else {
  brandDocument();
}
