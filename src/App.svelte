<script>
  import { tick } from 'svelte';
  import Router, { location } from 'svelte-spa-router';
  import routes from './routes';
  import ChatView from './routes/ChatView.svelte';

  let chatVisited = false;
  $: currentRoute = routes[$location.replace(/\/$/, '') || '/'] || routes['*'];
  $: showingChat = currentRoute === ChatView;
  $: if (showingChat) {
    chatVisited = true;
    // Leaflet needs to measure its container again after it becomes visible.
    tick().then(() => window.dispatchEvent(new Event('resize')));
  }
</script>

<!-- Keep the conversation and in-flight requests alive across site navigation. -->
{#if chatVisited}
  <div hidden={!showingChat}>
    <ChatView />
  </div>
{/if}

{#if !showingChat}
  <Router {routes} />
{/if}
