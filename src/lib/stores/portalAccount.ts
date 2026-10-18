import { writable } from 'svelte/store';
import { fetchEdgeFunction, getApiBackend } from '$lib/supabase';
import { restorePortalToken, setPortalToken } from '$lib/portalToken';
import { clearProvider } from './providerSession';
export type Account = {
  id: string; username: string; display_name: string; role: 'super_admin' | 'provider';
  active: boolean; provider_ids?: number[]; created_at?: string;
};
export const portalAccount = writable<Account | null>(null);
export async function portalRequest<T>(path: string, method: 'GET' | 'POST' | 'PUT' = 'GET', body?: object): Promise<T> {
  if (getApiBackend() !== 'aws') throw new Error('Account management requires the AWS API backend.');
  const { data, error } = await fetchEdgeFunction<T>(`portal-auth/${path}`, { method, body });
  if (error) throw error;
  return data as T;
}
export function clearAccount() { setPortalToken(null); portalAccount.set(null); clearProvider(); }
export async function loadAccount() {
  const account = await portalRequest<Account>('me');
  portalAccount.set(account);
  return account;
}
export async function restoreAccount() {
  if (!restorePortalToken()) return;
  try { await loadAccount(); } catch { clearAccount(); }
}
export async function login(username: string, password: string) {
  clearAccount();
  const result = await portalRequest<{ token: string }>('login', 'POST', { username, password });
  setPortalToken(result.token);
  try { return await loadAccount(); } catch (error) { clearAccount(); throw error; }
}
export async function logout() {
  try { await portalRequest('logout', 'POST'); } finally { clearAccount(); }
}
