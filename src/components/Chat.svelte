<script>
    import { onMount, createEventDispatcher, tick } from 'svelte';
    import { fade, fly, slide } from 'svelte/transition';
    import MicIcon from '@lucide/svelte/icons/mic';
    import SquareIcon from '@lucide/svelte/icons/square';
    import { serviceZoneManager } from '../lib/serviceZoneManager.js';
    import { marked } from 'marked';
    import createDOMPurify from 'dompurify';
    import { browser } from '$app/environment';
    import {
        checkChatHealth,
        createConversation,
        sendChatMessage,
        saveConversationAsExample,
        getProviderServiceZone,
        transcribeAudio,
    } from '$lib/api';

    const escapeHtml = (value) => String(value || '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');

    function safeLinkHref(value) {
      const href = String(value || '').trim();
      return /^(https?:|mailto:|tel:)/i.test(href) ? href : null;
    }

    // Marked creates the formatting, while raw HTML and unsafe protocols are
    // rejected here and DOMPurify performs the final browser-side sanitation.
    marked.setOptions({
        breaks: true,
        gfm: true
    });
    marked.use({
      renderer: {
        html(token) {
          return escapeHtml(token.text);
        },
        link(token) {
          const href = safeLinkHref(token.href);
          const label = this.parser.parseInline(token.tokens || []);
          if (!href) return label;
          const external = /^https?:/i.test(href);
          return `<a href="${escapeHtml(href)}"${external ? ' target="_blank" rel="noopener noreferrer"' : ''}>${label}</a>`;
        },
        image(token) {
          const href = /^https?:/i.test(String(token.href || '')) ? token.href : null;
          return href ? `<img src="${escapeHtml(href)}" alt="${escapeHtml(token.text || '')}">` : escapeHtml(token.text || '');
        }
      }
    });

    const purifier = browser ? createDOMPurify(window) : null;

    function linkifyContactText(html) {
      if (!browser) return html;
      const documentFragment = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
      const walker = documentFragment.createTreeWalker(documentFragment.body, NodeFilter.SHOW_TEXT);
      const nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      const contactPattern = /([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4})/gi;

      for (const node of nodes) {
        if (node.parentElement?.closest('a, code, pre')) continue;
        const text = node.textContent || '';
        contactPattern.lastIndex = 0;
        if (!contactPattern.test(text)) continue;
        contactPattern.lastIndex = 0;
        const fragment = documentFragment.createDocumentFragment();
        let lastIndex = 0;
        for (const match of text.matchAll(contactPattern)) {
          const value = match[0];
          const start = match.index || 0;
          fragment.append(text.slice(lastIndex, start));
          const anchor = documentFragment.createElement('a');
          const isEmail = value.includes('@');
          const digits = value.replace(/\D/g, '');
          anchor.href = isEmail ? `mailto:${value}` : `tel:${digits.length === 10 ? `+1${digits}` : `+${digits}`}`;
          anchor.textContent = value;
          fragment.append(anchor);
          lastIndex = start + value.length;
        }
        fragment.append(text.slice(lastIndex));
        node.replaceWith(fragment);
      }
      return documentFragment.body.innerHTML;
    }

    // Render markdown to HTML
    function renderMarkdown(content) {
        if (!content) return '';
        const rendered = marked.parse(content);
        if (!purifier) return rendered;
        const sanitized = purifier.sanitize(rendered, { ADD_ATTR: ['target', 'rel'] });
        return purifier.sanitize(linkifyContactText(sanitized), { ADD_ATTR: ['target', 'rel'] });
    }

    export let onProvidersFound = null;

    function normalizeChatRole(role) {
        const value = (role || '').toString().toLowerCase();
        if (value === 'assistant' || value === 'ai') return 'ai';
        if (value === 'user' || value === 'human') return 'human';
        if (value === 'system') return 'system';
        return role;
    }

    function normalizeReplayConfig(raw) {
        const cfg = raw && typeof raw === 'object' ? raw : {};
        return {
            auto_advance: cfg.auto_advance ?? cfg.autoAdvance ?? false,
            delay_ms: cfg.delay_ms ?? cfg.delayMs ?? 2000,
            typewriter_effect: cfg.typewriter_effect ?? cfg.showTypewriter ?? true,
            highlight_tool_calls: cfg.highlight_tool_calls ?? cfg.highlightToolCalls ?? true
        };
    }

    function safeParseAttachmentData(value) {
        if (typeof value !== 'string') return value;
        try {
            return JSON.parse(value);
        } catch {
            return value;
        }
    }

    function getMessageAttachments(messageId) {
        return messageAttachments.get(messageId) || [];
    }

    function getAddressPlaces(messageId) {
        const attachments = getMessageAttachments(messageId);
        const addressAttachment = attachments.find(att => att.type === 'address_search');
        if (!addressAttachment?.data) return [];
        const data = safeParseAttachmentData(addressAttachment.data) || {};
        const places = Array.isArray(data.places) ? data.places : [];
        return places.map((place) => ({
            address: place?.formattedAddress || place?.address || '',
            name: place?.displayName?.text || place?.name || '',
            location: place?.location || null
        })).filter((p) => p.address);
    }

    function openAddressPlace(place) {
        if (!place?.address) return;
        dispatch('addressFound', {
            address: place.address,
            messageRole: 'attachment_click',
            placeName: place.name || null
        });
    }

    function getAttachmentData(messageId, type) {
        const attachments = getMessageAttachments(messageId);
        const attachment = attachments.find(att => att.type === type);
        if (!attachment?.data) return null;
        return safeParseAttachmentData(attachment.data);
    }

    const dispatch = createEventDispatcher();

    function emitProvidersFound(providerData) {
        if (typeof onProvidersFound === 'function') {
            onProvidersFound({ detail: providerData });
        }
    }
    
    // Typewriter effect component
    function typewriterAction(node, { text, maxDuration = 2000, messageId, onComplete = null }) {
        let i = 0;
        let currentText = '';
        let timeoutId;
        let isDestroyed = false;
        
        // Calculate simple speed to fit within maxDuration
        const availableTime = maxDuration - 100; // subtract initial delay
        const speed = Math.max(5, availableTime / text.length); // minimum 5ms per character
        
        // Add typing indicator to the set
        typingMessages.add(messageId);
        typingMessages = typingMessages; // Trigger reactivity
        
        function type() {
            if (isDestroyed || i >= text.length) {
                // Remove typing indicator
                typingMessages.delete(messageId);
                typingMessages = typingMessages; // Trigger reactivity
                if (onComplete) onComplete();
                return;
            }
            
            currentText += text.charAt(i);
            node.textContent = currentText;
            i++;
            
            timeoutId = setTimeout(type, speed);
        }
        
        // Start typing with a small delay to allow the message to appear first
        timeoutId = setTimeout(type, 100);
        
        return {
            destroy() {
                isDestroyed = true;
                if (timeoutId) clearTimeout(timeoutId);
                typingMessages.delete(messageId);
                typingMessages = typingMessages; // Trigger reactivity
            }
        };
    }
  
    let messages = [
      {
        role: 'ai',
        content: `Hello! I'm your OPTIMAT transportation assistant. Here's what I can help you with:

**🔍 Find Providers** - Search for paratransit and transportation providers based on your pickup and drop-off locations

**📍 Address Search** - Look up and validate addresses to ensure accurate provider matching

**📋 Provider Details** - Get detailed information about specific providers including contact info, eligibility, and service hours

**🌐 General Questions** - Answer questions about paratransit services, accessibility requirements, and transportation options

How can I assist you today?`,
        id: 'initial-greeting'
      }
    ];
    
    let userInput = "I'm at Hanover Walnut Creek apartments, and trying to go to the Target in Walnut Creek? Can you help me find providers?";
    let loading = false; // For message sending
    let initializing = true; // For initial conversation setup
    let error = null;
    let serverOnline = false;
    let conversationId = null;
    let isRecording = false;
    let isTranscribing = false;
    let mediaRecorder = null;
    let recordingStream = null;
    let audioChunks = [];
    let messageInputElement = null;
    let sendButtonElement = null;
    let composerElement = null;
    let activeChatController = null;
    let statusMessage = '';
    let shouldRestoreComposerFocus = true;
    
    // Save as example functionality
    let savingAsExample = false;
    let showExampleForm = false;
    let saveExampleSuccess = false;
    let exampleForm = {
      title: '',
      description: '',
      category: 'general',
      tags: ''
    };

    // Category options for examples
    const exampleCategories = [
      { value: 'booking', label: 'Booking' },
      { value: 'eligibility', label: 'Eligibility' },
      { value: 'transit', label: 'Transit' },
      { value: 'general', label: 'General' }
    ];
    
    // Example viewing functionality
    let isViewingExample = false;
    let currentExample = null;
    let isLoadingExample = false;
    let examplePlaybackPaused = false;
    let currentExampleIndex = 0; // Track current message index in example
    let totalExampleStates = 0; // Total number of states in current example

    // Enhanced replay state (for new replay endpoint)
    let replayStates = []; // Full replay states from backend
    let currentStateIndex = 0; // Current position in replay
    let isAutoPlaying = false; // Whether auto-advance is active
    let playbackSpeed = 1; // Playback speed multiplier (0.5, 1, 1.5, 2)
    let autoPlayTimer = null; // Timer for auto-advance
    let replayConfig = null; // Configuration from replay endpoint
    let useTypewriterEffect = true; // Whether to use typewriter for AI messages

    // Typewriter effect state
    let typingMessages = new Set(); // Track which messages are currently typing

    // SSE Streaming state
    let streamingMessage = ''; // Current streaming message content
    let currentTool = null; // Current tool being executed (name and status)
    let isStreaming = false; // Whether we're in streaming mode

    // Provider results bottom bar state
    let latestProviderResults = null; // Most recent provider search results
    let selectedProvider = null; // Currently selected provider for detail view
    let detailPanelHeight = 280; // Height of detail panel in pixels
    let isDetailPanelOpen = false; // Whether detail panel is visible
    let isResizing = false; // Whether user is resizing the panel

    // Debug mode for logging
    const DEBUG_MODE = true;

    // Enhanced attachment handling
    let messageAttachments = new Map(); // Map message IDs to their attachments
    
    // Service zone state management
    let visibleProviderZones = new Set(); // Track which provider zones are visible
    let loadingProviderZones = new Set(); // Track which provider zones are loading

    // Debug logging function
    function debugLogChatResponse(fullResponse, timestamp = new Date().toISOString()) {
        if (!DEBUG_MODE) return;
        
        console.group(`🔍 CHAT RESPONSE DEBUG - ${timestamp}`);
        console.log('📦 Full Response Object:', fullResponse);
        
        if (fullResponse.messages) {
            console.log('💬 Messages:', fullResponse.messages);
            console.log('📊 Message Count:', fullResponse.messages.length);
        }
        
        if (fullResponse.attachments) {
            console.log('📎 Attachments:', fullResponse.attachments);
            console.log('📊 Attachment Count:', fullResponse.attachments.length);
            
            fullResponse.attachments.forEach((attachment, index) => {
                console.log(`📌 Attachment ${index + 1}:`, {
                    type: attachment.type,
                    dataKeys: Object.keys(attachment.data || {}),
                    metadata: attachment.metadata
                });
            });
        } else {
            console.log('📎 No attachments in response');
        }
        
        console.log('🗃️ Current Message Attachments Map:');
        console.log('Message Attachments Map Size:', messageAttachments.size);
        console.log('All Message IDs:', messages.map(m => m.id));
        console.log('Messages with Attachments:', Array.from(messageAttachments.keys()));
        console.groupEnd();
        
        console.groupEnd();
    }

    function getRecordingMimeType() {
      if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) {
        return '';
      }
      const candidates = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/mp4',
        'audio/ogg;codecs=opus'
      ];
      return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || '';
    }

    function getRecordingExtension(mimeType) {
      if (mimeType.includes('mp4')) return 'mp4';
      if (mimeType.includes('ogg')) return 'ogg';
      return 'webm';
    }

    function appendTranscribedText(text) {
      const cleanText = text.trim();
      if (!cleanText) return;
      userInput = userInput.trim()
        ? `${userInput.trim()} ${cleanText}`
        : cleanText;
    }

    function cleanupRecording() {
      if (recordingStream) {
        recordingStream.getTracks().forEach((track) => track.stop());
      }
      recordingStream = null;
      mediaRecorder = null;
      audioChunks = [];
      isRecording = false;
    }

    async function startRecording() {
      if (isRecording || isTranscribing) return;
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
        error = 'Voice input is not supported in this browser.';
        return;
      }

      try {
        error = null;
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const mimeType = getRecordingMimeType();
        const recorder = mimeType
          ? new MediaRecorder(stream, { mimeType })
          : new MediaRecorder(stream);

        recordingStream = stream;
        mediaRecorder = recorder;
        audioChunks = [];

        recorder.ondataavailable = (event) => {
          if (event.data?.size > 0) {
            audioChunks = [...audioChunks, event.data];
          }
        };

        recorder.onerror = () => {
          error = 'Recording failed. Please try again.';
          cleanupRecording();
        };

        recorder.onstop = async () => {
          const chunks = audioChunks;
          const recordedType = recorder.mimeType || mimeType || 'audio/webm';
          cleanupRecording();

          if (!chunks.length) {
            error = 'No audio was recorded. Please try again.';
            return;
          }

          isTranscribing = true;
          try {
            const blob = new Blob(chunks, { type: recordedType });
            const filename = `voice-input-${Date.now()}.${getRecordingExtension(recordedType)}`;
            const { data, error: transcriptionError } = await transcribeAudio(blob, filename);
            if (transcriptionError) throw transcriptionError;
            appendTranscribedText(data?.text || '');
          } catch (e) {
            error = e?.message || 'Voice transcription failed. Please try again.';
          } finally {
            isTranscribing = false;
          }
        };

        recorder.start();
        isRecording = true;
      } catch (e) {
        cleanupRecording();
        if (e?.name === 'NotAllowedError') {
          error = 'Microphone access was blocked. Allow microphone access to use voice input.';
        } else {
          error = e?.message || 'Could not start voice recording.';
        }
      }
    }

    function stopRecording() {
      if (!mediaRecorder) {
        cleanupRecording();
        return;
      }

      if (mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
      } else {
        cleanupRecording();
      }
    }

    function toggleRecording() {
      if (isRecording) {
        stopRecording();
      } else {
        startRecording();
      }
    }

    function debugLogFullChatHistory() {
        if (!DEBUG_MODE) return;
        
        console.group('📚 COMPLETE CHAT HISTORY');
        
        // Log all messages with their attachments
        const chatHistory = messages.map(msg => ({
            message: msg,
            attachments: messageAttachments.get(msg.id) || [],
            hasAttachments: messageAttachments.has(msg.id)
        }));
        
        console.log('Complete Chat Log:', chatHistory);
        
        // Log attachment summary
        const totalAttachments = Array.from(messageAttachments.values())
            .reduce((total, attachments) => total + attachments.length, 0);
        
        console.log('📊 Summary:', {
            totalMessages: messages.length,
            messagesWithAttachments: messageAttachments.size,
            totalAttachments: totalAttachments,
            attachmentTypes: Array.from(messageAttachments.values())
                .flat()
                .map(att => att.type)
                .filter((type, index, arr) => arr.indexOf(type) === index)
        });
        
        console.groupEnd();
    }

    // Attachment helper functions
    function hasAttachments(messageId) {
        return messageAttachments.has(messageId) && messageAttachments.get(messageId).length > 0;
    }

    function getAttachmentCount(messageId) {
        const attachments = messageAttachments.get(messageId);
        return attachments ? attachments.length : 0;
    }

    function getAttachmentTypes(messageId) {
        const attachments = messageAttachments.get(messageId);
        return attachments ? attachments.map(att => att.type) : [];
    }

    function getAttachmentToolName(attachment) {
        const metadata = safeParseAttachmentData(attachment?.metadata);
        return metadata && typeof metadata === 'object' ? metadata.tool_name : null;
    }

    function findProviderResultsAttachment(attachments) {
        if (!Array.isArray(attachments)) return null;

        return attachments.find(att => {
            if (att.type !== 'provider_search') return false;
            const toolName = getAttachmentToolName(att);
            const data = safeParseAttachmentData(att.data);
            if (!data || !Array.isArray(data.data)) return false;
            if (toolName === 'check_trip_coverage') return false;
            if (toolName === 'find_providers') return !data.status || data.status === 'complete';
            return !toolName && data.status === 'complete';
        }) || null;
    }

    function findProviderSearchProgressAttachment(attachments) {
        if (!Array.isArray(attachments)) return null;

        return attachments.find(att => {
            if (att.type !== 'provider_search') return false;
            const status = safeParseAttachmentData(att.data)?.status;
            return ['covered', 'not_covered', 'clarification_required'].includes(status);
        }) || null;
    }

    function getProviderSearchProgress(messageId) {
        const attachments = getMessageAttachments(messageId);
        const progressAttachment = findProviderSearchProgressAttachment(attachments);
        const data = safeParseAttachmentData(progressAttachment?.data);
        if (!data || typeof data !== 'object') return null;

        const sourceAddress = data.source_address || data.resolved_source || data.requested_source || '';
        const destinationAddress = data.destination_address || data.resolved_destination || data.requested_destination || '';

        if (data.status === 'covered') {
            return {
                state: 'in_progress',
                title: 'Provider search in progress',
                badge: 'Waiting for details',
                detail: 'Coverage check passed. Add the requested trip details to continue the provider search.',
                sourceAddress,
                destinationAddress
            };
        }

        if (data.status === 'clarification_required') {
            return {
                state: 'paused',
                title: 'Provider search needs confirmation',
                badge: 'Action required',
                detail: data.reason_code === 'location_city_mismatch'
                    ? 'Confirm the corrected location before the provider search can continue.'
                    : 'Confirm the requested information before the provider search can continue.',
                sourceAddress,
                destinationAddress
            };
        }

        if (data.status === 'not_covered') {
            return {
                state: 'stopped',
                title: 'Provider search stopped',
                badge: 'No coverage',
                detail: 'No matching provider service area covers both locations. Changing the trip time will not resolve this.',
                sourceAddress,
                destinationAddress
            };
        }

        return null;
    }

    function hasPublicTransitResult(publicTransit) {
        if (!publicTransit) return false;
        if (typeof publicTransit === 'string') return publicTransit.trim().length > 0;
        if (typeof publicTransit !== 'object') return false;
        return Boolean(
            publicTransit.overview_polyline ||
            publicTransit.polyline ||
            publicTransit.journey_description ||
            publicTransit.summary ||
            publicTransit.duration_text ||
            (Array.isArray(publicTransit.steps) && publicTransit.steps.length > 0) ||
            (Array.isArray(publicTransit.routes) && publicTransit.routes.length > 0)
        );
    }

    function getProviderSummary(messageId) {
        const attachments = messageAttachments.get(messageId);
        if (!attachments) return null;
        
        const providerAttachment = findProviderResultsAttachment(attachments);
        if (!providerAttachment || !providerAttachment.data) return null;
        
        // Normalize provider attachment data (can arrive as JSON string)
        let data = providerAttachment.data;
        if (typeof data === 'string') {
            try {
                data = JSON.parse(data);
            } catch (e) {
                console.warn('Failed to parse provider attachment data', e);
                return null;
            }
        }

        const providers = Array.isArray(data?.data) ? data.data : [];
        const publicTransit = data?.public_transit;
        const hasPublicTransit = hasPublicTransitResult(publicTransit);
        const verificationProviders = Array.isArray(data?.verification_required) ? data.verification_required : [];

        return {
            // Includes providers whose eligibility is still unconfirmed. They are real options —
            // counting only the confirmed ones showed "Providers found: 1" on a trip that had
            // three paratransit services pending an eligibility check. verificationCount below
            // breaks out how many of these still need checking.
            count: providers.length + verificationProviders.length + (hasPublicTransit ? 1 : 0),
            verificationCount: verificationProviders.length,
            sourceAddress: data.source_address,
            destinationAddress: data.destination_address,
            providers: providers.slice(0, 3), // Show first 3
            moreCount: Math.max(0, providers.length - 3),
            hasPublicTransit,
            allProviders: providers, // Keep reference to all providers
            publicTransit: publicTransit
        };
    }

    // Provider bar functions
    function updateLatestProviderResults(attachments) {
        if (!attachments) return;
        const providerAttachment = findProviderResultsAttachment(attachments);
        if (providerAttachment && providerAttachment.data) {
            let data = providerAttachment.data;
            if (typeof data === 'string') {
                try { data = JSON.parse(data); } catch (e) { return; }
            }
            const providers = Array.isArray(data?.data) ? data.data : [];
            latestProviderResults = {
                providers: providers,
                sourceAddress: data.source_address,
                destinationAddress: data.destination_address,
                publicTransit: data.public_transit
            };
            emitProvidersFound(data);
            // Auto-open detail panel if we have results
            if (providers.length > 0 && !isDetailPanelOpen) {
                selectedProvider = providers[0];
                isDetailPanelOpen = true;
                // Auto-show first provider's zone
                showProviderZoneOnMap(providers[0]);
            }
        }
    }

    function selectProvider(provider) {
        selectedProvider = provider;
        isDetailPanelOpen = true;
        showProviderZoneOnMap(provider);
    }

    function showProviderZoneOnMap(provider) {
        if (!provider) return;
        const providerId = provider.provider_id || provider.id;
        // Hide all other zones first
        serviceZoneManager.clearAllServiceZones();
        visibleProviderZones.clear();
        visibleProviderZones = new Set(visibleProviderZones);

        // Show this provider's zone
        if (provider.service_zone) {
            try {
                const geoJson = typeof provider.service_zone === 'string'
                    ? JSON.parse(provider.service_zone)
                    : provider.service_zone;

                serviceZoneManager.addServiceZone({
                    type: 'provider',
                    geoJson: geoJson,
                    label: provider.provider_name,
                    description: `${provider.provider_name} service area`,
                    metadata: { providerId: providerId, provider: provider },
                    config: { color: '#8b5cf6', fillOpacity: 0.15 }
                }, false);

                visibleProviderZones.add(providerId);
                visibleProviderZones = new Set(visibleProviderZones);
            } catch (e) {
                console.error('Error parsing provider service zone:', e);
            }
        }
    }

    function closeDetailPanel() {
        isDetailPanelOpen = false;
        selectedProvider = null;
        // Clear service zones when closing
        serviceZoneManager.clearAllServiceZones();
        visibleProviderZones.clear();
        visibleProviderZones = new Set(visibleProviderZones);
    }

    function startResize(e) {
        isResizing = true;
        const startY = e.clientY;
        const startHeight = detailPanelHeight;

        function onMouseMove(e) {
            const delta = startY - e.clientY;
            detailPanelHeight = Math.max(150, Math.min(500, startHeight + delta));
        }

        function onMouseUp() {
            isResizing = false;
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp);
        }

        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
    }

    function getProviderTypeIcon(type) {
        if (type?.includes('paratransit') || type?.includes('ADA')) return '♿';
        if (type?.includes('fix') || type?.includes('fixed')) return '🚌';
        if (type?.includes('dial') || type?.includes('demand')) return '📞';
        return '🚐';
    }

    function getProviderTypeColor(type) {
        if (type?.includes('paratransit') || type?.includes('ADA')) return 'bg-purple-100 text-purple-700 border-purple-200';
        if (type?.includes('fix') || type?.includes('fixed')) return 'bg-blue-100 text-blue-700 border-blue-200';
        if (type?.includes('dial') || type?.includes('demand')) return 'bg-green-100 text-green-700 border-green-200';
        return 'bg-gray-100 text-gray-700 border-gray-200';
    }

    // Service zone management functions
    async function toggleProviderServiceZone(providerId, providerName, provider) {
        const isVisible = visibleProviderZones.has(providerId);
        
        if (isVisible) {
            // Hide the zone
            serviceZoneManager.removeServiceZonesByProvider(providerId);
            visibleProviderZones.delete(providerId);
            visibleProviderZones = new Set(visibleProviderZones); // Trigger reactivity
        } else {
            // Show the zone
            loadingProviderZones.add(providerId);
            loadingProviderZones = new Set(loadingProviderZones); // Trigger reactivity
            
            try {
                // Use the service zone data if available from provider
                if (provider.service_zone) {
                    const zoneData = {
                        type: 'provider',
                        geoJson: typeof provider.service_zone === 'string' 
                            ? JSON.parse(provider.service_zone) 
                            : provider.service_zone,
                        label: providerName,
                        description: `${providerName} service area`,
                        metadata: {
                            providerId: providerId,
                            provider: provider
                        }
                    };
                    
                    const zoneId = serviceZoneManager.addServiceZone(zoneData, false);
                    if (zoneId) {
                        visibleProviderZones.add(providerId);
                        // Focus on this specific provider's zone
                        serviceZoneManager.focusOnServiceZone(zoneId);
                    }
                } else {
                    // Fallback: try to fetch from API if no service zone data
                    const { data: zoneData, error: zoneError } = await getProviderServiceZone(providerId);

                    if (!zoneError && zoneData && zoneData.has_service_zone && zoneData.raw_data) {
                        const serviceZoneData = {
                            type: 'provider',
                            geoJson: zoneData.raw_data,
                            label: providerName,
                            description: `${providerName} service area`,
                            metadata: {
                                providerId: providerId,
                                provider: provider
                            }
                        };

                        const zoneId = serviceZoneManager.addServiceZone(serviceZoneData, false);
                        if (zoneId) {
                            visibleProviderZones.add(providerId);
                            // Focus on this specific provider's zone
                            serviceZoneManager.focusOnServiceZone(zoneId);
                        }
                    }
                }
            } catch (error) {
                console.error('Error loading service zone:', error);
            } finally {
                loadingProviderZones.delete(providerId);
                loadingProviderZones = new Set(loadingProviderZones); // Trigger reactivity
            }
        }
        
        visibleProviderZones = new Set(visibleProviderZones); // Trigger reactivity
    }

    function isProviderZoneVisible(providerId) {
        return visibleProviderZones.has(providerId);
    }

    function isProviderZoneLoading(providerId) {
        return loadingProviderZones.has(providerId);
    }

    function getAddressSummary(messageId) {
        const attachments = messageAttachments.get(messageId);
        if (!attachments) return null;
        
        const addressAttachment = attachments.find(att => att.type === 'address_search');
        if (!addressAttachment || !addressAttachment.data) return null;

        const data = safeParseAttachmentData(addressAttachment.data) || {};
        const places = data.places || [];
        if (places.length === 0) return null;

        const firstPlace = places[0] || {};
        const address = firstPlace.formattedAddress || firstPlace.address || null;
        const name = firstPlace.displayName?.text || firstPlace.name || null;
        if (!address) return null;

        return {
            address,
            name
        };
    }

    function handleMessageClick(messageId) {
        const attachments = messageAttachments.get(messageId);
        if (!attachments || attachments.length === 0) return;
        
        // Check if this message is recent for filtering purposes
        const messageIndex = messages.findIndex(m => m.id === messageId);
        const isRecentMessage = messageIndex >= messages.length - 3;
        
        if (!isViewingExample) {
            // Handle provider attachments - always allow (original behavior)
            const providerAttachment = findProviderResultsAttachment(attachments);
            if (providerAttachment && providerAttachment.data) {
                // Normalize provider payload (may arrive as JSON string or nested data)
                let providerPayload = providerAttachment.data;
                if (typeof providerPayload === 'string') {
                    try {
                        providerPayload = JSON.parse(providerPayload);
                    } catch (e) {
                        console.warn('Failed to parse provider attachment payload', e);
                        providerPayload = null;
                    }
                }
                if (providerPayload && providerPayload.data && !Array.isArray(providerPayload.data) && Array.isArray(providerPayload.data.data)) {
                    providerPayload = { ...providerPayload, data: providerPayload.data.data };
                }
                if (!providerPayload) return;

                // Normalize coordinates to the shape expected by the map view.
                const origin =
                    providerPayload.origin ||
                    (providerPayload.source_coordinates?.lat !== undefined && providerPayload.source_coordinates?.lng !== undefined
                        ? { lat: providerPayload.source_coordinates.lat, lon: providerPayload.source_coordinates.lng }
                        : null);
                const destination =
                    providerPayload.destination ||
                    (providerPayload.destination_coordinates?.lat !== undefined && providerPayload.destination_coordinates?.lng !== undefined
                        ? { lat: providerPayload.destination_coordinates.lat, lon: providerPayload.destination_coordinates.lng }
                        : null);
                
                // Clear existing service zones when showing new provider results
                serviceZoneManager.clearAllServiceZones();
                visibleProviderZones.clear();
                loadingProviderZones.clear();
                
                // Process provider data and add to service zone manager
                const providerData = { ...providerPayload, origin, destination };
                if (Array.isArray(providerData.data) && providerData.data.length > 0) {
                    // Add all provider service zones to the manager (but don't focus yet)
                    serviceZoneManager.addProviderServiceZones(providerData.data, false);
                }
                
                // Show provider data in the parent results panel.
                emitProvidersFound(providerData);
            }
            
            // Handle address attachments - only for recent messages to show location on map
            const addressAttachment = attachments.find(att => att.type === 'address_search');
            if (addressAttachment && addressAttachment.data && isRecentMessage) {
                const data = safeParseAttachmentData(addressAttachment.data) || {};
                const places = data.places || [];
                if (places.length > 0) {
                    const firstPlace = places[0];
                    const address = firstPlace.formattedAddress || firstPlace.address;
                    
                    // Emit address found event to show on map
                    if (address) {
                        dispatch('addressFound', {
                            address: address,
                            messageRole: 'attachment_click',
                            placeName: firstPlace.displayName?.text || firstPlace.name || null
                        });
                    }
                }
            }
        }
    }

    async function checkServerHealth() {
      try {
        serverOnline = await checkChatHealth();
        if (!serverOnline) {
          error = "Chat server is currently offline.";
        }
      } catch (e) {
        serverOnline = false;
        error = "Failed to connect to the chat server.";
      }
    }

    async function initializeNewConversation() {
      initializing = true;
      error = null;
      try {
        const { data: newConversation, error: apiError } = await createConversation("New Chat via Frontend");

        if (apiError) {
          throw apiError;
        }

        if (newConversation && newConversation.id) {
          conversationId = newConversation.id;
          console.log("Conversation initialized with ID:", conversationId);
          return true;
        } else {
          throw new Error("Failed to retrieve conversation ID from server.");
        }
      } catch (e) {
        error = `Error initializing conversation: ${e.message}`;
        console.error(error);
        return false;
      } finally {
        initializing = false;
        await tick();
        focusComposerIfAppropriate();
      }
    }

    function focusComposerIfAppropriate() {
      if (!messageInputElement || typeof document === 'undefined' || !shouldRestoreComposerFocus) return;
      const activeElement = document.activeElement;
      const canRestoreFocus =
        !activeElement ||
        activeElement === document.body ||
        activeElement === messageInputElement ||
        activeElement === sendButtonElement;
      if (canRestoreFocus) {
        messageInputElement.focus({ preventScroll: true });
      }
    }

    function trackIntentionalFocusTarget(event) {
      if (!composerElement || !(event.target instanceof Node)) return;
      shouldRestoreComposerFocus = composerElement.contains(event.target);
    }

    function cancelActiveRequest() {
      if (!activeChatController) return;
      statusMessage = 'Response stopped. You can edit or send another message.';
      activeChatController.abort();
    }
  
    onMount(() => {
      checkServerHealth().then(() => {
        if (serverOnline) {
          initializeNewConversation();
        }
      });
      const interval = setInterval(checkServerHealth, 30000);

      // Add keyboard shortcut for debug logging
      const handleKeydown = (e) => {
        if (e.ctrlKey && e.shiftKey && e.key === 'D') {
          e.preventDefault();
          debugLogFullChatHistory();
        }
      };

      window.addEventListener('keydown', handleKeydown);
      document.addEventListener('pointerdown', trackIntentionalFocusTarget, true);

      return () => {
        clearInterval(interval);
        window.removeEventListener('keydown', handleKeydown);
        document.removeEventListener('pointerdown', trackIntentionalFocusTarget, true);
        cleanupRecording();
        activeChatController?.abort();
        activeChatController = null;
        // Clean up auto-play timer on component destroy
        if (autoPlayTimer) {
          clearInterval(autoPlayTimer);
          autoPlayTimer = null;
        }
      };
    });
  
    async function handleSubmit() {
      if (loading || !userInput.trim() || !serverOnline || initializing || !conversationId) {
        if (!conversationId && !initializing) {
            error = "Conversation not initialized. Please wait or refresh.";
        }
        return;
      }

      loading = true;
      isStreaming = true;
      streamingMessage = '';
      currentTool = null;
      error = null;
      statusMessage = '';
      const controller = new AbortController();
      activeChatController = controller;

      const newMessage = {
        role: 'human',
        content: userInput,
        id: `human-${Date.now()}`
      };
      messages = [...messages, newMessage];
      userInput = '';
      scrollToBottom();

      try {
        const { data: chatResponse, error: apiError } = await sendChatMessage(
          conversationId,
          newMessage.content,
          { signal: controller.signal, timeoutMs: 45000 }
        );
        if (apiError) throw apiError;
        if (!chatResponse) throw new Error('The chat server returned no response.');

        // Add final message
        const responseContent = chatResponse?.message || chatResponse?.response || '';
        const pendingAttachments = Array.isArray(chatResponse?.attachments) ? chatResponse.attachments : [];

        // A turn that returns results but no prose still has to render its results.
        const hasProviderResults = Boolean(findProviderResultsAttachment(pendingAttachments));
        const displayContent = responseContent.trim()
          ? responseContent
          : hasProviderResults
            ? 'Here are the results for this trip. The provider details are in the results panel.'
            : '';

        if (displayContent) {
          const finalMessage = {
            role: 'ai',
            content: displayContent,
            id: `ai-${Date.now()}`
          };
          messages = [...messages, finalMessage];

          // Handle attachments
          if (pendingAttachments.length > 0) {
            messageAttachments.set(finalMessage.id, pendingAttachments);
            messageAttachments = messageAttachments;
          }
        }

        // Update the bottom provider bar and the results panel regardless of prose.
        if (pendingAttachments.length > 0) {
          updateLatestProviderResults(pendingAttachments);
        }

        if (!displayContent) {
          throw new Error('The chat server returned an empty response. Please try again.');
        }

        scrollToBottom();

      } catch (e) {
        if (e?.name === 'AbortError' || controller.signal.aborted) {
          statusMessage = statusMessage || 'Response stopped.';
        } else {
          error = e.message;
          console.error('Chat error:', e);
        }
      } finally {
        if (activeChatController === controller) activeChatController = null;
        loading = false;
        isStreaming = false;
        streamingMessage = '';
        currentTool = null;
        await tick();
        focusComposerIfAppropriate();
      }
    }

    
    // Export function to check server status
    export function getServerStatus() {
      return serverOnline;
    }
    
    // Export functions to control example playback
    export function pauseExamplePlayback() {
      if (isViewingExample && isLoadingExample) {
        examplePlaybackPaused = true;
        console.log('Example playback paused');
      }
    }
    
    export function resumeExamplePlayback() {
      if (isViewingExample && examplePlaybackPaused) {
        examplePlaybackPaused = false;
        console.log('Example playback resumed');
        // If we were in the middle of loading, continue from where we left off
        if (currentExampleIndex < totalExampleStates) {
          continueExamplePlayback();
        }
      }
    }
    
    async function continueExamplePlayback() {
      // Load next message from current index, processing system messages but not displaying them
      const conversationStates = currentExample?._conversationStates;
      if (!conversationStates || currentExampleIndex >= conversationStates.length) {
        isLoadingExample = false;
        return;
      }
      
      // Check if paused or not viewing example
      if (examplePlaybackPaused || !isViewingExample) {
        return;
      }
      
      // Process system messages and empty AI messages automatically without displaying them
      while (currentExampleIndex < conversationStates.length) {
        const stateSnapshot = conversationStates[currentExampleIndex];
        const message = stateSnapshot.message;
        const normalizedRole = normalizeChatRole(message.role);
        
        // Skip system messages and empty AI messages
        if (normalizedRole === 'system' || 
            (normalizedRole === 'ai' && (!message.content || message.content.trim() === ''))) {
          // Process message state but don't display the message
          await applyConversationState(stateSnapshot.state);
          currentExampleIndex++;
          continue; // Continue to next message automatically
        } else {
          // This is a user message or AI message with content - display it and stop
          const messageWithId = {
            ...message,
            role: normalizedRole,
            id: message.id || `example-${currentExampleIndex}-${Date.now()}`
          };
          messages = [...messages, messageWithId];
          
          // Apply the conversation state
          await applyConversationState(stateSnapshot.state);
          
          scrollToBottom();
          currentExampleIndex++;
          break; // Stop after displaying one user/AI message
        }
      }
      
      // Check if this was the last message
      if (currentExampleIndex >= conversationStates.length) {
        isLoadingExample = false;
        console.log('Finished loading example conversation with states:', currentExample);
      }
    }
    
    // Example viewing functionality with state reconstruction
    export async function loadExampleWithStates(conversationStates, example) {
      try {
        isViewingExample = true;
        isLoadingExample = true;
        examplePlaybackPaused = false;
        currentExample = { ...example, _conversationStates: conversationStates };
        currentExampleIndex = 0;
        totalExampleStates = conversationStates.length;
        
        // Reset conversation state and clear all messages
        conversationId = null;
        error = null;
        messages = []; // Clear all messages first
        messageAttachments = new Map();
        
        // Load the first message
        await continueExamplePlayback();
        
        // Set loading to false after first message loads
        isLoadingExample = false;
        
      } catch (error) {
        console.error('Error loading example conversation with states:', error);
        isLoadingExample = false;
        throw error;
      }
    }
    
    async function applyConversationState(state) {
      try {
        console.log('Applying conversation state:', state);

        // Handle providers state
        if (state.providers || state.origin || state.destination) {
          console.log('Applying provider state:', state);
          // Send the full state object with providers, origin, destination, etc.
          const providerData = {
            data: state.providers || [],
            source_address: state.source_address,
            destination_address: state.destination_address,
            origin: state.origin,
            destination: state.destination,
            public_transit: state.public_transit
          };
          emitProvidersFound(providerData);

          // For examples, we want providers to show immediately
          if (isViewingExample) {
            console.log('Example mode: Ensuring provider panel shows');
          }
        } else {
          console.log('No providers in state');
        }

        // Skip map updates during example playback to prevent map resetting
        if (!isViewingExample) {
          // Handle map geocoding if needed
          if (state.mapState?.pendingGeocode) {
            console.log('Applying map state:', state.mapState.pendingGeocode);
            // Trigger address geocoding for map updates
            dispatch('addressFound', {
              address: state.mapState.pendingGeocode.origin,
              messageRole: 'system'
            });

            // Small delay before destination
            setTimeout(() => {
              dispatch('addressFound', {
                address: state.mapState.pendingGeocode.destination,
                messageRole: 'system'
              });
            }, 500);
          }

          // Handle individual addresses
          if (state.addresses && state.addresses.length > 0) {
            console.log('Found addresses in state:', state.addresses);
            // Could emit address events for additional map updates if needed
          }
        }

      } catch (error) {
        console.error('Error applying conversation state:', error);
      }
    }

    // ============================================
    // Enhanced Replay Functions (new replay endpoint)
    // ============================================

    /**
     * Load example replay from the new /conversations/{id}/replay endpoint
     * @param {Object} replayData - The replay data from backend containing states and config
     */
    export async function loadExampleReplay(replayData) {
      try {
        console.log('Loading example replay:', replayData);

        // Stop any existing auto-play
        stopAutoPlay();

        // Reset state
        isViewingExample = true;
        isLoadingExample = true;
        messages = [];
        messageAttachments = new Map();
        replayStates = replayData.states || [];
        replayConfig = normalizeReplayConfig(replayData.config || replayData.replay_config || replayData.replayConfig);
        currentStateIndex = 0;
        currentExample = replayData.example || null;
        totalExampleStates = replayStates.length;

        // Apply config defaults
        useTypewriterEffect = replayConfig.typewriter_effect !== false;
        const baseDelayMs = replayConfig.delay_ms || 1500;

        // Clear conversation state
        conversationId = null;
        error = null;

        // Clear service zones and pings
        serviceZoneManager.clearAllServiceZones();
        visibleProviderZones.clear();
        loadingProviderZones.clear();

        // Apply first state if available
        if (replayStates.length > 0) {
          await applyReplayState(replayStates[0]);
          currentStateIndex = 1;
        }

        isLoadingExample = false;

        // Auto-start playback if configured
        if (replayConfig.auto_advance) {
          startAutoPlay(baseDelayMs);
        }

      } catch (err) {
        console.error('Error loading example replay:', err);
        error = `Failed to load example replay: ${err.message}`;
        isLoadingExample = false;
        throw err;
      }
    }

    /**
     * Apply a single replay state to the UI
     * @param {Object} state - The replay state containing message, ui_hints, providers, etc.
     */
    async function applyReplayState(state) {
      try {
        console.log('Applying replay state:', state);

        // Add message to UI if present
        if (state.message) {
          const message = state.message;
          const normalizedRole = normalizeChatRole(message.role);
          const messageId = message.id || `replay-${currentStateIndex}-${Date.now()}`;

          // Only add non-system messages with content
          if (normalizedRole !== 'system' && message.content && message.content.trim() !== '') {
            const messageWithId = {
              ...message,
              role: normalizedRole,
              id: messageId,
              _useTypewriter: useTypewriterEffect && normalizedRole === 'ai'
            };
            messages = [...messages, messageWithId];

            // Attach tool results when replay data includes them.
            if (normalizedRole === 'ai' && Array.isArray(state.attachments) && state.attachments.length > 0) {
              messageAttachments.set(messageId, state.attachments);
              messageAttachments = messageAttachments;
            }
          }
        }

        // Apply UI hints
        if (state.ui_hints) {
          await applyUIHints(state.ui_hints);
        }

        // Apply provider data with full structure including coordinates.
        // Replay states often contain empty provider arrays before the tool result state;
        // don't emit those or the parent panel will show a false "No providers found".
        const snapshot = state.state_snapshot || state;
        const hintData = state.ui_hints?.new_data || {};
        const snapshotProviders = Array.isArray(snapshot.providers) ? snapshot.providers : [];
        const hintProviders = Array.isArray(hintData.providers) ? hintData.providers : [];
        const replayProviders = snapshotProviders.length > 0 ? snapshotProviders : hintProviders;
        const shouldShowReplayProviders =
          replayProviders.length > 0 ||
          state.ui_hints?.show_providers ||
          Boolean(snapshot.origin || snapshot.destination || hintData.origin || hintData.destination);

        if (shouldShowReplayProviders) {
          console.log('Dispatching providers from replay state:', { snapshot, hintData });
          const providerData = {
            data: replayProviders,
            source_address: snapshot.source_address || hintData.source_address,
            destination_address: snapshot.destination_address || hintData.destination_address,
            origin: snapshot.origin || hintData.origin,
            destination: snapshot.destination || hintData.destination,
            public_transit: snapshot.public_transit || hintData.public_transit
          };
          emitProvidersFound(providerData);
        }

        // Apply service zones
        if (state.service_zones && Array.isArray(state.service_zones)) {
          for (const zone of state.service_zones) {
            if (zone.geoJson) {
              serviceZoneManager.addServiceZone({
                type: zone.type || 'provider',
                geoJson: zone.geoJson,
                label: zone.label || 'Service Zone',
                description: zone.description || '',
                metadata: zone.metadata || {},
                config: zone.config || {}
              }, false);
            }
          }
        }

        // Apply map pings
        if (state.pings && Array.isArray(state.pings)) {
          for (const ping of state.pings) {
            dispatch('addPing', ping);
          }
        }

        // Apply map action (pan, zoom, focus)
        if (state.map_action) {
          dispatch('mapAction', state.map_action);
        }

        scrollToBottom();

      } catch (err) {
        console.error('Error applying replay state:', err);
      }
    }

    /**
     * Apply UI hints from replay state
     * @param {Object} hints - UI hints object
     */
    async function applyUIHints(hints) {
      if (!hints) return;

      // Show providers panel
      if (hints.show_providers) {
        // Provider display is handled by the parent results panel callback.
        console.log('UI hint: show_providers');
      }

      // Focus map on area
      if (hints.map_action) {
        dispatch('mapAction', hints.map_action);
      }

      // Highlight specific elements
      if (hints.highlight_tool || hints.highlight) {
        console.log('UI hint: highlight', hints.highlight_tool || hints.highlight);
        // Could add visual highlights to specific UI elements
      }
    }

    // ============================================
    // Auto-Play Control Functions
    // ============================================

    /**
     * Start auto-advancing through replay states
     * @param {number} delayMs - Delay between states in milliseconds (before speed multiplier)
     */
    function startAutoPlay(delayMs = 1500) {
      if (isAutoPlaying) return;
      if (currentStateIndex >= replayStates.length) return;

      isAutoPlaying = true;
      const effectiveDelay = delayMs / playbackSpeed;

      autoPlayTimer = setInterval(async () => {
        if (!isAutoPlaying || currentStateIndex >= replayStates.length) {
          stopAutoPlay();
          return;
        }
        await advanceReplay();
      }, effectiveDelay);

      console.log(`Auto-play started with ${effectiveDelay}ms delay (speed: ${playbackSpeed}x)`);
    }

    /**
     * Stop auto-advancing through replay states
     */
    function stopAutoPlay() {
      if (autoPlayTimer) {
        clearInterval(autoPlayTimer);
        autoPlayTimer = null;
      }
      isAutoPlaying = false;
      console.log('Auto-play stopped');
    }

    /**
     * Advance to the next replay state
     */
    async function advanceReplay() {
      if (currentStateIndex >= replayStates.length) {
        stopAutoPlay();
        return;
      }

      const state = replayStates[currentStateIndex];
      await applyReplayState(state);
      currentStateIndex++;

      // Stop auto-play if we've reached the end
      if (currentStateIndex >= replayStates.length) {
        stopAutoPlay();
      }
    }

    /**
     * Jump to a specific state index (requires replaying from beginning)
     * @param {number} targetIndex - The index to jump to
     */
    async function jumpToState(targetIndex) {
      if (targetIndex < 0 || targetIndex >= replayStates.length) return;

      // Stop auto-play during jump
      const wasAutoPlaying = isAutoPlaying;
      stopAutoPlay();

      // Reset and replay up to target index
      messages = [];
      serviceZoneManager.clearAllServiceZones();
      visibleProviderZones.clear();

      // Replay states up to and including target
      for (let i = 0; i <= targetIndex; i++) {
        await applyReplayState(replayStates[i]);
      }

      currentStateIndex = targetIndex + 1;

      // Resume auto-play if it was active
      if (wasAutoPlaying && currentStateIndex < replayStates.length) {
        const baseDelay = replayConfig?.delay_ms || 1500;
        startAutoPlay(baseDelay);
      }
    }

    /**
     * Toggle auto-play on/off
     */
    function toggleAutoPlay() {
      if (isAutoPlaying) {
        stopAutoPlay();
      } else {
        const baseDelay = replayConfig?.delay_ms || 1500;
        startAutoPlay(baseDelay);
      }
    }

    /**
     * Change playback speed and restart auto-play if active
     * @param {number} speed - New speed multiplier
     */
    function setPlaybackSpeed(speed) {
      playbackSpeed = speed;
      if (isAutoPlaying) {
        stopAutoPlay();
        const baseDelay = replayConfig?.delay_ms || 1500;
        startAutoPlay(baseDelay);
      }
    }
    
    export function startNewConversation() {
      // Stop auto-play if active
      stopAutoPlay();

      isViewingExample = false;
      isLoadingExample = false;
      examplePlaybackPaused = false;
      currentExample = null;
      currentExampleIndex = 0;
      totalExampleStates = 0;

      // Reset enhanced replay state
      replayStates = [];
      currentStateIndex = 0;
      replayConfig = null;

      conversationId = null;
      messages = [{
        role: 'ai',
        content: `Hello! I'm your OPTIMAT transportation assistant. Here's what I can help you with:

**🔍 Find Providers** - Search for paratransit and transportation providers based on your pickup and drop-off locations

**📍 Address Search** - Look up and validate addresses to ensure accurate provider matching

**📋 Provider Details** - Get detailed information about specific providers including contact info, eligibility, and service hours

**🌐 General Questions** - Answer questions about paratransit services, accessibility requirements, and transportation options

How can I assist you today?`,
        id: 'new-conversation-greeting'
      }];
      messageAttachments = new Map();
      
      // Clear service zones when starting new conversation
      serviceZoneManager.clearAllServiceZones();
      visibleProviderZones.clear();
      loadingProviderZones.clear();
      
      // Emit event to notify parent components
      dispatch('newConversationStarted');
      
      // Initialize a new conversation
      if (serverOnline) {
        initializeNewConversation();
      }
    }
    
    function scrollToBottom(smooth = true) {
      // Scroll chat window to bottom
      setTimeout(() => {
        const chatWindow = document.querySelector('.chat-messages');
        if (chatWindow) {
          if (smooth) {
            chatWindow.scrollTo({
              top: chatWindow.scrollHeight,
              behavior: 'smooth'
            });
          } else {
            chatWindow.scrollTop = chatWindow.scrollHeight;
          }
        }
      }, 100);
    }

    function openExampleForm() {
      if (!conversationId) {
        error = "No conversation to save. Please start chatting first.";
        return;
      }
      showExampleForm = true;
      saveExampleSuccess = false;
      exampleForm = {
        title: '',
        description: '',
        category: 'general',
        tags: ''
      };
    }

    function closeExampleForm() {
      showExampleForm = false;
      saveExampleSuccess = false;
      exampleForm = {
        title: '',
        description: '',
        category: 'general',
        tags: ''
      };
    }

    async function saveAsExample() {
      if (!conversationId || savingAsExample) {
        return;
      }

      savingAsExample = true;
      error = null;

      try {
        const tags = exampleForm.tags
          ? exampleForm.tags.split(',').map(tag => tag.trim()).filter(tag => tag.length > 0)
          : [];

        const { data: exampleData, error: apiError } = await saveConversationAsExample(
          conversationId,
          {
            title: exampleForm.title || undefined,
            description: exampleForm.description || undefined,
            category: exampleForm.category,
            tags: tags
          }
        );

        if (apiError) {
          throw apiError;
        }

        console.log('Chat example saved:', exampleData);
        dispatch('exampleSaved', { example: exampleData });

        // Show success state in modal
        saveExampleSuccess = true;

      } catch (e) {
        error = `Error saving example: ${e.message}`;
        console.error('Error saving chat example:', e);
      } finally {
        savingAsExample = false;
      }
    }

