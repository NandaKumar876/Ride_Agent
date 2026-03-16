import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "DriverAgent — Autonomous Ride Provider",
  description: "Driver agent that accepts rides and receives x402 micropayments",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
