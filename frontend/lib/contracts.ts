// frontend/lib/contracts.ts
export const AAVE_ADAPTER_ADDRESS = process.env.NEXT_PUBLIC_AAVE_ADAPTER_ADDRESS || '0x0000000000000000000000000000000000000000';
export const AGENT_REGISTRY_ADDRESS = process.env.NEXT_PUBLIC_AGENT_REGISTRY_ADDRESS || '0x0000000000000000000000000000000000000000';

export const AAVE_ADAPTER_ABI = [
  {
    inputs: [{ name: 'user', type: 'address' }],
    name: 'getUserPosition',
    outputs: [
      { name: 'totalCollateralBase', type: 'uint256' },
      { name: 'totalDebtBase', type: 'uint256' },
      { name: 'availableBorrowsBase', type: 'uint256' },
      { name: 'currentLiquidationThreshold', type: 'uint256' },
      { name: 'ltv', type: 'uint256' },
      { name: 'healthFactor', type: 'uint256' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { name: 'user', type: 'address' },
      { name: 'priceShockPercentage', type: 'int256' },
    ],
    name: 'simulateHFAfterPriceShock',
    outputs: [{ name: 'newHF', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

export const AGENT_REGISTRY_ABI = [
  {
    inputs: [{ name: 'user', type: 'address' }],
    name: 'getAgentConfig',
    outputs: [
      { name: 'minHealthFactor', type: 'uint256' },
      { name: 'maxLTV', type: 'uint256' },
      { name: 'telegramId', type: 'string' },
      { name: 'isActive', type: 'bool' },
      { name: 'autoRepay', type: 'bool' },
      { name: 'autoBorrow', type: 'bool' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { name: 'minHealthFactor', type: 'uint256' },
      { name: 'maxLTV', type: 'uint256' },
      { name: 'telegramId', type: 'string' },
    ],
    name: 'updateConfig',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;