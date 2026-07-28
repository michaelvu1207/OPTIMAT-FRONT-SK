<script>
  /**
   * Feedback bubble shown under the assistant's provider recommendations.
   *
   * Testers see the providers OPTIMAT picked and know right then whether the answer was wrong —
   * that is the moment worth catching, so this sits in the conversation rather than behind a
   * separate feedback screen. Submitting stores the comment together with the conversation as it
   * read at that moment, so a reviewer can see what the tester was reacting to.
   */
  import { fly } from 'svelte/transition';
  import { submitChatFeedback } from '$lib/api';

  /** Conversation the feedback refers to. */
  export let conversationId = null;
  /** Assistant message the bubble is attached to, when it has a stored id. */
  export let messageId = null;
  /** Returns the conversation as currently rendered: [{ role, content, created_at }]. */
  export let getTranscript = () => [];
  /** Extra context stored alongside the comment (providers on screen, etc.). */
  export let context = {};
  /** Called once feedback is stored, so the caller can stop offering it for this conversation. */
  export let onSubmitted = null;
  /** Called when the tester dismisses the prompt without answering. */
  export let onDismiss = null;

  const NAME_STORAGE_KEY = 'optimat-feedback-name';

  let expanded = false;
  let name = '';
  let comment = '';
  let submitting = false;
  let submitted = false;
  let error = null;
  let commentElement = null;
  let rootElement = null;

  function open() {
    expanded = true;
    // Repeat testers should not retype their name every conversation.
    try {
      name = name || localStorage.getItem(NAME_STORAGE_KEY) || '';
    } catch {
      // Private browsing or blocked storage: the field just starts empty.
    }
    // The bubble sits at the bottom of a scrolled thread, so the form opens below the fold unless
    // it is pulled into view.
    setTimeout(() => {
      rootElement?.scrollIntoView({ behavior: 'smooth', block: 'end' });
      commentElement?.focus({ preventScroll: true });
    }, 0);
  }

  function dismiss() {
    expanded = false;
    onDismiss?.();
  }

  async function submit() {
    if (submitting) return;
    const trimmedComment = comment.trim();
    if (!trimmedComment) {
      error = 'Please tell us what went well or what went wrong.';
      return;
    }

    submitting = true;
    error = null;

    const { error: submitError } = await submitChatFeedback({
      conversationId,
      messageId,
      name: name.trim() || undefined,
      comment: trimmedComment,
      rating: 'down',
      transcript: getTranscript(),
      context
    });

    submitting = false;

    if (submitError) {
      error = 'Could not send your feedback. Please try again.';
      return;
    }

    try {
      if (name.trim()) localStorage.setItem(NAME_STORAGE_KEY, name.trim());
    } catch {
      // Not being able to remember the name is not worth surfacing.
    }

    submitted = true;
    onSubmitted?.();
  }

  function onKeydown(event) {
    // Enter submits from the name field; the comment box keeps Enter for newlines.
    if (event.key === 'Enter' && !event.shiftKey && event.target?.tagName !== 'TEXTAREA') {
      event.preventDefault();
      submit();
    }
  }
</script>

<div
  class="flex gap-2 justify-start"
  bind:this={rootElement}
  in:fly={{ x: -20, duration: 300 }}
  data-testid="feedback-prompt"
>
  <div class="flex-shrink-0 w-7 h-7 rounded-full bg-blue-100 dark:bg-blue-500/20 flex items-center justify-center text-xs">
    💬
  </div>

  <div class="max-w-[94%] rounded-2xl rounded-tl-sm border border-blue-200 bg-blue-50 px-3 py-2 dark:border-blue-500/30 dark:bg-blue-500/10">
    {#if submitted}
      <p class="text-sm text-blue-900 dark:text-blue-100">
        Thanks{name.trim() ? `, ${name.trim()}` : ''} — your feedback was saved along with this
        conversation. It goes straight to the OPTIMAT team.
      </p>
    {:else}
      <p class="text-sm text-blue-900 dark:text-blue-100">
        Hey, do you have any feedback? Tell us whether these options look right for your trip — it
        helps us fix what OPTIMAT gets wrong.
      </p>

      {#if !expanded}
        <div class="mt-2 flex items-center gap-2">
          <button
            type="button"
            class="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-blue-700"
            on:click={open}
          >
            Give feedback
          </button>
          <button
            type="button"
            class="rounded-lg px-2 py-1.5 text-xs text-blue-700/80 transition hover:text-blue-900 dark:text-blue-200/80 dark:hover:text-blue-100"
            on:click={dismiss}
          >
            Not now
          </button>
        </div>
      {:else}
        <!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
        <div class="mt-2 space-y-2" on:keydown={onKeydown} role="form" aria-label="Send feedback">
          <div>
            <label class="mb-1 block text-[11px] font-medium text-blue-900/80 dark:text-blue-100/80" for="feedback-name">
              Your name
            </label>
            <input
              id="feedback-name"
              type="text"
              bind:value={name}
              placeholder="e.g. Sofia"
              autocomplete="name"
              class="w-full rounded-lg border border-blue-200 bg-background px-2.5 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-blue-400 focus:outline-none dark:border-blue-500/30"
            />
          </div>

          <div>
            <label class="mb-1 block text-[11px] font-medium text-blue-900/80 dark:text-blue-100/80" for="feedback-comment">
              Your feedback
            </label>
            <textarea
              id="feedback-comment"
              bind:this={commentElement}
              bind:value={comment}
              rows="3"
              placeholder="What was wrong, missing, or confusing?"
              class="w-full resize-y rounded-lg border border-blue-200 bg-background px-2.5 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-blue-400 focus:outline-none dark:border-blue-500/30"
            ></textarea>
          </div>

          {#if error}
            <p class="text-[11px] text-destructive" role="alert">{error}</p>
          {/if}

          <div class="flex items-center gap-2">
            <button
              type="button"
              class="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-blue-700 disabled:opacity-60"
              disabled={submitting || !comment.trim()}
              on:click={submit}
            >
              {submitting ? 'Sending…' : 'Submit feedback'}
            </button>
            <button
              type="button"
              class="rounded-lg px-2 py-1.5 text-xs text-blue-700/80 transition hover:text-blue-900 dark:text-blue-200/80 dark:hover:text-blue-100"
              on:click={dismiss}
            >
              Cancel
            </button>
          </div>

          <p class="text-[11px] text-blue-900/70 dark:text-blue-100/70">
            This conversation is saved with your comment so the team can see what you saw.
          </p>
        </div>
      {/if}
    {/if}
  </div>
</div>
