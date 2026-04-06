import { useState, useSyncExternalStore } from 'react';

const MOBILE_BREAKPOINT = 767;
const query = `(max-width: ${MOBILE_BREAKPOINT}px)`;
let mediaQuery: MediaQueryList | null = null;

function getMediaQuery() {
  if (!mediaQuery) {
    mediaQuery = window.matchMedia(query);
  }
  return mediaQuery;
}

function subscribe(callback: () => void) {
  const mq = getMediaQuery();
  mq.addEventListener('change', callback);
  return () => mq.removeEventListener('change', callback);
}

function getSnapshot() {
  return getMediaQuery().matches;
}

/**
 * Returns true when the viewport is at or below mobile breakpoint (767px).
 * Uses a singleton MediaQueryList for efficient re-renders.
 */
export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** Raw check without React hook — for use in store actions */
export function isMobileViewport(): boolean {
  return window.matchMedia(query).matches;
}

/** Detect real mobile device via user-agent (not just viewport width) */
export function isRealMobileDevice(): boolean {
  const uaMatchesMobile =
    /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Windows Phone|Mobi/i.test(
      navigator.userAgent
    );

  // Modern API: navigator.userAgentData.mobile.
  // Some desktop browsers in mobile emulation keep this false while overriding
  // navigator.userAgent to a mobile UA, so a positive match from either signal
  // should classify as mobile.
  const nav = navigator as Navigator & { userAgentData?: { mobile?: boolean } };
  if (nav.userAgentData?.mobile === true) {
    return true;
  }

  return uaMatchesMobile;
}

/** React hook version of isRealMobileDevice — stable, no re-renders on resize */
export function useIsRealMobile(): boolean {
  // Device type doesn't change during session, so compute once
  const [isReal] = useState(() => isRealMobileDevice());
  return isReal;
}
