import './globals.css';
import type { ReactNode } from 'react';

export const metadata = { title: 'FuelPrice Control', description: 'Pilotage des prix carburant en station' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
