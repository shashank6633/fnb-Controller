import type { Metadata, Viewport } from 'next';

/**
 * Captain app — a mobile-first, touch-first shell for restaurant captains on
 * phones/tablets. Renders full-screen (no desktop sidebar; see AppShell `bare`).
 * Backed entirely by the existing FNB Controller dine-in APIs.
 *
 * Installable as its OWN home-screen app: this layout overrides the site
 * manifest with /captain.webmanifest (id "/captain", own icon). The app is now
 * shared by ALL staff, so its start_url is "/launch" — the role-aware entry
 * (see src/app/launch/page.tsx / homePathFor) that routes each user to their
 * home (captains → here, GREs → recovery, managers → dashboard).
 */
export const metadata: Metadata = {
  title: 'AKAN Captain',
  manifest: '/captain.webmanifest',
  appleWebApp: { capable: true, title: 'Captain', statusBarStyle: 'black-translucent' },
  icons: { apple: [{ url: '/captain-apple-touch.png', sizes: '180x180' }] },
};

// Lock zoom for a native-feeling touch POS (root layout allows 5× — captain doesn't).
export const viewport: Viewport = {
  themeColor: '#1C0F05',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

import CaptainShell from './CaptainShell';

export default function CaptainLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#FBF6F0] text-[#2D1B0E] select-none">
      <CaptainShell>{children}</CaptainShell>
    </div>
  );
}
