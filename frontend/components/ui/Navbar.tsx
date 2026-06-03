// frontend/components/ui/Navbar.tsx
'use client';

import { ConnectButton } from '@rainbow-me/rainbowkit';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { motion } from 'framer-motion';

const navItems = [
  { path: '/dashboard', label: 'Dashboard', icon: '⊡' },
  { path: '/activity', label: 'Activity', icon: '⚡' },
  { path: '/settings', label: 'Settings', icon: '⚙' },
];

export const Navbar = () => {
  const pathname = usePathname();

  return (
    <nav className="bg-cyber-surface border-b border-cyber-border sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between h-16">
          <div className="flex items-center space-x-8">
            <Link href="/" className="flex items-center space-x-2">
              <motion.span 
                className="text-2xl font-heading font-bold cyber-glow-text"
                animate={{ opacity: [0.7, 1, 0.7] }}
                transition={{ duration: 3, repeat: Infinity }}
              >
                GUARDIAN
              </motion.span>
              <span className="text-xs font-mono text-cyber-muted bg-cyber-bg px-2 py-1 rounded">
                v2.0
              </span>
            </Link>
            
            <div className="hidden sm:flex space-x-1">
              {navItems.map((item) => (
                <Link
                  key={item.path}
                  href={item.path}
                  className={`px-4 py-2 rounded-lg font-medium transition-all duration-300 flex items-center space-x-2 ${
                    pathname === item.path
                      ? 'bg-cyber-cyan/10 text-cyber-cyan border border-cyber-cyan/30'
                      : 'text-cyber-muted hover:text-cyber-text hover:bg-cyber-bg'
                  }`}
                >
                  <span className="font-mono">{item.icon}</span>
                  <span className="text-sm">{item.label}</span>
                </Link>
              ))}
            </div>
          </div>

          <div className="flex items-center">
            <ConnectButton 
              showBalance={false}
              chainStatus="icon"
              accountStatus={{
                smallScreen: 'avatar',
                largeScreen: 'full',
              }}
            />
          </div>
        </div>
      </div>
    </nav>
  );
};