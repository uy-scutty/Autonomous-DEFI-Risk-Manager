// frontend/hooks/useAavePosition.ts
import { useReadContract } from 'wagmi';
import { AAVE_ADAPTER_ADDRESS, AAVE_ADAPTER_ABI } from '@/lib/contracts';
import { useAccount } from 'wagmi';

export const useAavePosition = () => {
  const { address } = useAccount();

  const { data, isError, isLoading, refetch } = useReadContract({
    address: AAVE_ADAPTER_ADDRESS as `0x${string}`,
    abi: AAVE_ADAPTER_ABI,
    functionName: 'getUserPosition',
    args: address ? [address] : undefined,
    query: {
      enabled: !!address,
      refetchInterval: 30000,
      retry: 3,
    },
  });

  return {
    position: data,
    isLoading,
    isError,
    refetch,
  };
};