import type { Metadata } from "next";
import Providers from "@/components/Providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "BlueprintParser",
  description: "AI-powered construction blueprint analysis",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('bp-theme');var s=localStorage.getItem('bp-ui-scale');if(t)document.documentElement.setAttribute('data-theme',t);if(s)document.documentElement.setAttribute('data-ui-scale',s)}catch(e){}})()`,
          }}
        />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
