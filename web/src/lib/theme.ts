export type Theme = "dark" | "light";

const KEY = "bluesand.theme";

/** Runs in <head> before first paint so a saved light theme never flashes dark. */
export const THEME_BOOT_SCRIPT = `try{var t=localStorage.getItem("${KEY}");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}try{var q=new URLSearchParams(location.search);if(q.get("print")==="1"){document.documentElement.dataset.print="1";var pt=q.get("theme");if(pt==="light"||pt==="dark")document.documentElement.dataset.theme=pt}}catch(e){}`;

export function readTheme(): Theme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // private mode / blocked storage: the choice just won't persist
  }
}
