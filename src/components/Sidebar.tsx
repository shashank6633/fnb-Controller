"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { canAccessPage } from "@/lib/page-catalog";
import {
  LayoutDashboard,
  ShoppingCart,
  Package,
  ChefHat,
  Upload,
  BarChart3,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Menu,
  X,
  UtensilsCrossed,
  PartyPopper,
  Utensils,
  BookOpen,
  Link2,
  ClipboardList,
  Building2,
  FileText,
  Building,
  ListChecks,
  Users,
  ClipboardCheck,
  Store,
  ShieldAlert,
  AlertTriangle,
  History,
  Boxes,
  Warehouse,
  Scissors,
  Printer,
  Smartphone,
  Bell,
  QrCode,
  LayoutGrid,
  Timer,
  Download,
  ScanLine,
  Bot,
  GraduationCap,
  HelpCircle,
  type LucideIcon,
} from "lucide-react";

// ─── Nav structure ──────────────────────────────────────────────────────
// Either a flat link OR a collapsible section that wraps children. The
// Purchasing / Inventory / Production sections bundle all back-office store
// pages so the sidebar stays compact instead of one long flat list.
type NavLink    = { kind: "link"; label: string; href: string; icon: LucideIcon };
type NavSection = { kind: "section"; label: string; icon: LucideIcon; items: NavLink[] };
type NavEntry   = NavLink | NavSection;

