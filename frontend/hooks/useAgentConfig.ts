// frontend/hooks/useAgentConfig.ts
import { useReadContract, useWriteContract } from 'wagmi';
import { AGENT_REGISTRY_ADDRESS, AGENT_REGISTRY_ABI } from '@/lib/contracts';
import { useAccount } from 'wagmi';

export const useAgentConfig = () => {
  const { address } = useAccount();

  const { data, isError, isLoading, refetch } = useReadContract({
    address: AGENT_REGISTRY_ADDRESS as `0x${string}`,
    abi: AGENT_REGISTRY_ABI,
    functionName: 'getAgentConfig',
    args: address ? [address] : undefined,
    query: {
      enabled: !!address,
      refetchInterval: 30000,
    },
  });

  const { writeContract, isPending, isSuccess } = useWriteContract();

  const updateConfig = (minHealthFactor: bigint, maxLTV: bigint, telegramId: string) => {
    writeContract({
      address: AGENT_REGISTRY_ADDRESS as `0x${string}`,
      abi: AGENT_REGISTRY_ABI,
      functionName: 'updateConfig',
      args: [minHealthFactor, maxLTV, telegramId],
    });
  };

  return {
    config: data,
    isLoading,
    isError,
    refetch,
    updateConfig,
    isUpdating: isPending,
    isUpdateSuccess: isSuccess,
  };
};