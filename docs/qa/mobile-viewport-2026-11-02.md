# Mobile viewport follow-up

The existing responsive chat layout, visual-viewport keyboard handling, pinch-zoom protection, and conversation persistence are retained. Before this change, the original mobile composer regression passed all ten viewport configurations on a fresh run.

The remaining boundary is a delayed `visualViewport.height` during a shorter viewport transition. Holding the previous 1024-pixel visual height while resizing to an 800-pixel window reproduced an input at y=916, below the visible window. This matches the earlier intermittent tablet-to-desktop test failure without relying on a race to trigger it.

The viewport-fitting page shell now has a CSS `max-height: 100dvh` in addition to its existing JavaScript-controlled height. CSS constrains the shell immediately when the layout viewport shrinks, even if the visual-height notification is late. A smaller visual height still sizes the shell for the on-screen keyboard. Pinch zoom retains the existing behavior and does not shrink the layout a second time. Browsers without dynamic viewport units can continue using the previous JavaScript height handling.

The regression deliberately holds the old visual height across tall-tablet transitions and checks controls before releasing it. It also checks that the same response DOM node and keyboard reading focus survive a breakpoint transition, that a reader is not forced to the latest response, and that the conversation and draft persist. Existing phone/tablet/desktop, short landscape, keyboard-height, long-content, and pinch-zoom cases remain in the same test.

Run `PLAYWRIGHT_CHANNEL=msedge node tests/chat/mobile-composer.mjs` and `PLAYWRIGHT_CHANNEL=msedge node tests/chat/accessibility-navigation.mjs` against the local server at port 43111. External APIs are stubbed. Browser emulation does not replace physical iOS/Android keyboard and VoiceOver testing.