const navTree: NavEntry[] = [
  { kind: "link", label: "Dashboard", href: "/", icon: LayoutDashboard },

  // Dine-In (à la carte) — recipe-based costing model.
  // Sales row → menu item → recipe → ingredients → cost.
  // Reconciliation page surfaces every break in that chain.
  {
    kind: "section",
    label: "Dine-In",
    icon: UtensilsCrossed,
    items: [
      { kind: "link", label: "Order Floor",        href: "/dine-in/floor",             icon: ShoppingCart },
      { kind: "link", label: "Customer Orders & Requests", href: "/dine-in/requests",  icon: Bell },
      { kind: "link", label: "Kitchen Display",    href: "/dine-in/kitchen",           icon: ChefHat },
      { kind: "link", label: "KOT & Bill Printers", href: "/dine-in/offline-print",    icon: Printer },
      { kind: "link", label: "Captain (Tablet)",   href: "/captain",                   icon: Smartphone },
      { kind: "link", label: "Print Agent",        href: "/print/agent",               icon: Printer },
      { kind: "link", label: "KOT Data Points",    href: "/dine-in/kot-analytics",     icon: BarChart3 },
      { kind: "link", label: "Captain Response Times", href: "/dine-in/captain-performance", icon: Timer },
      { kind: "link", label: "Tables",             href: "/dine-in/tables",            icon: Utensils },
      { kind: "link", label: "Menu Items",         href: "/menu-items",                icon: BookOpen },
      { kind: "link", label: "Recipes",            href: "/recipes",                   icon: ChefHat },
      { kind: "link", label: "Menu Engineering",   href: "/menu-engineering",          icon: BarChart3 },
      { kind: "link", label: "Direct Items",       href: "/direct-items",              icon: Link2 },
      { kind: "link", label: "Sales Upload",       href: "/sales",                     icon: Upload },
      { kind: "link", label: "Reconciliation",     href: "/dine-in/reconciliation",    icon: AlertTriangle },
      { kind: "link", label: "Reports",            href: "/reports?segment=DINE_IN",   icon: BarChart3 },
      { kind: "link", label: "Variance Report",    href: "/variance-report",           icon: ClipboardCheck },
    ],
  },

  // Parties — requisition-based costing model.
  // Each party event has a P&L: cost from issued materials, revenue from sales.
  {
    kind: "section",
    label: "Parties",
    icon: PartyPopper,
    items: [
      { kind: "link", label: "Party Events",                href: "/party-events",       icon: PartyPopper },
      { kind: "link", label: "Party Requisitions",          href: "/party-requisitions", icon: ListChecks },
      { kind: "link", label: "Party Approvals",             href: "/party-approvals",    icon: ChefHat },
      { kind: "link", label: "Food Consumption",            href: "/food-consumption",   icon: Utensils },
      { kind: "link", label: "Party Liquor Consumption",    href: "/party-pnl",          icon: PartyPopper },
      { kind: "link", label: "Party P&L",                   href: "/parties",            icon: BarChart3 },
      { kind: "link", label: "Reports",                     href: "/reports?segment=PARTY", icon: BarChart3 },
    ],
  },

  // Internal stock movements (dept-to-store requisitions) — different from
  // party requisitions; this is for routine kitchen restocking.
  { kind: "link", label: "Internal Requisitions", href: "/requisitions", icon: ListChecks },

  // Back-office store pages — shared infrastructure for both Dine-In + Parties,
  // split into Purchasing / Inventory / Production.
  {
    kind: "section",
    label: "Purchasing",
    icon: ShoppingCart,
    items: [
      { kind: "link", label: "Purchases",          href: "/purchases",          icon: ShoppingCart },
      { kind: "link", label: "Purchase Orders",    href: "/purchase-orders",    icon: ClipboardList },
      { kind: "link", label: "Goods Receipt (GRN)", href: "/grn",               icon: ClipboardList },
      { kind: "link", label: "Receiving Variance", href: "/receiving-variance", icon: AlertTriangle },
      { kind: "link", label: "Vendors",            href: "/vendors",            icon: Building2 },
      { kind: "link", label: "Vendor → Items",     href: "/vendors/materials",  icon: Building2 },
      { kind: "link", label: "Contracts",          href: "/contracts",          icon: FileText },
    ],
  },
  {
    kind: "section",
    label: "Inventory",
    icon: Boxes,
    items: [
      { kind: "link", label: "Raw Materials",      href: "/inventory",          icon: Package },
      { kind: "link", label: "Low Stock — Buy List", href: "/store-dashboard",  icon: AlertTriangle },
      { kind: "link", label: "Issue Requisitions", href: "/store-requisitions", icon: Package },
      { kind: "link", label: "Closing Stock",      href: "/closing-stock",      icon: ClipboardCheck },
      { kind: "link", label: "Daily Roll-up",      href: "/daily-rollup",       icon: ClipboardCheck },
      { kind: "link", label: "Wastage",            href: "/wastage",            icon: ClipboardCheck },
      { kind: "link", label: "Unit Audit",         href: "/unit-audit",         icon: ShieldAlert },
      { kind: "link", label: "Unit Registry",      href: "/units",              icon: ShieldAlert },
      { kind: "link", label: "Dept Materials (Party)", href: "/department-materials", icon: Warehouse },
    ],
  },
  {
    kind: "section",
    label: "Production",
    icon: ChefHat,
    items: [
      { kind: "link", label: "Kitchen Production", href: "/kitchen-production", icon: ChefHat },
      { kind: "link", label: "Production Dashboard", href: "/kitchen-production/dashboard", icon: LayoutGrid },
      { kind: "link", label: "Production Reports", href: "/kitchen-production/reports", icon: BarChart3 },
      { kind: "link", label: "Scan Batch",         href: "/kitchen-production/scan", icon: ScanLine },
      { kind: "link", label: "Butchering",         href: "/butchering",         icon: Scissors },
    ],
  },

  { kind: "link", label: "Dept Consumption", href: "/department-consumption", icon: BarChart3 },
  { kind: "link", label: "Staff Meals",      href: "/staff-meals",            icon: Utensils },

  // AKAN CRM — AI assistant / training / quizzes for Front Office & GRE staff.
  // Links only show for users granted the paths in page-catalog (AKAN CRM section).
  {
    kind: "section",
    label: "AKAN CRM",
    icon: Bot,
    items: [
      { kind: "link", label: "AI Assistant",     href: "/crm/assistant",  icon: Bot },
      { kind: "link", label: "AI Analyst",       href: "/crm/analyst",    icon: BarChart3 },
      { kind: "link", label: "Daily Digest",     href: "/crm/digest",     icon: FileText },
      { kind: "link", label: "Smart Reorder",    href: "/crm/reorder",    icon: ShoppingCart },
      { kind: "link", label: "Guests & Loyalty", href: "/crm/guests",     icon: Users },
      { kind: "link", label: "Training",         href: "/crm/training",   icon: GraduationCap },
      { kind: "link", label: "Quiz",             href: "/crm/quiz",       icon: HelpCircle },
      { kind: "link", label: "Guest Quiz Links", href: "/crm/quiz-links", icon: Link2 },
      { kind: "link", label: "CRM Settings",     href: "/crm/settings",   icon: ShieldAlert },
    ],
  },

  {
    kind: "section",
    label: "Settings",
    icon: ShieldAlert,
    items: [
      { kind: "link", label: "Departments",    href: "/departments",            icon: Building },
      { kind: "link", label: "Users",          href: "/users",                  icon: Users },
      { kind: "link", label: "Roles",          href: "/settings/roles",         icon: Users },
      { kind: "link", label: "Print Design",   href: "/settings/print-design",  icon: Printer },
      { kind: "link", label: "Categories",     href: "/settings/categories",    icon: Boxes },
      { kind: "link", label: "Page Access",    href: "/settings/page-access",   icon: ShieldAlert },
      { kind: "link", label: "Integrations",   href: "/settings/integrations",  icon: ShieldAlert },
      { kind: "link", label: "QR Standees",    href: "/settings/qr-standees",   icon: QrCode },
      { kind: "link", label: "Menu Design",    href: "/settings/customer-menu", icon: LayoutGrid },
      { kind: "link", label: "Outlets",        href: "/outlets",                icon: Store },
      { kind: "link", label: "Audit Log",      href: "/audit",                  icon: History },
      { kind: "link", label: "Data Hygiene",   href: "/admin/data-hygiene",     icon: ShieldAlert },
      { kind: "link", label: "Reset Data",     href: "/admin/reset",            icon: ShieldAlert },
    ],
  },
];

