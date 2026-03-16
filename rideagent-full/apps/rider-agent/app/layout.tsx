import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "RiderAgent — Autonomous Ride Requester",
  description: "Rider agent that requests rides and pays drivers via x402 micropayments",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
