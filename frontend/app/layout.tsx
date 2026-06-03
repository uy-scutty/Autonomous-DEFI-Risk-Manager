// // frontend/app/layout.tsx
// import type { Metadata } from 'next';
// import { Providers } from './provider'; 
// import { Navbar } from '@/components/ui/Navbar';
// // import './globals.css';

// export const metadata: Metadata = {
//   title: 'Aave Guardian | Autonomous Risk Manager',
//   description: 'AI-powered Aave V3 position guardian agent on Arbitrum',
// };

// export default function RootLayout({
//   children,
// }: {
//   children: React.ReactNode;
// }) {
//   return (
//     <html lang="en" className="dark">
//       <body className="bg-cyber-bg min-h-screen">
//         <Providers>
//           <div className="relative min-h-screen">
//             {/* Scan line effect */}
//             <div className="fixed inset-0 pointer-events-none z-50">
//               <div className="absolute inset-0 animate-scan-line opacity-5 bg-gradient-to-b from-transparent via-cyber-cyan to-transparent" />
//             </div>
            
//             <Navbar />
//             <main className="relative z-10">
//               {children}
//             </main>
//           </div>
//         </Providers>
//       </body>
//     </html>
//   );
// }

import type { Metadata } from 'next';

import { Providers } from './providers';
import './globals.css';

export const metadata: Metadata = {
  title: 'Aave Guardian',
  description: 'Test',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}