import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import AppShell from "@/components/AppShell";
import ServiceWorkerRegister from "@/components/ServiceWorkerRegister";
import BuildVersionWatcher from "@/components/BuildVersionWatcher";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "F&B Controller - Restaurant Cost Management",
  description: "Comprehensive food and beverage cost management system for restaurants",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    title: "FNB Ctrl",
    statusBarStyle: "default",
  },
  icons: {
    icon: [
      { url: "/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icon-192.png",   sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png",   sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
  formatDetection: { telephone: false },
};

// Tells the browser to colour the URL bar (Android) and status bar (iOS) to match the brand.
export const viewport: Viewport = {
  themeColor: "#af4408",
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${inter.className} h-full antialiased`}>
      <body className="min-h-full bg-bg text-text">
        <ServiceWorkerRegister />
        {/* Detects post-deploy stale-bundle state and auto-reloads. Prevents
            the "Failed to find Server Action" / Safari "This page couldn't load"
            error class entirely. */}
        <BuildVersionWatcher />
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
