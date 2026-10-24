import type { Metadata, Viewport } from "next"
import { Bricolage_Grotesque, Geist, Geist_Mono } from "next/font/google"
import { ThemeProvider } from "@/components/theme"
import "./globals.css"

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] })
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] })
const display = Bricolage_Grotesque({ variable: "--font-display", subsets: ["latin"], axes: ["opsz", "wdth"] })

// Set NEXT_PUBLIC_SITE_URL to the production domain; the fallback keeps local builds valid.
const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"
const description = "A software factory for one person: a board in your terminal that runs orc."

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: { default: "Luna TUI", template: "%s · Luna TUI" },
  description,
  applicationName: "Luna TUI",
  openGraph: { type: "website", siteName: "Luna TUI", title: "Luna TUI", description, url: "/" },
  twitter: { card: "summary_large_image", title: "Luna TUI", description },
  alternates: { canonical: "/" },
}

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#eff1f5" },
    { media: "(prefers-color-scheme: dark)", color: "#1e1e2e" },
  ],
}

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" suppressHydrationWarning className={`${geistSans.variable} ${geistMono.variable} ${display.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  )
}
