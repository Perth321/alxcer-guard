// screenshare.js — screen share feature has been removed.
// All exports are stubs so that agent.js import continues to work without crashing.
const _disabled = async () => ({ error: "Screen share feature removed" });
export const isActive = () => false;
export const getStatus = () => ({ active: false });
export const startScreenShare  = _disabled;
export const stopScreenShare   = _disabled;
export const navigateTo        = _disabled;
export const typeText          = _disabled;
export const clickAt           = _disabled;
export const scrollPage        = _disabled;
export const zoomBrowser       = _disabled;
export const resetZoom         = _disabled;
export const findInPage        = _disabled;
export const pressKey          = _disabled;
export const snapshotNow       = _disabled;
export const clickElement      = _disabled;
export const scrollToElement   = _disabled;
export const zoomToElement     = _disabled;
export const highlightElements = _disabled;
export const evalOnPage        = _disabled;
