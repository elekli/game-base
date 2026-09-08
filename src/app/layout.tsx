import type { Metadata } from "next";
import type { ReactNode } from "react";
import { NavigationGuardClient } from "./navigation-guard-client";
import "./globals.css";

export const metadata: Metadata = {
  title: "Puizeru Gamebase",
  description: "私人遊戲收藏資料庫",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="zh-Hant">
      <body><NavigationGuardClient />{children}</body>
    </html>
  );
}
