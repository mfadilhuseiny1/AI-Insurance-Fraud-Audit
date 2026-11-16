import Link from "next/link";
import { Icon, type IconName } from "@/components/Icon";

const LINKS: { href: string; label: string; icon: IconName }[] = [
  { href: "/security-governance", label: "Overview", icon: "eye" },
  { href: "/security-governance/getting-started", label: "Getting started", icon: "play" },
  { href: "/security-governance/concepts", label: "Concepts", icon: "layers" },
  { href: "/security-governance/management", label: "Management", icon: "sliders" },
  { href: "/security-governance/third-party-applications", label: "Third-party apps", icon: "plug" },
  { href: "/security-governance/platform-security", label: "Platform security", icon: "database" },
  { href: "/security-governance/workspaces", label: "Governance apps", icon: "grid" },
];

export function SecuritySectionNav({ active }: { active: string }) {
  return (
    <div className="flex flex-wrap items-center gap-1 rounded-xl border border-line bg-panel p-1.5" aria-label="Security & Governance sections">
      {LINKS.map((item) => {
        const selected = item.label === active;
        return (
          <Link key={item.href} href={item.href} aria-current={selected ? "page" : undefined} className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium transition-colors ${selected ? "bg-ocean/15 text-ocean" : "text-muted hover:bg-panel-2 hover:text-white"}`}>
            <Icon name={item.icon} className="h-3.5 w-3.5" />{item.label}
          </Link>
        );
      })}
      <Link href="/apps" className="ml-auto inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs text-muted hover:bg-panel-2 hover:text-white"><Icon name="grid" className="h-3.5 w-3.5" />All apps</Link>
    </div>
  );
}
