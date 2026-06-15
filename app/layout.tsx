import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "GHOST Agent Builder",
  description: "GHOST Agent Builder — self-learning AI dev agent with memory, skills, projects and approval flow",
  icons: {
    icon: "/ghost-icon.png",
    apple: "/ghost-icon.png"
  }
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
