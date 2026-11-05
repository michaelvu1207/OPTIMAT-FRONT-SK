<script>
  /**
   * What OPTIMAT is, shown once when the page loads.
   *
   * Explain the county focus and why rider details are requested before starting a chat.
   */
  import { onMount } from 'svelte';
  import { containDialogTab } from '$lib/utils/dialogFocus.js';

  /** Called after the rider dismisses it, in case the caller wants to focus the chat box. */
  export let onClose = null;

  const CONTACT = 'haleemab@ccta.ca.gov';

  let dialogElement = null;

  onMount(() => {
    dialogElement?.showModal();
    return () => dialogElement?.close();
  });

  function close() {
    dialogElement?.close();
    onClose?.();
  }

</script>

<dialog
  bind:this={dialogElement}
  class="m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg overflow-hidden rounded-xl border border-border bg-card p-0 text-foreground shadow-xl backdrop:bg-black/50 backdrop:backdrop-blur-sm"
  aria-labelledby="welcome-title"
  on:cancel|preventDefault={close}
  on:keydown={containDialogTab}
>
  <div class="flex max-h-[calc(100dvh-2rem)] flex-col">
    <div class="relative shrink-0 px-5 pb-3 pt-5 pr-14">
      <h2 id="welcome-title" class="text-lg font-semibold">Welcome to OPTIMAT</h2>
      <button type="button" class="absolute right-2 top-2 flex min-h-11 min-w-11 items-center justify-center rounded-md hover:bg-muted" aria-label="Close welcome dialog" on:click={close}><span aria-hidden="true">✕</span></button>
    </div>
    <div class="min-h-0 overflow-y-auto px-5 pb-4 text-sm leading-relaxed">
      <p>Find transportation options for seniors and people with disabilities in Contra Costa County.</p>
      <p class="mt-3">Trip details, age range, city, and accessibility needs help match you with providers.</p>
      <p class="mt-3">This is a prototype. Providers confirm eligibility and availability. OPTIMAT does not book rides.</p>
      <p class="mt-3">Chats and trip details are stored and encrypted. Do not share medical records or payment information.</p>
      <details class="mt-3">
        <summary class="cursor-pointer py-2 font-semibold underline underline-offset-2">Privacy and project details</summary>
        <div class="mt-2 space-y-3">
          <p>Addresses help check service areas; dates and times help check service hours and booking notice. Age range, city, and accessibility needs help check eligibility. Each provider has its own rules.</p>
          <p>Your chat messages and trip details are stored by OPTIMAT and encrypted during transfer and in database storage. Share only the details needed to find a ride.</p>
          <p>Questions or feedback: <a href="mailto:{CONTACT}" class="font-medium text-primary underline underline-offset-2">{CONTACT}</a>.</p>
          <p>A project of the Contra Costa Transportation Authority, UC Berkeley PATH, and Advanced Mobility Group.</p>
        </div>
      </details>
    </div>
    <div class="shrink-0 border-t border-border bg-card px-5 py-3">
      <button type="button" class="min-h-11 w-full rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/90" on:click={close}>Get started</button>
    </div>
  </div>
</dialog>
