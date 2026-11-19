import './globals.css';

export const metadata = {
  title: 'KC Tech Radio — Kansas City Tech, Business & AI News, 24/7',
  description:
    'A deterministic, template-driven streaming radio station: Kansas City tech and business news, AI headlines, and world news at the top of every hour.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
