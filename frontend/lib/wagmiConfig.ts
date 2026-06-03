// // frontend/lib/wagmiConfig.ts
// import { getDefaultWallets } from '@rainbow-me/rainbowkit';
// import { createConfig, http } from 'wagmi';
// import { arbitrum } from 'wagmi/chains';

// const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || '';

// const { connectors } = getDefaultWallets({
//   appName: 'Aave Guardian',
//   projectId,
// });

// export const config = createConfig({
//   chains: [arbitrum],
//   connectors,
//   transports: {
//     [arbitrum.id]: http(),
//   },
// });

import { createConfig, http } from 'wagmi'
import { arbitrum } from 'wagmi/chains'

export const config = createConfig({
  chains: [arbitrum],
  transports: {
    [arbitrum.id]: http(),
  },
})
