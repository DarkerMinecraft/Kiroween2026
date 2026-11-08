import type { Metadata } from "next";
import { Geist, Geist_Mono, Inter } from "next/font/google";
import "./globals.css";
import { cn } from "@/lib/utils";
import { Toaster } from "@/components/ui/sonner";

const inter = Inter({subsets:['latin'],variable:'--font-sans'});

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Kiroween2026",
  description: "Next.js + Tailwind + shadcn/ui + Prisma + Better Auth",
};

/**
 * Root layout applied to every route.
 *
 * Sets up the document shell, loads the Geist and Inter fonts as CSS
 * variables, and mounts the global Sonner toaster. Next.js requires the root
 * layout to be the file's default export.
 */
const RootLayout = ({ children }: LayoutProps<"/">) => {
  return (
    <html
      lang="en"
      className={cn("h-full", "antialiased", geistSans.variable, geistMono.variable, "font-sans", inter.variable)}
    >
      <body className="min-h-full flex flex-col">
        {children}
        <Toaster />
      </body>
    </html>
  );
};

export default RootLayout;
