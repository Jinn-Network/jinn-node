import { createClient, SupabaseClient } from '@supabase/supabase-js';
export { getCurrentJobContext, setJobContext, clearJobContext, type JobContext } from './context.js';
import { loadEnvOnce } from './env.js';

// Ensure env is loaded when supabase is referenced (idempotent)
loadEnvOnce();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

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

let client: any;

// Check for missing credentials
if (!supabaseUrl || !supabaseKey) {
  console.warn('Supabase URL or key missing or invalid. Supabase features will be disabled (using Mock client).');
  client = new MockSupabaseClient();
} else {
  try {
    client = createClient(supabaseUrl, supabaseKey);
  } catch (error) {
    console.warn('Failed to initialize Supabase client:', error);
    client = new MockSupabaseClient();
  }
}

export const supabase = client;
