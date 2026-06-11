import { supabase } from './supabase';

export const callClaude = async (payload: {
  model: string;
  max_tokens: number;
  system: string;
  messages: any[];
}) => {
  const { data, error } = await supabase.functions.invoke('claude-proxy', {
    body: payload,
  });

  if (error) throw new Error(error.message);
  if (data.error) throw new Error(data.error.message ?? 'Claude API error');

  return data;
};
