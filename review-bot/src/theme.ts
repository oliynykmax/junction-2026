// The saved theme choice, shared by the landing page and the review page.
// web/landing.ts stores it through @ui-sdk/core's createColorScheme. The
// pre-paint script applies it before first paint so there is no flash.
// landing/index.html is static, so tests/landing.test.ts asserts that its
// inline copy of PREPAINT_SCRIPT matches this one.

export const THEME_KEY = "bumble-color-scheme";

export const PREPAINT_SCRIPT = `try{var s=localStorage.getItem("${THEME_KEY}");if(s==="light"||s==="dark")document.documentElement.setAttribute("data-color-scheme",s);}catch(_){}`;
