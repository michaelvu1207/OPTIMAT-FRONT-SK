<script>
  /**
   * What OPTIMAT is, shown once when the page loads.
   *
   * Testers arrive at a map and a chat box with no framing, so this says what the tool does, that
   * it is a prototype under test, and where to send feedback.
   */
  import { onMount } from 'svelte';
  import { fade, fly } from 'svelte/transition';

  /** Called after the rider dismisses it, in case the caller wants to focus the chat box. */
  export let onClose = null;

  const CONTACT = 'haleemab@ccta.ca.gov';

  let visible = false;

  onMount(() => {
    visible = true;
  });

  function close() {
    visible = false;
    onClose?.();
  }

  function onKeydown(event) {
    if (event.key === 'Escape') close();
  }
</script>

<svelte:window on:keydown={onKeydown} />

{#if visible}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div
    class="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
    on:click={close}
    transition:fade={{ duration: 150 }}
  >
    <!-- svelte-ignore a11y-click-events-have-key-events -->
    <!-- svelte-ignore a11y-no-static-element-interactions -->
    <div
      class="relative w-full max-w-lg rounded-xl border border-border bg-card p-6 shadow-xl sm:p-7"
      role="dialog"
      aria-modal="true"
      aria-labelledby="welcome-title"
      tabindex="-1"
      on:click|stopPropagation
      in:fly={{ y: 16, duration: 200 }}
    >
      <button
        type="button"
        class="absolute right-3 top-3 rounded-md p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
        aria-label="Close"
        on:click={close}
      >
        <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>

      <div class="flex items-center gap-2 pr-8">
        <span class="text-lg">◆</span>
        <h2 id="welcome-title" class="text-lg font-semibold text-foreground">Welcome to OPTIMAT</h2>
      </div>

      <p class="mt-3 text-[15px] leading-relaxed text-foreground">
        OPTIMAT is a user-friendly trip planning tool that will help seniors and people with
        disabilities discover and match to transportation services from the 24+ providers in Contra
        Costa County. This prototype tool is currently under testing and we welcome your feedback.
        Want to share your input or learn more? Connect with us at
        <a href="mailto:{CONTACT}" class="font-medium text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary">{CONTACT}</a>
      </p>

      <p class="mt-3 text-[13px] leading-relaxed text-muted-foreground">
        OPTIMAT is a project of the Contra Costa Transportation Authority in partnership with the
        University of California, Berkeley PATH research team, and Advanced Mobility Group.
      </p>

      <div class="mt-5 flex justify-end">
        <button
          type="button"
          class="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
          on:click={close}
        >
          Get started
        </button>
      </div>
    </div>
  </div>
{/if}