</script>
  <div class="flex flex-col h-full bg-background">
    <!-- Top status bar -->
    <div class="flex-shrink-0 border-b border-border/40 px-3 py-2 bg-muted/30">
      <div class="flex items-center justify-between">
        <!-- Left side: status indicators -->
        <div class="flex items-center gap-2">
          {#if !serverOnline}
            <div class="w-2 h-2 rounded-full bg-destructive"></div>
            <span class="text-xs text-muted-foreground">Chat server offline</span>
          {:else if isViewingExample}
            <span class="text-xs text-muted-foreground">Viewing Example</span>
          {:else if conversationId}
            <div class="w-2 h-2 rounded-full bg-green-500"></div>
            <span class="text-xs text-muted-foreground">Active conversation</span>
          {:else}
            <div class="w-2 h-2 rounded-full bg-yellow-500 animate-pulse"></div>
            <span class="text-xs text-muted-foreground">Initializing...</span>
          {/if}
        </div>

        <!-- Right side: action buttons -->
        <div class="flex items-center gap-2">
          {#if isViewingExample}
            <button
	              onclick={startNewConversation}
              class="text-xs text-primary hover:text-primary/80 transition"
            >
              New Chat
            </button>
          {:else if conversationId && !isViewingExample}
            <!-- Save as Example button -->
            <button
	              onclick={openExampleForm}
              class="save-example-btn group flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground hover:text-primary hover:bg-primary/10 rounded-md transition-all duration-200"
              title="Save as Example"
            >
              <svg
                class="w-3.5 h-3.5 transition-transform group-hover:scale-110"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z"
                />
              </svg>
              <span class="hidden sm:inline">Save as Example</span>
            </button>
          {/if}
        </div>
      </div>
    </div>
  
    <!-- Chat messages -->
    <div class="flex-1 overflow-y-auto px-3 py-3 space-y-3 chat-messages scroll-smooth">
      {#each messages.filter(m => (m.role === 'ai' || m.role === 'human') && typeof m.content === 'string' && m.content.trim() !== '') as message, index (message.id || `${message.role}-${index}-${message.content.substring(0, 20)}`)}
        <div
          class="flex gap-2 {message.role === 'human' ? 'justify-end' : 'justify-start'}"
          in:fly={{
            x: message.role === 'human' ? 20 : -20,
            y: 0,
            duration: 300,
            delay: 0
          }}
        >
          {#if message.role === 'ai'}
            <div class="flex-shrink-0 w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center text-xs">
              🤖
            </div>
          {/if}

          <div class="max-w-[75%] {
            message.role === 'human'
              ? 'bg-primary text-primary-foreground rounded-2xl rounded-tr-sm px-3 py-2'
              : 'bg-muted text-foreground rounded-2xl rounded-tl-sm px-3 py-2'
          }">
            {#if message.role === 'human'}
              <p class="text-sm whitespace-pre-wrap">{message.content}</p>
            {:else}
              <!-- AI message with markdown rendering -->
              <div class="text-sm chat-markdown">
                {@html renderMarkdown(message.content)}
              </div>

              {#if hasAttachments(message.id)}
                {@const providerSummary = getProviderSummary(message.id)}
                {@const providerSearchProgress = getProviderSearchProgress(message.id)}
                {@const addressPlaces = getAddressPlaces(message.id)}
                {@const providerInfo = getAttachmentData(message.id, 'provider_info')}
                {@const webSearch = getAttachmentData(message.id, 'web_search')}

                <div class="mt-3 space-y-2">
                  {#if providerSummary}
                    <div class="rounded-lg border border-border/60 bg-background/60 px-3 py-2" aria-label="Provider search results">
                      <div class="flex items-center justify-between gap-3">
                        <div class="text-xs text-muted-foreground">
                          Options found: <span class="font-medium text-foreground">{providerSummary.count}</span>
                          {#if providerSummary.verificationCount > 0}
                            <span class="text-amber-700">
                              · {providerSummary.verificationCount} to verify
                            </span>
                          {/if}
                        </div>
	                        <button
	                          type="button"
	                          class="text-xs px-2 py-1 rounded-md bg-primary/10 text-primary hover:bg-primary/15 transition"
	                          disabled={isViewingExample}
	                          onclick={() => handleMessageClick(message.id)}
	                        >
                          Open results
                        </button>
                      </div>
                      {#if providerSummary.sourceAddress || providerSummary.destinationAddress}
                        <div class="mt-1 text-[11px] text-muted-foreground line-clamp-2">
                          {providerSummary.sourceAddress} → {providerSummary.destinationAddress}
                        </div>
                      {/if}
                    </div>
                  {:else if providerSearchProgress}
                    <div
                      class="rounded-lg border px-3 py-2.5 {providerSearchProgress.state === 'in_progress' ? 'border-blue-200/80 bg-blue-50/70 dark:border-blue-800/70 dark:bg-blue-950/30' : providerSearchProgress.state === 'paused' ? 'border-amber-200/80 bg-amber-50/70 dark:border-amber-800/70 dark:bg-amber-950/30' : 'border-slate-200/80 bg-slate-50/70 dark:border-slate-700/70 dark:bg-slate-900/30'}"
                      aria-label="Provider search status"
                      data-provider-search-state={providerSearchProgress.state}
                    >
                      <div class="flex items-start gap-2.5">
                        <div class="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center" aria-hidden="true">
                          {#if providerSearchProgress.state === 'in_progress'}
                            <div class="h-4 w-4 animate-spin rounded-full border-2 border-blue-500 border-t-transparent"></div>
                          {:else if providerSearchProgress.state === 'paused'}
                            <div class="flex h-4 w-4 items-center justify-center rounded-full bg-amber-500 text-[9px] font-bold text-white">!</div>
                          {:else}
                            <div class="flex h-4 w-4 items-center justify-center rounded-full bg-slate-500 text-[9px] font-bold text-white">×</div>
                          {/if}
                        </div>
                        <div class="min-w-0 flex-1">
                          <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                            <div class="text-xs font-semibold text-foreground">{providerSearchProgress.title}</div>
                            <div class="rounded-full bg-background/80 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                              {providerSearchProgress.badge}
                            </div>
                          </div>
                          <div class="mt-1 text-[11px] leading-4 text-muted-foreground">
                            {providerSearchProgress.detail}
                          </div>
                          <div class="mt-2 flex gap-1" aria-hidden="true">
                            <div class="h-1 flex-1 rounded-full {providerSearchProgress.state === 'paused' ? 'bg-amber-400' : providerSearchProgress.state === 'stopped' ? 'bg-slate-400' : 'bg-blue-500'}"></div>
                            <div class="h-1 flex-1 rounded-full {providerSearchProgress.state === 'in_progress' ? 'animate-pulse bg-blue-300 dark:bg-blue-700' : 'bg-border'}"></div>
                          </div>
                          {#if providerSearchProgress.sourceAddress || providerSearchProgress.destinationAddress}
                            <div class="mt-2 text-[11px] text-muted-foreground line-clamp-2">
                              {providerSearchProgress.sourceAddress} → {providerSearchProgress.destinationAddress}
                            </div>
                          {/if}
                        </div>
                      </div>
                    </div>
                  {/if}

                  {#if addressPlaces.length > 0}
                    <div class="rounded-lg border border-border/60 bg-background/60 px-3 py-2">
                      <div class="text-xs text-muted-foreground mb-1">Addresses</div>
                      <div class="flex flex-col gap-1">
                        {#each addressPlaces.slice(0, 3) as place (place.address)}
                          <button
                            type="button"
                            class="text-left text-xs px-2 py-1 rounded-md bg-muted/60 hover:bg-muted transition"
	                            onclick={() => openAddressPlace(place)}
                          >
                            {#if place.name}
                              <div class="font-medium text-foreground line-clamp-1">{place.name}</div>
                              <div class="text-[11px] text-muted-foreground line-clamp-1">{place.address}</div>
                            {:else}
                              <div class="text-foreground line-clamp-2">{place.address}</div>
                            {/if}
                          </button>
                        {/each}
                      </div>
                    </div>
                  {/if}

                  {#if providerInfo}
                    <details class="rounded-lg border border-border/60 bg-background/60 px-3 py-2">
                      <summary class="cursor-pointer text-xs text-muted-foreground select-none">
                        Provider details
                      </summary>
                      <pre class="mt-2 text-[11px] whitespace-pre-wrap break-words text-muted-foreground">{JSON.stringify(providerInfo, null, 2)}</pre>
                    </details>
                  {/if}

                  {#if webSearch}
                    <details class="rounded-lg border border-border/60 bg-background/60 px-3 py-2">
                      <summary class="cursor-pointer text-xs text-muted-foreground select-none">
                        Web search
                      </summary>
                      {#if typeof webSearch === 'object' && webSearch?.answer}
                        <div class="mt-2 text-xs text-foreground whitespace-pre-wrap">{webSearch.answer}</div>
                        {#if Array.isArray(webSearch.sources) && webSearch.sources.length > 0}
                          <div class="mt-2 space-y-1">
                            {#each webSearch.sources.slice(0, 5) as source, idx (source.url || `${idx}`)}
                              <a
                                class="block text-[11px] text-primary hover:underline line-clamp-1"
                                href={source.url}
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                {source.title || source.url}
                              </a>
                            {/each}
                          </div>
                        {/if}
                      {:else}
                        <pre class="mt-2 text-[11px] whitespace-pre-wrap break-words text-muted-foreground">{JSON.stringify(webSearch, null, 2)}</pre>
                      {/if}
                    </details>
                  {/if}
                </div>
              {/if}
            {/if}
          </div>

          {#if message.role === 'human'}
            <div class="flex-shrink-0 w-7 h-7 rounded-full bg-primary/20 flex items-center justify-center text-xs">
              👤
            </div>
          {/if}
        </div>
      {/each}
  
      {#if loading || isStreaming}
        <div class="flex gap-2 justify-start" in:fade={{ duration: 300 }}>
          <div class="flex-shrink-0 w-7 h-7 rounded-full bg-gradient-to-br from-purple-500/20 to-blue-500/20 flex items-center justify-center text-xs thinking-avatar">
            🧠
          </div>
          <div class="thinking-bubble rounded-2xl rounded-tl-sm px-3 py-2 max-w-[75%]">
            <!-- Show current thought: either tool call or streaming text -->
            {#if currentTool}
              <!-- Current tool being executed -->
              <div class="flex items-center gap-2 text-sm">
                {#if currentTool.status === 'running'}
                  <div class="animate-spin rounded-full h-4 w-4 border-2 border-purple-400 border-t-transparent"></div>
                  <span class="text-purple-600 dark:text-purple-300 font-medium">
                    {#if currentTool.name === 'search_addresses_from_user_query'}
                      🔍 Searching for addresses...
                    {:else if currentTool.name === 'find_providers'}
                      🚌 Finding transportation providers...
                    {:else if currentTool.name === 'get_provider_info'}
                      📋 Looking up provider details...
                    {:else}
                      ⚙️ {currentTool.name}...
                    {/if}
                  </span>
                {:else}
                  <svg class="w-4 h-4 text-green-500" fill="currentColor" viewBox="0 0 20 20">
                    <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/>
                  </svg>
                  <span class="text-green-600 dark:text-green-400 font-medium">
                    {#if currentTool.name === 'search_addresses_from_user_query'}
                      ✓ Found addresses
                    {:else if currentTool.name === 'find_providers'}
                      ✓ Found providers
                    {:else if currentTool.name === 'get_provider_info'}
                      ✓ Got provider info
                    {:else}
                      ✓ {currentTool.name} complete
                    {/if}
                  </span>
                {/if}
              </div>
            {:else if streamingMessage}
              <!-- Streaming AI response -->
              <div class="text-sm prose prose-sm dark:prose-invert max-w-none chat-markdown">
                {@html renderMarkdown(streamingMessage)}
                <span class="typing-cursor inline-block ml-0.5">▊</span>
              </div>
            {:else}
              <!-- Initial thinking indicator -->
              <div class="flex items-center gap-2">
                <div class="flex space-x-1">
                  <div class="w-1.5 h-1.5 bg-purple-500/70 rounded-full animate-bounce" style="animation-delay: 0ms"></div>
                  <div class="w-1.5 h-1.5 bg-purple-500/70 rounded-full animate-bounce" style="animation-delay: 150ms"></div>
                  <div class="w-1.5 h-1.5 bg-purple-500/70 rounded-full animate-bounce" style="animation-delay: 300ms"></div>
                </div>
                <span class="text-sm text-purple-600 dark:text-purple-300 font-medium">Thinking...</span>
              </div>
            {/if}
          </div>
        </div>
      {:else if isLoadingExample}
        <div class="flex gap-2 justify-start" in:fade={{ duration: 300 }}>
          <div class="flex-shrink-0 w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center">
            <div class="animate-spin rounded-full h-3 w-3 border-2 border-primary border-t-transparent"></div>
          </div>
          <div class="bg-muted rounded-2xl rounded-tl-sm px-3 py-2">
            <span class="text-sm text-muted-foreground">Loading example...</span>
          </div>
        </div>
      {/if}

      {#if error}
        <div class="bg-destructive/10 border border-destructive/40 text-destructive p-3 rounded-lg text-sm">
          {error}
        </div>
      {/if}
      {#if statusMessage}
        <div class="bg-muted border border-border/60 text-muted-foreground p-3 rounded-lg text-sm" aria-live="polite">
          {statusMessage}
        </div>
      {/if}
    </div>

    <!-- Input form (hidden during example viewing) -->
    {#if !isViewingExample}
	      <form
	        bind:this={composerElement}
	        onsubmit={(e) => {
	          e.preventDefault();
	          handleSubmit();
	        }}
	        class="flex-shrink-0 border-t border-border/40 bg-card px-3 py-3"
	      >
        <div class="flex gap-2">
          <textarea
            bind:this={messageInputElement}
            bind:value={userInput}
            placeholder={serverOnline ? "Type your message..." : "Chat unavailable"}
            class="flex-1 resize-none rounded-lg border border-border/60 bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary disabled:opacity-50 disabled:cursor-not-allowed min-h-[60px] max-h-[120px]"
            disabled={!serverOnline || initializing}
            aria-busy={loading}
	            onkeydown={(e) => {
	              if (e.key === 'Enter' && !e.shiftKey) {
	                e.preventDefault();
                if (!loading) handleSubmit();
              }
            }}
          ></textarea>
          <button
            type="button"
            onclick={toggleRecording}
            disabled={loading || !serverOnline || initializing || isTranscribing}
            aria-label={isRecording ? 'Stop voice recording' : 'Start voice input'}
            title={isRecording ? 'Stop voice recording' : 'Start voice input'}
            class={`self-end h-10 w-10 shrink-0 rounded-lg border transition flex items-center justify-center focus:outline-none focus:ring-2 focus:ring-primary/50 disabled:opacity-50 disabled:cursor-not-allowed ${
              isRecording
                ? 'border-destructive/50 bg-destructive/10 text-destructive hover:bg-destructive/15'
                : 'border-border/60 bg-background text-muted-foreground hover:bg-muted hover:text-foreground'
            }`}
          >
            {#if isTranscribing}
              <div class="animate-spin rounded-full h-4 w-4 border-2 border-current border-t-transparent"></div>
            {:else if isRecording}
              <SquareIcon size={16} strokeWidth={2.5} />
            {:else}
              <MicIcon size={18} strokeWidth={2.25} />
            {/if}
          </button>
          <button
            bind:this={sendButtonElement}
            type="button"
            onclick={loading ? cancelActiveRequest : handleSubmit}
            disabled={!loading && (!serverOnline || !userInput.trim())}
            aria-label={loading ? 'Stop generating response' : 'Send message'}
            class="self-end px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 focus:outline-none focus:ring-2 focus:ring-primary/50 disabled:opacity-50 disabled:cursor-not-allowed transition text-sm font-medium h-fit"
          >
            {#if loading}
              <div class="flex items-center gap-2">
                <SquareIcon size={13} strokeWidth={2.5} />
                <span>Stop</span>
              </div>
            {:else}
              Send
            {/if}
          </button>
        </div>
        {#if serverOnline}
          <div class="text-[10px] text-muted-foreground mt-1.5 px-1">
            {#if isRecording}
              Recording... press stop when finished
            {:else if isTranscribing}
              Transcribing voice...
            {:else}
              Enter to send · Shift+Enter for new line
            {/if}
          </div>
        {/if}
      </form>
    {:else}
      <!-- Enhanced Playback Controls for example viewing -->
      <div class="flex-shrink-0 border-t border-border/40 bg-card px-3 py-3">
        {#if replayStates.length > 0}
          <!-- New replay endpoint controls -->
          <div class="flex flex-col gap-2">
            <!-- Progress bar and state counter -->
            <div class="flex items-center gap-3">
              <input
                type="range"
                min="0"
                max={replayStates.length - 1}
                bind:value={currentStateIndex}
	                onchange={() => jumpToState(currentStateIndex)}
	                oninput={(e) => { if (!isAutoPlaying) jumpToState(parseInt(e.target.value)); }}
                class="flex-1 h-1.5 bg-muted rounded-lg appearance-none cursor-pointer accent-primary"
                disabled={isAutoPlaying}
              />
              <span class="text-xs text-muted-foreground whitespace-nowrap min-w-[4rem] text-right">
                {Math.min(currentStateIndex + 1, replayStates.length)} / {replayStates.length}
              </span>
            </div>

            <!-- Playback controls row -->
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-2">
                <!-- Play/Pause button -->
                <button
	                  onclick={toggleAutoPlay}
                  disabled={currentStateIndex >= replayStates.length}
                  class="p-2 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition"
                  title={isAutoPlaying ? 'Pause' : 'Play'}
                >
                  {#if isAutoPlaying}
                    <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z"/>
                    </svg>
                  {:else}
                    <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M8 5v14l11-7z"/>
                    </svg>
                  {/if}
                </button>

                <!-- Next button -->
                <button
	                  onclick={advanceReplay}
                  disabled={currentStateIndex >= replayStates.length || isAutoPlaying}
                  class="p-2 rounded-lg bg-muted hover:bg-muted/80 disabled:opacity-50 disabled:cursor-not-allowed transition"
                  title="Next"
                >
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
                  </svg>
                </button>

                <!-- Speed selector -->
                <select
                  bind:value={playbackSpeed}
	                  onchange={(e) => setPlaybackSpeed(parseFloat(e.target.value))}
                  class="text-xs bg-muted border-0 rounded-lg px-2 py-1.5 cursor-pointer focus:ring-1 focus:ring-primary"
                >
                  <option value={0.5}>0.5x</option>
                  <option value={1}>1x</option>
                  <option value={1.5}>1.5x</option>
                  <option value={2}>2x</option>
                </select>
              </div>

              <!-- Status indicator -->
              <div class="flex items-center gap-2">
                {#if currentStateIndex >= replayStates.length}
                  <span class="text-xs text-muted-foreground italic">Example completed</span>
                {:else if isAutoPlaying}
                  <span class="text-xs text-primary flex items-center gap-1">
                    <span class="w-1.5 h-1.5 bg-primary rounded-full animate-pulse"></span>
                    Playing
                  </span>
                {/if}
              </div>
            </div>
          </div>
        {:else}
          <!-- Legacy playback controls (fallback for buildConversationStates) -->
          <div class="flex justify-end">
            {#if currentExampleIndex < totalExampleStates}
              <button
	                onclick={continueExamplePlayback}
                class="px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition text-sm font-medium flex items-center gap-2"
              >
                <span>Continue</span>
                <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
                </svg>
              </button>
            {:else}
              <div class="text-sm text-muted-foreground italic">
                Example completed
              </div>
            {/if}
          </div>
        {/if}
      </div>
    {/if}

    <!-- Save as Example Modal -->
    {#if showExampleForm}
      <!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
      <div
        class="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-[9999]"
	        onclick={closeExampleForm}
	        onkeydown={(e) => {
          if (e.key === 'Escape') {
            closeExampleForm();
          }
        }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        tabindex="0"
        transition:fade={{ duration: 150 }}
      >
        <!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
        <div
          class="bg-card border border-border rounded-xl shadow-xl p-6 w-full max-w-md mx-4"
	          onclick={(e) => e.stopPropagation()}
	          onkeydown={(e) => e.stopPropagation()}
          role="document"
          in:fly={{ y: 20, duration: 200 }}
        >
          {#if saveExampleSuccess}
            <!-- Success state -->
            <div class="text-center py-4">
              <div class="w-16 h-16 mx-auto mb-4 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
                <svg class="w-8 h-8 text-green-600 dark:text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/>
                </svg>
              </div>
              <h3 class="text-lg font-semibold text-foreground mb-2">Example Saved!</h3>
              <p class="text-sm text-muted-foreground mb-6">
                {#if exampleForm.title}
                  "{exampleForm.title}" has been saved to your examples.
                {:else}
                  This conversation has been saved as an example.
                {/if}
              </p>
              <div class="flex justify-center gap-3">
                <button
	                  onclick={closeExampleForm}
                  class="px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors text-sm font-medium"
                >
                  Done
                </button>
              </div>
            </div>
          {:else}
            <!-- Form state -->
            <div class="flex justify-between items-center mb-4">
              <div class="flex items-center gap-2">
                <div class="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
                  <svg class="w-4 h-4 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z"/>
                  </svg>
                </div>
                <h3 id="modal-title" class="text-lg font-semibold text-foreground">Save as Example</h3>
              </div>
              <button
	                onclick={closeExampleForm}
                class="text-muted-foreground hover:text-foreground transition-colors rounded-lg p-1 hover:bg-muted"
                aria-label="Close modal"
              >
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
                </svg>
              </button>
            </div>

            <p class="text-sm text-muted-foreground mb-4">
              Save this conversation as an example for training or demonstration purposes.
            </p>

	            <form onsubmit={(e) => {
	              e.preventDefault();
	              saveAsExample();
	            }} class="space-y-4">
              <div>
                <label for="example-title" class="block text-sm font-medium text-foreground mb-1.5">
                  Title <span class="text-muted-foreground font-normal">(required)</span>
                </label>
                <input
                  id="example-title"
                  type="text"
                  bind:value={exampleForm.title}
                  placeholder="e.g., Finding transit providers in Walnut Creek"
                  required
                  class="w-full px-3 py-2 bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary text-foreground placeholder:text-muted-foreground"
                />
              </div>

              <div>
                <label for="example-category" class="block text-sm font-medium text-foreground mb-1.5">
                  Category
                </label>
                <select
                  id="example-category"
                  bind:value={exampleForm.category}
                  class="w-full px-3 py-2 bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary text-foreground cursor-pointer"
                >
                  {#each exampleCategories as cat}
                    <option value={cat.value}>{cat.label}</option>
                  {/each}
                </select>
              </div>

              <div>
                <label for="example-description" class="block text-sm font-medium text-foreground mb-1.5">
                  Description <span class="text-muted-foreground font-normal">(optional)</span>
                </label>
                <textarea
                  id="example-description"
                  bind:value={exampleForm.description}
                  placeholder="What does this conversation demonstrate?"
                  rows="3"
                  class="w-full px-3 py-2 bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary text-foreground placeholder:text-muted-foreground resize-none"
                ></textarea>
              </div>

              <div>
                <label for="example-tags" class="block text-sm font-medium text-foreground mb-1.5">
                  Tags <span class="text-muted-foreground font-normal">(optional)</span>
                </label>
                <input
                  id="example-tags"
                  type="text"
                  bind:value={exampleForm.tags}
                  placeholder="e.g., booking, accessibility, bart"
                  class="w-full px-3 py-2 bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary text-foreground placeholder:text-muted-foreground"
                />
                <p class="text-xs text-muted-foreground mt-1.5">Separate multiple tags with commas</p>
              </div>

              <div class="flex justify-end gap-3 pt-2">
                <button
                  type="button"
	                  onclick={closeExampleForm}
                  class="px-4 py-2 text-foreground bg-muted hover:bg-muted/80 rounded-lg transition-colors text-sm font-medium"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingAsExample || !exampleForm.title.trim()}
                  class="px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2 text-sm font-medium"
                >
                  {#if savingAsExample}
                    <div class="animate-spin rounded-full h-4 w-4 border-2 border-primary-foreground border-t-transparent"></div>
                    <span>Saving...</span>
                  {:else}
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z"/>
                    </svg>
                    <span>Save Example</span>
                  {/if}
                </button>
              </div>
            </form>
          {/if}
        </div>
      </div>
    {/if}
  </div>

  <style>
    .chat-messages {
      scroll-behavior: smooth;
    }

    @keyframes bounce {
      0%, 80%, 100% {
        transform: translateY(0);
      }
      40% {
        transform: translateY(-10px);
      }
    }

    .typing-cursor {
      display: inline-block;
      animation: blink 1s infinite;
      font-weight: bold;
      margin-left: 1px;
      color: #a855f7;
    }

    @keyframes blink {
      0%, 50% {
        opacity: 1;
      }
      51%, 100% {
        opacity: 0;
      }
    }

    /* Thinking bubble styles */
    .thinking-bubble {
      background: linear-gradient(135deg,
        rgba(168, 85, 247, 0.08) 0%,
        rgba(59, 130, 246, 0.08) 50%,
        rgba(168, 85, 247, 0.08) 100%
      );
      border: 1px solid rgba(168, 85, 247, 0.25);
      box-shadow:
        0 0 15px rgba(168, 85, 247, 0.1),
        0 0 30px rgba(59, 130, 246, 0.05);
      animation: thinking-glow 2s ease-in-out infinite;
    }

    @keyframes thinking-glow {
      0%, 100% {
        box-shadow:
          0 0 15px rgba(168, 85, 247, 0.1),
          0 0 30px rgba(59, 130, 246, 0.05);
        border-color: rgba(168, 85, 247, 0.25);
      }
      50% {
        box-shadow:
          0 0 20px rgba(168, 85, 247, 0.2),
          0 0 40px rgba(59, 130, 246, 0.1);
        border-color: rgba(168, 85, 247, 0.4);
      }
    }

    .thinking-avatar {
      animation: thinking-pulse 2s ease-in-out infinite;
    }

    @keyframes thinking-pulse {
      0%, 100% {
        transform: scale(1);
        opacity: 1;
      }
      50% {
        transform: scale(1.05);
        opacity: 0.9;
      }
    }

    /* Dark mode adjustments for thinking bubble */
    :global(.dark) .thinking-bubble {
      background: linear-gradient(135deg,
        rgba(168, 85, 247, 0.12) 0%,
        rgba(59, 130, 246, 0.12) 50%,
        rgba(168, 85, 247, 0.12) 100%
      );
      border-color: rgba(168, 85, 247, 0.35);
    }

    /* Chat markdown styles with better spacing */
    .chat-markdown {
      line-height: 1.6;
    }

    .chat-markdown :global(p) {
      margin-top: 0.75em;
      margin-bottom: 0.75em;
    }

    .chat-markdown :global(p:first-child) {
      margin-top: 0;
    }

    .chat-markdown :global(p:last-child) {
      margin-bottom: 0;
    }

    .chat-markdown :global(ul),
    .chat-markdown :global(ol) {
      margin-top: 0.75em;
      margin-bottom: 0.75em;
      padding-left: 1.5em;
    }

    .chat-markdown :global(li) {
      margin-top: 0.4em;
      margin-bottom: 0.4em;
    }

    .chat-markdown :global(li p) {
      margin-top: 0.25em;
      margin-bottom: 0.25em;
    }

    .chat-markdown :global(strong) {
      font-weight: 600;
      color: inherit;
    }

    .chat-markdown :global(h1),
    .chat-markdown :global(h2),
    .chat-markdown :global(h3) {
      font-weight: 600;
      margin-top: 1em;
      margin-bottom: 0.5em;
      line-height: 1.3;
    }

    .chat-markdown :global(h1:first-child),
    .chat-markdown :global(h2:first-child),
    .chat-markdown :global(h3:first-child) {
      margin-top: 0;
    }

    .chat-markdown :global(code) {
      background: rgba(0, 0, 0, 0.08);
      padding: 0.15rem 0.35rem;
      border-radius: 0.25rem;
      font-size: 0.85em;
      font-family: ui-monospace, monospace;
    }

    :global(.dark) .chat-markdown :global(code) {
      background: rgba(255, 255, 255, 0.12);
    }

    .chat-markdown :global(pre) {
      background: rgba(0, 0, 0, 0.05);
      padding: 0.75em 1em;
      border-radius: 0.5rem;
      overflow-x: auto;
      margin: 0.75em 0;
    }

    :global(.dark) .chat-markdown :global(pre) {
      background: rgba(255, 255, 255, 0.08);
    }

    .chat-markdown :global(a) {
      color: #3b82f6;
      text-decoration: underline;
    }

    .chat-markdown :global(a:hover) {
      color: #2563eb;
    }

    .chat-markdown :global(blockquote) {
      border-left: 3px solid rgba(168, 85, 247, 0.4);
      padding-left: 1em;
      margin: 0.75em 0;
      color: inherit;
      opacity: 0.9;
    }

    .chat-markdown :global(hr) {
      border: none;
      border-top: 1px solid rgba(0, 0, 0, 0.1);
      margin: 1em 0;
    }

    :global(.dark) .chat-markdown :global(hr) {
      border-top-color: rgba(255, 255, 255, 0.1);
    }

    /* Playback slider styles */
    input[type="range"] {
      -webkit-appearance: none;
      appearance: none;
      background: transparent;
      cursor: pointer;
    }

    input[type="range"]::-webkit-slider-runnable-track {
      height: 6px;
      border-radius: 3px;
      background: hsl(var(--muted));
    }

    input[type="range"]::-webkit-slider-thumb {
      -webkit-appearance: none;
      appearance: none;
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: hsl(var(--primary));
      margin-top: -4px;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
      transition: transform 0.1s ease;
    }

    input[type="range"]::-webkit-slider-thumb:hover {
      transform: scale(1.1);
    }

    input[type="range"]::-moz-range-track {
      height: 6px;
      border-radius: 3px;
      background: hsl(var(--muted));
    }

    input[type="range"]::-moz-range-thumb {
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: hsl(var(--primary));
      border: none;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
      transition: transform 0.1s ease;
    }

    input[type="range"]::-moz-range-thumb:hover {
      transform: scale(1.1);
    }

    input[type="range"]:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    input[type="range"]:disabled::-webkit-slider-thumb {
      background: hsl(var(--muted-foreground));
    }

    input[type="range"]:disabled::-moz-range-thumb {
      background: hsl(var(--muted-foreground));
    }
  </style>
