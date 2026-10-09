import { useApi } from './useApi';

/** Company name for pages that have no other reason to call the API. */
export function useSite(): { companyName: string } {
  const { data } = useApi<{ companyName: string }>('/api/public/site');
  return { companyName: data?.companyName ?? 'Careers' };
}
