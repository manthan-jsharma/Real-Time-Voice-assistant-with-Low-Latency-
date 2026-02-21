import "./globals.css";

export const metadata = {
  title: "Real-Time Voice AI",
  description: "Open-source STT and TTS streaming prototype",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-gray-900 text-white">{children}</body>
    </html>
  );
}
