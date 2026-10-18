const KEY = 'optimat.portal.token';
let token: string | null = null;
export function getPortalToken() { return token; }
export function restorePortalToken() {
  try { token = sessionStorage.getItem(KEY); } catch { token = null; }
  return token;
}
export function setPortalToken(value: string | null) {
  token = value;
  try {
    if (value) sessionStorage.setItem(KEY, value);
    else sessionStorage.removeItem(KEY);
  } catch { /* Private browsing can disable storage; memory sessions still work. */ }
}
