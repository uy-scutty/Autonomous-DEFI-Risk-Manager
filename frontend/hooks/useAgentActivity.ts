// frontend/hooks/useAgentActivity.ts
import { useQuery } from '@tanstack/react-query';
import { useAccount } from 'wagmi';
import axios from 'axios';

export interface AgentActivity {
  id: string;
  type: 'REPAY' | 'BORROW' | 'WITHDRAW' | 'DEPOSIT' | 'WARNING' | 'ALERT';
  amount: string;
  asset: string;
  healthFactor: string;
  timestamp: number;
  txHash: string;
  status: 'SUCCESS' | 'PENDING' | 'FAILED';
}

export const useAgentActivity = () => {
  const { address } = useAccount();

  return useQuery({
    queryKey: ['agent-activity', address],
    queryFn: async () => {
      if (!address) return [];
      const response = await axios.get(`${process.env.NEXT_PUBLIC_AGENT_SERVER_URL}/api/activity/${address}`);
      return response.data as AgentActivity[];
    },
    enabled: !!address,
    refetchInterval: 15000,
    retry: 2,
  });
};