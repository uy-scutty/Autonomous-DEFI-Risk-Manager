// frontend/hooks/useAgentHealth.ts
import { useQuery } from '@tanstack/react-query';
import axios from 'axios';

export const useAgentHealth = () => {
  return useQuery({
    queryKey: ['agent-health'],
    queryFn: async () => {
      const response = await axios.get(`${process.env.NEXT_PUBLIC_AGENT_SERVER_URL}/health`);
      return response.data;
    },
    refetchInterval: 10000,
    retry: 3,
    staleTime: 5000,
  });
};