const SECTION_KEYS = navTree
  .filter((e): e is NavSection => e.kind === "section")
  .map(s => s.label);

export default function Sidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  // MobileTopBar dispatches 'fnb:open-sidebar' on hamburger tap. Listen here
  // so the floating hamburger button doesn't need to live inside this file
  // (cleaner separation — the top bar owns the visible mobile chrome).
  useEffect(() => {
    const onOpen = () => setMobileOpen(true);
    window.addEventListener('fnb:open-sidebar', onOpen);
    return () => window.removeEventListener('fnb:open-sidebar', onOpen);
  }, []);

  // Auto-close the mobile drawer whenever the route changes — without this,
  // tapping a nav link would leave the drawer covering the page on small
  // screens (visited links closed correctly via onClick, but back/forward
  // navigation didn't).
  useEffect(() => { setMobileOpen(false); }, [pathname]);

  // PWA install: capture the browser's install prompt so we can offer a visible
  // "Install app" button (the app already ships a full manifest + icons, but the
  // native install affordance is easy to miss). `installed` hides it once running
  // standalone. iOS Safari doesn't fire beforeinstallprompt — those users install
  // via Share → Add to Home Screen, so we simply don't show the button there.
  const [installEvt, setInstallEvt] = useState<any>(null);
  const [installed, setInstalled] = useState(false);
  useEffect(() => {
    const onPrompt = (e: Event) => { e.preventDefault(); setInstallEvt(e); };
    const onInstalled = () => { setInstallEvt(null); setInstalled(true); };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    try { if (window.matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone) setInstalled(true); } catch {}
    return () => { window.removeEventListener('beforeinstallprompt', onPrompt); window.removeEventListener('appinstalled', onInstalled); };
  }, []);
  const installApp = async () => { if (!installEvt) return; installEvt.prompt(); try { await installEvt.userChoice; } catch {} setInstallEvt(null); };

  // Current user — used to filter nav links by the per-user page_access map.
  const [me, setMe] = useState<{ role?: string; page_access?: string | null; is_head_chef?: boolean } | null>(null);
  useEffect(() => {
    fetch('/api/auth/me').then(r => r.json()).then(d => setMe(d?.user || null)).catch(() => {});
  }, []);

  // Filtered tree honouring page-level access. Null user → render nothing
  // (avoids a flash of all links before /me resolves). Admin / null-access
  // user sees everything via canAccessPage's defaults.
  const filteredNavTree = useMemo<NavEntry[]>(() => {
    if (!me) return navTree;   // optimistic — most users have full access
    return navTree
      .map(entry => {
        if (entry.kind === 'link') {
          return canAccessPage(entry.href, me) ? entry : null;
        }
        const allowed = entry.items.filter(i => canAccessPage(i.href, me));
        if (allowed.length === 0) return null;
        return { ...entry, items: allowed };
      })
      .filter((e): e is NavEntry => e !== null);
  }, [me]);
  // Per-section expand state, persisted to localStorage.
  const [openSections, setOpenSections] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(SECTION_KEYS.map(k => [k, true])) // default open
  );

  // Restore preferences once on mount.
  useEffect(() => {
    const savedCol = localStorage.getItem("fnb:sidebar:collapsed");
    setCollapsed(savedCol === "1");
    try {
      const savedSec = JSON.parse(localStorage.getItem("fnb:sidebar:sections") || "{}");
      if (savedSec && typeof savedSec === "object") {
        setOpenSections(prev => ({ ...prev, ...savedSec }));
      }
    } catch { /* ignore parse errors */ }
  }, []);

  useEffect(() => {
    localStorage.setItem("fnb:sidebar:collapsed", collapsed ? "1" : "0");
  }, [collapsed]);

  useEffect(() => {
    localStorage.setItem("fnb:sidebar:sections", JSON.stringify(openSections));
  }, [openSections]);

  const isActive = (href: string) => {
    if (href === "/") return pathname === "/";
    return pathname.startsWith(href);
  };

  // If the current route is inside a collapsed section, auto-expand that
  // section so the user can see where they are in context.
  useEffect(() => {
    for (const entry of filteredNavTree) {
      if (entry.kind !== "section") continue;
      if (entry.items.some(i => isActive(i.href)) && !openSections[entry.label]) {
        setOpenSections(prev => ({ ...prev, [entry.label]: true }));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  const toggleSection = (label: string) =>
    setOpenSections(prev => ({ ...prev, [label]: !prev[label] }));

  // ─── Render helpers ───
  const renderLink = (item: NavLink, indent = false) => {
    const Icon = item.icon;
    const active = isActive(item.href);
    return (
      <Link
        key={item.href}
        href={item.href}
        onClick={() => setMobileOpen(false)}
        className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors duration-150
          ${active
            ? "bg-[#af4408] text-white"
            : "text-[#E8D5C4] hover:bg-[#2E1A0C] hover:text-white"}
          ${collapsed ? "justify-center" : ""}
          ${indent && !collapsed ? "pl-9" : ""}`}
        title={collapsed ? item.label : undefined}
      >
        <Icon size={collapsed || indent ? 16 : 18} className="shrink-0" />
        {!collapsed && <span>{item.label}</span>}
      </Link>
    );
  };

  const renderSection = (section: NavSection) => {
    const Icon = section.icon;
    const open = openSections[section.label] !== false;
    const hasActive = section.items.some(i => isActive(i.href));

    // In collapsed mode, render the section's items inline (just icons) with
    // a small divider above so they don't blend with neighbouring sections.
    if (collapsed) {
      return (
        <div key={section.label} className="space-y-1">
          <div className="border-t border-[#3D2614] mx-2" title={section.label} />
          {section.items.map(i => renderLink(i, false))}
        </div>
      );
    }

    return (
      <div key={section.label} className="space-y-0.5">
        <button
          onClick={() => toggleSection(section.label)}
          className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-semibold transition-colors duration-150
            ${hasActive ? "text-white" : "text-[#E8D5C4] hover:bg-[#2E1A0C] hover:text-white"}`}
          aria-expanded={open}
        >
          <Icon size={18} className="shrink-0" />
          <span className="flex-1 text-left">{section.label}</span>
          <span className="text-[10px] opacity-60">({section.items.length})</span>
          <ChevronDown
            size={16}
            className={`shrink-0 transition-transform duration-150 ${open ? "" : "-rotate-90"}`}
          />
        </button>
        {open && (
          <div className="space-y-0.5">
            {section.items.map(i => renderLink(i, true))}
          </div>
        )}
      </div>
    );
  };

  const sidebarContent = (
    <div className="flex flex-col h-full">
      {/* Logo / Brand */}
      <div className="flex items-center gap-3 px-4 py-5 border-b border-[#3D2614]">
        <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-[#af4408] text-white shrink-0">
          <UtensilsCrossed size={20} />
        </div>
        {!collapsed && (
          <span className="text-lg font-semibold text-white whitespace-nowrap">
            F&B Controller
          </span>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
        {filteredNavTree.map(entry =>
          entry.kind === "section" ? renderSection(entry) : renderLink(entry)
        )}
      </nav>

      {/* Install app (PWA) — shown only when the browser offers to install and
          we're not already running standalone. Works in the mobile drawer too. */}
      {installEvt && !installed && (
        <div className="px-3 pt-3">
          <button
            onClick={installApp}
            title="Install F&B Controller as an app"
            className="flex items-center justify-center gap-2 w-full px-3 py-2 rounded-lg bg-[#af4408] text-white text-sm font-medium hover:bg-[#8a3506] transition-colors"
          >
            <Download size={16} />{!collapsed && <span>Install app</span>}
          </button>
        </div>
      )}

      {/* Collapse toggle (desktop only) */}
      <div className="hidden lg:block px-3 py-4 border-t border-[#3D2614]">
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="flex items-center justify-center w-full px-3 py-2 rounded-lg text-[#E8D5C4] hover:bg-[#2E1A0C] hover:text-white transition-colors duration-150"
        >
          {collapsed ? <ChevronRight size={20} /> : <ChevronLeft size={20} />}
          {!collapsed && (
            <span className="ml-3 text-sm font-medium">Collapse</span>
          )}
        </button>
      </div>
    </div>
  );

  return (
    <>
      {/* Mobile hamburger moved to <MobileTopBar /> — it's the canonical
          mobile chrome and dispatches the 'fnb:open-sidebar' event listened
          above. Keeping it here would double the hamburger on small screens. */}

      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Mobile sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 w-[260px] bg-[#1C0F05] border-r border-[#3D2614] transform transition-transform duration-300 ease-in-out lg:hidden ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <button
          onClick={() => setMobileOpen(false)}
          className="absolute top-4 right-4 text-[#E8D5C4] hover:text-white transition-colors"
          aria-label="Close menu"
        >
          <X size={20} />
        </button>
        {sidebarContent}
      </aside>

      {/* Desktop sidebar */}
      <aside
        className={`hidden lg:flex flex-col shrink-0 h-screen sticky top-0 bg-[#1C0F05] border-r border-[#3D2614] transition-[width] duration-300 ease-in-out ${
          collapsed ? "w-16" : "w-[260px]"
        }`}
      >
        {sidebarContent}
      </aside>
    </>
  );
}
