<script lang="ts">
  import { onMount } from 'svelte';
  import PageShell from '$lib/components/PageShell.svelte';
  import { providerPortalNavItems } from '$lib/providerPortalNav';
  import { portalAccount, portalRequest, type Account } from '$lib/stores/portalAccount';
  import type { Provider } from '$lib/api';
  let accounts: Account[] = [], providers: Provider[] = [];
  let loading = true, busy = false, editing = false, error = '', notice = '', search = '';
  let id = '', username = '', displayName = '', password = '', role = 'provider', active = true;
  let providerIds: number[] = [];
  $: allowed = $portalAccount?.role === 'super_admin';
  $: filtered = accounts.filter(a => `${a.username} ${a.display_name}`.toLowerCase().includes(search.toLowerCase()));
  onMount(() => { if (allowed) refresh(); else loading = false; });
  async function refresh() {
    loading = true;
    try {
      [accounts, providers] = await Promise.all([portalRequest<Account[]>('accounts'), portalRequest<Provider[]>('providers')]);
    } catch (e) { error = e instanceof Error ? e.message : String(e); }
    finally { loading = false; }
  }
  function edit(account?: Account) {
    id = account?.id || ''; username = account?.username || ''; displayName = account?.display_name || '';
    role = account?.role || 'provider'; active = account?.active ?? true;
    providerIds = [...(account?.provider_ids || [])]; password = ''; error = ''; notice = ''; editing = true;
  }
  async function save() {
    busy = true; error = ''; notice = '';
    try {
      await portalRequest(id ? `accounts/${id}` : 'accounts', id ? 'PUT' : 'POST', {
        username, display_name: displayName, role, active, provider_ids: providerIds,
        ...(password ? { password } : {}),
      });
      editing = false; password = ''; notice = 'Account saved. Updated permissions apply immediately; affected users must sign in again.';
      await refresh();
    } catch (e) { error = e instanceof Error ? e.message : String(e); }
    finally { busy = false; }
  }
  function providerNames(account: Account) {
    if (account.role === 'super_admin') return 'All providers';
    return providers.filter(p => account.provider_ids?.includes(Number(p.provider_id))).map(p => p.provider_name).join(', ') || 'No providers assigned';
  }
</script>
<PageShell appMode={true} navItems={providerPortalNavItems}>
  <div class="flex-1 overflow-auto bg-slate-50 p-6">
    <div class="mx-auto max-w-6xl space-y-5">
      <div class="flex flex-wrap items-center justify-between gap-4"><div><h1 class="text-2xl font-bold">Account management</h1><p class="mt-1 text-slate-600">Create accounts, assign providers, and manage access.</p></div>{#if allowed}<button class="primary" onclick={() => edit()} disabled={busy || loading}>Create account</button>{/if}</div>
      {#if !allowed}
        <div class="rounded-xl border bg-white p-6"><p>Sign in as a super administrator to manage accounts.</p><a href="#/provider-portal" class="mt-3 inline-block underline">Go to sign in</a></div>
      {:else}
        {#if error}<div role="alert" class="rounded-lg bg-red-50 p-4 text-red-700">{error}</div>{/if}
        {#if notice}<div role="status" class="rounded-lg bg-green-50 p-4 text-green-800">{notice}</div>{/if}
        {#if editing}
          <form onsubmit={event => { event.preventDefault(); save(); }} class="space-y-4 rounded-xl border bg-white p-6 shadow-sm">
            <h2 class="text-lg font-semibold">{id ? 'Edit account' : 'Create account'}</h2>
            <fieldset disabled={busy} class="grid gap-4 md:grid-cols-2">
              <label>Username<input class="field" bind:value={username} disabled={!!id} required minlength="3" maxlength="80" autocomplete="off" /></label>
              <label>Display name<input class="field" bind:value={displayName} required maxlength="120" /></label>
              <label>Role<select class="field" bind:value={role} disabled={id === $portalAccount?.id}><option value="provider">Provider account</option><option value="super_admin">Super administrator — all providers</option></select></label>
              <label>Status<select class="field" bind:value={active} disabled={id === $portalAccount?.id}><option value={true}>Active</option><option value={false}>Disabled</option></select></label>
              {#if id !== $portalAccount?.id}<label class="md:col-span-2">{id ? 'Reset password (leave blank to keep current password)' : 'Password'}<input class="field" type="password" bind:value={password} required={!id} minlength="8" maxlength="128" autocomplete="new-password" /><span class="text-sm text-slate-500">8–128 characters. The password is ready to use immediately.</span></label>{/if}
              <div class="md:col-span-2"><h3 class="font-medium">Assigned providers</h3>{#if role === 'super_admin'}<p class="mt-2 text-sm text-slate-500">Super administrators can manage every provider.</p>{:else}<div class="mt-2 grid max-h-64 gap-2 overflow-auto rounded-lg border p-3 md:grid-cols-2">{#each providers as provider}<label class="flex items-start gap-2 text-sm"><input type="checkbox" bind:group={providerIds} value={Number(provider.provider_id)} class="mt-1" />{provider.provider_name} ({provider.provider_id})</label>{/each}</div>{/if}</div>
            </fieldset>
            <div class="flex gap-3"><button class="primary" disabled={busy}>{busy ? 'Saving…' : 'Save account'}</button><button type="button" class="secondary" disabled={busy} onclick={() => { editing = false; password = ''; }}>Cancel</button></div>
          </form>
        {/if}
        <section class="overflow-hidden rounded-xl border bg-white shadow-sm">
          <div class="border-b p-4"><label>Search accounts<input class="field" type="search" bind:value={search} placeholder="Username or display name" /></label></div>
          {#if loading}<p class="p-6">Loading accounts…</p>{:else}<div class="overflow-x-auto"><table class="w-full text-left text-sm"><thead class="bg-slate-50"><tr><th>Account</th><th>Role / Status</th><th>Providers</th><th>Actions</th></tr></thead><tbody>{#each filtered as account}<tr class="border-t"><td><strong>{account.display_name}</strong><div class="text-slate-500">{account.username}</div></td><td>{account.role === 'super_admin' ? 'Super admin' : 'Provider'}<div class={account.active ? 'text-green-700' : 'text-red-700'}>{account.active ? 'Active' : 'Disabled'}</div></td><td class="max-w-md">{providerNames(account)}</td><td><button class="secondary" onclick={() => edit(account)} disabled={busy}>Edit</button></td></tr>{/each}</tbody></table>{#if filtered.length === 0}<p class="p-6 text-slate-500">No matching accounts.</p>{/if}</div>{/if}
        </section>
      {/if}
    </div>
  </div>
</PageShell>
<style>
  .field { display: block; width: 100%; margin-top: .5rem; padding: .65rem .8rem; border: 1px solid #cbd5e1; border-radius: .5rem; background: white; }
  .primary, .secondary { border-radius: .5rem; padding: .65rem 1rem; font-weight: 600; }
  .primary { background: #0f172a; color: white; } .secondary { border: 1px solid #cbd5e1; }
  button:disabled, input:disabled, select:disabled { opacity: .5; cursor: not-allowed; }
  th, td { padding: 1rem; vertical-align: top; }
</style>
