import { createClient } from '@supabase/supabase-js';
export { getCurrentJobContext, setJobContext, clearJobContext, type JobContext } from './context.js';
import { getCredential } from '../../../shared/credential-client.js';

// Mock client for when Supabase is not configured or URL is invalid
class MockSupabaseClient {
  from(_table: string) {
    return new MockQueryBuilder();
  }
}

class MockQueryBuilder {
  select(_columns?: string) { return this; }
  insert(_values: any) { return this; }
  eq(_column: string, _value: any) { return this; }
  limit(_count: number) { return this; }
  range(_from: number, _to: number) { return this; }
  single() { return this; }

  // Make it thenable so it can be awaited
  then(resolve: (result: { data: any, error: any }) => void, _reject: any) {
    resolve({
      data: null,
      error: { message: 'Supabase is not configured or URL is invalid. Database operations are disabled.' }
    });
  }
}

let cachedClient: any = null;

/**
 * Get the Supabase client. Fetches the service role key from the credential
 * bridge on first call and caches the client for subsequent calls.
 */
export async function getSupabase(): Promise<any> {
  if (cachedClient) return cachedClient;

  const supabaseUrl = process.env.SUPABASE_URL;
  if (!supabaseUrl) {
    console.warn('SUPABASE_URL not set. Supabase features will be disabled (using Mock client).');
    cachedClient = new MockSupabaseClient();
    return cachedClient;
  }

  try {
    const serviceRoleKey = await getCredential('supabase');
    cachedClient = createClient(supabaseUrl, serviceRoleKey);
    return cachedClient;
  } catch (error) {
    console.warn('Failed to initialize Supabase client:', error);
    cachedClient = new MockSupabaseClient();
    return cachedClient;
  }
}
