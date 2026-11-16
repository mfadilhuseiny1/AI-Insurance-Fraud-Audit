"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useAuth } from "./AuthGate";
import { EmulationDialog } from "./auth/Emulation";
import { auth } from "@/lib/auth";
import { Icon, type IconName } from "./Icon";

/** dispatched by docked panels (AIP Assist) to fold the sidebar to its rail; AI JKN Audit has no sidebar to fold */
export const SIDEBAR_RAIL_EVENT = "bluesandai:sidebar-rail";

/** AI JKN Audit (2026-10-29): no left panel. AIP JKN's own top bar holds every tab and, at its right end, the account
 *  menu (UserMenu); the few other pages (Account settings, Users and markings, Platform Apps) get a thin bar with the
 *  way back to AIP JKN and the same menu. No logo for now ("gausah ada logo dulu"). */
export function Sidebar() {
  const path = usePathname();
  // pages widen their columns into the room a sidebar would take (globals.css: html[data-sidebar="rail"])
  useEffect(() => {
    document.documentElement.dataset.sidebar = "rail";
  }, []);
  // (/swarm-x, the AI Agent Swarm tutorial, draws AIP JKN's bar as well)
  if (path.startsWith("/aip-jkn") || path.startsWith("/swarm-x")) return null;
  return (
    <header data-app-sidebar className="flex h-10 shrink-0 items-center justify-between border-b border-black/40 bg-[#111418] px-3 text-[12px] text-[#f6f7f9]">
      <Link href="/aip-jkn" className="flex items-center gap-1.5 rounded px-2 py-1 text-[#d3d8de] hover:bg-white/5 hover:text-white">
        <Icon name="left" className="h-3.5 w-3.5" />AIP JKN
      </Link>
      <UserMenu />
    </header>
  );
}

const AVATAR = "bg-gradient-to-br from-[#8b7cff] to-[#5b5fd6] font-semibold text-white";

/** The signed-in user as a round avatar; it opens Account settings, Users and markings (administrators), emulation
 *  mode and Sign out. An amber dot on the avatar while emulation mode is on. */
export function UserMenu() {
  const { me, enabled, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const [emulate, setEmulate] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  if (!enabled || !me) return null;
  const name = me.display_name || me.username;
  const role = me.role === "admin" ? "Administrator" : "User";
  const initials = name
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  const item = (icon: IconName, label: string) => (
    <>
      <Icon name={icon} className="h-3.5 w-3.5 text-[#abb3bf]" />
      {label}
    </>
  );
  const row = "flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-white/[.06]";
  return (
    <div className="relative ml-1 shrink-0" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        title={`${name} · ${role}`}
        aria-label="Account menu"
        aria-haspopup="menu"
        aria-expanded={open}
        className={`relative flex h-7 w-7 items-center justify-center rounded-full text-[11px] ring-2 shadow-[0_1px_8px_rgba(110,96,255,.35)] transition ${AVATAR} ${
          open ? "ring-white/40" : "ring-white/10 hover:ring-white/30"
        }`}
      >
        {initials}
        {me.emulation && <span title="Emulation mode" className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-[#fab219] ring-2 ring-[#111418]" />}
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-full z-[60] mt-2 w-64 overflow-hidden rounded-lg border border-white/10 bg-[#1c2127] text-[12.5px] text-[#e5e8eb] shadow-2xl">
          <div className="flex items-center gap-3 border-b border-white/[.06] px-3 py-3">
            <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm ${AVATAR}`}>{initials}</span>
            <span className="min-w-0">
              <span className="block truncate font-medium text-white">{name}</span>
              <span className="block truncate text-[11px] text-[#abb3bf]">
                {role}
                {me.organization ? ` · ${me.organization}` : ""}
              </span>
              {me.email && <span className="block truncate text-[11px] text-[#8f99a8]">{me.email}</span>}
            </span>
          </div>
          <div className="py-1">
            <Link href="/account" role="menuitem" onClick={() => setOpen(false)} className={row}>{item("sliders", "Account settings")}</Link>
            {me.role === "admin" && (
              <Link href="/control-panel?section=users" role="menuitem" onClick={() => setOpen(false)} className={row}>{item("project", "Users and markings")}</Link>
            )}
            {me.emulation ? (
              <button type="button" role="menuitem" onClick={() => auth.endEmulation().then(() => window.location.reload())} className={row}>
                {item("eye", "Exit emulation mode")}
              </button>
            ) : (
              <button type="button" role="menuitem" onClick={() => (setOpen(false), setEmulate(true))} className={row}>
                {item("eye", "Enable emulation mode")}
              </button>
            )}
          </div>
          <div className="border-t border-white/[.06] py-1">
            <button type="button" role="menuitem" onClick={signOut} className={`${row} text-[#ff8a8a]`}>
              <Icon name="left" className="h-3.5 w-3.5" />Sign out
            </button>
          </div>
        </div>
      )}
      {emulate && <EmulationDialog me={me} onClose={() => setEmulate(false)} onDone={() => window.location.reload()} />}
    </div>
  );
}
