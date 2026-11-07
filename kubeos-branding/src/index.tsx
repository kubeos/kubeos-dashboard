/**
 * KubeOS branding plugin for Headlamp.
 *
 * Two visible surfaces are covered here -- the theme and the logo -- plus the
 * document title and favicon, which the theme API cannot reach.
 */
import { AppLogoProps, registerAppLogo, registerAppTheme } from '@kinvolk/headlamp-plugin/lib';
import { FAVICON, MARK, WORDMARK } from './assets';
import { PRODUCT_NAME } from './brand';
import { kubeosTheme } from './theme';

/**
 * Logo metrics. The mark and the wordmark are separate images on purpose: the
 * collapsed sidebar has roughly 32px of width and can only carry the mark,
 * while the expanded one shows mark + wordmark side by side.
 */
const SMALL_HEIGHT = 26;
const LARGE = { mark: 24, gap: 9, wordmark: 15 } as const;

function KubeOSLogo({ logoType = 'large', className }: AppLogoProps) {
  if (logoType === 'small') {
    return (
      <img
        src={MARK}
        alt={PRODUCT_NAME}
        className={className}
        style={{ height: SMALL_HEIGHT, width: 'auto', display: 'block' }}
      />
    );
  }

  return (
    <span className={className} style={{ display: 'inline-flex', alignItems: 'center' }}>
      <img
        src={MARK}
        alt=""
        aria-hidden="true"
        style={{ height: LARGE.mark, width: 'auto', display: 'block' }}
      />
      <img
        src={WORDMARK}
        alt={PRODUCT_NAME}
        style={{
          height: LARGE.wordmark,
          width: 'auto',
          display: 'block',
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
 * We deliberately do not rebuild the frontend (see image/Dockerfile), so the
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

  const title = document.querySelector('title');
  if (title) {
    // Terminates on its own: once the title says KubeOS, replace() is a no-op
    // and no further mutation is queued.
    new MutationObserver(rewrite).observe(title, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  }

  const icons = document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]');
  if (icons.length === 0) {
    const link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
    link.type = 'image/png';
    link.href = FAVICON;
  }
  icons.forEach(link => {
    link.type = 'image/png';
    link.href = FAVICON;
  });
}

registerAppLogo(KubeOSLogo);
registerAppTheme(kubeosTheme);

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', brandDocument);
} else {
  brandDocument();
}
