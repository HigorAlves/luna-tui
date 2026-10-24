import type { Metadata, Viewport } from "next"
import { Geist, Geist_Mono } from "next/font/google"
import "./globals.css"

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] })
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] })

// Set NEXT_PUBLIC_SITE_URL to the production domain; the fallback keeps local builds valid.
const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"
const description = "A software factory for one person: a board in your terminal that runs orc. You keep the final say."

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
  colorScheme: "dark",
  themeColor: "#08090a",
}

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`dark ${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  )
}
