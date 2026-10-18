<script lang="ts">
  import { onMount } from 'svelte';
  import { push } from 'svelte-spa-router';
  import PageShell from '$lib/components/PageShell.svelte';
  import { providerPortalNavItems } from '$lib/providerPortalNav';
  import { portalAccount, portalRequest, login, logout, clearAccount } from '$lib/stores/portalAccount';
  import { setProvider } from '$lib/stores/providerSession';
  import type { Provider } from '$lib/api';
  let username = '', password = '', currentPassword = '', newPassword = '', confirmPassword = '';
  let providers: Provider[] = [];
  let busy = false, error = '', notice = '', selected = '';
  async function loadProviders() {
    providers = [];
    if ($portalAccount) providers = await portalRequest<Provider[]>('providers');
  }
  onMount(() => { loadProviders().catch(e => error = e.message); });
  async function signIn() {
    busy = true; error = ''; notice = '';
    try { await login(username, password); password = ''; await loadProviders(); }
    catch (e) { error = e instanceof Error ? e.message : String(e); }
    finally { busy = false; }
  }
  async function signOut() {
    busy = true; error = '';
    try { await logout(); } catch { notice = 'Signed out locally. The server session will expire automatically.'; }
    finally { providers = []; selected = ''; currentPassword = ''; newPassword = ''; confirmPassword = ''; busy = false; }
  }
  async function changePassword() {
    error = ''; notice = '';
    if (newPassword !== confirmPassword) { error = 'Passwords do not match.'; return; }
    busy = true;
    try {
      await portalRequest('password', 'POST', { current_password: currentPassword, password: newPassword });
      clearAccount(); providers = []; currentPassword = ''; newPassword = ''; confirmPassword = '';
      notice = 'Password changed. Please sign in with your new password.';
    } catch (e) { error = e instanceof Error ? e.message : String(e); }
    finally { busy = false; }
  }
  function openProvider() {
    const provider = providers.find(p => String(p.provider_id) === selected);
    if (provider) { setProvider(provider); push('/provider-portal/info'); }
  }
</script>

<PageShell appMode={true} navItems={providerPortalNavItems}>
  <div class="flex-1 overflow-auto bg-slate-50 p-6">
    <div class="mx-auto max-w-2xl space-y-6">
      <div><h1 class="text-2xl font-bold text-slate-900">Provider Portal</h1><p class="mt-2 text-slate-600">Manage your account and assigned provider profiles.</p></div>
      {#if error}<div role="alert" class="rounded-lg border border-red-200 bg-red-50 p-4 text-red-700">{error}</div>{/if}
      {#if notice}<div role="status" class="rounded-lg border border-green-200 bg-green-50 p-4 text-green-800">{notice}</div>{/if}
      {#if !$portalAccount}
        <form onsubmit={(event) => { event.preventDefault(); signIn(); }} class="space-y-5 rounded-xl border bg-white p-6 shadow-sm">
          <h2 class="text-lg font-semibold">Sign in</h2>
          <label class="block">Username<input class="field" bind:value={username} autocomplete="username" required maxlength="80" /></label>
          <label class="block">Password<input class="field" type="password" bind:value={password} autocomplete="current-password" required maxlength="128" /></label>
          <button class="primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
          <p class="text-sm text-slate-500">Accounts are created by your administrator. Contact them if you need access or a password reset.</p>
        </form>
      {:else}
        <section class="space-y-4 rounded-xl border bg-white p-6 shadow-sm">
          <div class="flex flex-wrap items-center justify-between gap-3"><div><h2 class="font-semibold">{$portalAccount.display_name}</h2><p class="text-sm text-slate-500">{$portalAccount.username} · {$portalAccount.role === 'super_admin' ? 'Super administrator' : 'Provider account'}</p></div><button class="secondary" onclick={signOut} disabled={busy}>Sign out</button></div>

            {#if $portalAccount.role === 'super_admin'}<a href="#/admin/accounts" class="primary inline-block">Manage accounts</a>{/if}
            <label class="block">Provider<select class="field" bind:value={selected}><option value="">Select a provider…</option>{#each providers as provider}<option value={String(provider.provider_id)}>{provider.provider_name}</option>{/each}</select></label>
            <button class="primary" disabled={!selected || busy} onclick={openProvider}>Manage provider</button>
            {#if providers.length === 0}<p class="text-sm text-slate-500">No providers are assigned to your account. Contact your administrator.</p>{/if}
        </section>
        <form onsubmit={(event) => { event.preventDefault(); changePassword(); }} class="space-y-4 rounded-xl border bg-white p-6 shadow-sm">
          <h2 class="text-lg font-semibold">Change password</h2>
          <label class="block">Current password<input class="field" type="password" bind:value={currentPassword} autocomplete="current-password" required maxlength="128" /></label>
          <label class="block">New password<input class="field" type="password" bind:value={newPassword} autocomplete="new-password" required minlength="8" maxlength="128" /></label>
          <label class="block">Confirm new password<input class="field" type="password" bind:value={confirmPassword} autocomplete="new-password" required minlength="8" maxlength="128" /></label>
          <p class="text-sm text-slate-500">Use 8–128 characters. Changing your password signs out all sessions.</p>
          <button class="primary" disabled={busy}>{busy ? 'Saving…' : 'Change password'}</button>
        </form>
      {/if}
    </div>
  </div>
</PageShell>
<style>
  .field { display: block; width: 100%; margin-top: .5rem; padding: .65rem .8rem; border: 1px solid #cbd5e1; border-radius: .5rem; background: white; }
  .primary, .secondary { border-radius: .5rem; padding: .65rem 1rem; font-weight: 600; }
  .primary { background: #0f172a; color: white; } .secondary { border: 1px solid #cbd5e1; }
  button:disabled { opacity: .5; cursor: not-allowed; }
</style>
