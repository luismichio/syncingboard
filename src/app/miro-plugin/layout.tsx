import Script from 'next/script';

export default function MiroPluginLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <>
      <Script
        src="https://miro.com/app/static/sdk/v2/miro.js"
        strategy="afterInteractive"
      />
      {children}
    </>
  );
}
