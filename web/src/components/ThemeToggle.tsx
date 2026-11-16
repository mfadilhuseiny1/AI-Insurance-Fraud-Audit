"use client";

import { useEffect, useState } from "react";
import { applyTheme, readTheme, type Theme } from "@/lib/theme";
import { Icon } from "./Icon";

/** Dark / Light segmented switch; the choice is remembered in this browser. */
export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const [theme, setTheme] = useState<Theme>("dark");
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read the theme the boot script applied
    setTheme(readTheme());
  }, []);

  const pick = (t: Theme) => {
    applyTheme(t);
    setTheme(t);
  };

  if (compact) {
    // the collapsed sidebar: one button switching to the other theme
    const next: Theme = theme === "dark" ? "light" : "dark";
    return (
      <button type="button" onClick={() => pick(next)} title={`Switch to the ${next} theme`} aria-label={`Switch to the ${next} theme`}
        className="flex h-10 w-10 items-center justify-center rounded-lg text-muted hover:bg-panel-2 hover:text-white">
        <Icon name={theme === "dark" ? "moon" : "sun"} className="h-4 w-4" />
      </button>
    );
  }

  return (
    <div role="radiogroup" aria-label="Color theme" className="grid grid-cols-2 gap-1 rounded-lg border border-line bg-panel-2 p-1 text-xs">
      {(["dark", "light"] as const).map((t) => (
        <button
          key={t}
          type="button"
          role="radio"
          aria-checked={theme === t}
          onClick={() => pick(t)}
          className={`flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 transition-colors ${
            theme === t ? "bg-panel font-medium text-white shadow-sm ring-1 ring-line-2" : "text-muted hover:text-white"
          }`}
        >
          <Icon name={t === "dark" ? "moon" : "sun"} className="h-3.5 w-3.5" />
          {t === "dark" ? "Dark" : "Light"}
        </button>
      ))}
    </div>
  );
}
