<script>
  import { onMount, onDestroy, tick } from "svelte";
  import { Plus, AnnotationPlus, FileSearch02 } from "$lib/icons";
  import TabVideoPlayer from "../TabVideoPlayer.svelte";
  import TranscriptTab from "./TranscriptTab.svelte";
  import SelectionPopup from "./SelectionPopup.svelte";
  import { TRANSCRIPT_TAB_ID } from "./transcript-sync.js";
  import {
    readNotesText,
    selectionIsInside,
    planInboundNotesUpdate,
  } from "./notes-editor.js";
  import {
    selectionText,
    selectionRect,
    rectOfRange,
  } from "./selection-popup.js";
  import {
    customPromptActions,
    parsePromptActionId,
    resolveSelectionSurface,
    buildAnnotationAskPayload,
    formatTranscriptForPrompt,
  } from "./selection-annotations.js";
  import { createAnnotationOutbox } from "./annotation-outbox.js";
  import {
    makeAnnotationId,
    MAX_ANNOTATION_TEXT_LEN,
  } from "$lib/research/annotation-sync.js";
  import {
    getNotesTextSize,
    setNotesTextSize,
    SIZES as NOTES_TEXT_SIZES,
  } from "../notes-text-size.js";

  // (payload) => void — JSON-sends over the room WS. The room's single
  // WebSocket connection is owned by the page, not this component.
  export let send = () => {};
  export let clockOffset = 0;

  // This participant's own speech-recognition status — 'stopped' |
  // 'unsupported' | 'starting' | 'running' | 'retrying' (see
  // $lib/research/speech-recognition.js). Deliberately per-browser, never
  // room-shared: whether *you* are being transcribed is your own local
  // fact, same as your own mic selection. Shown as a small dot on the
  // Transcript pill so it's visible without switching to that tab — the
  // same "never let silence stand in for everything's fine" lesson
  // AGENTS.md already states for recording health.
  export let transcriptionStatus = "stopped";

  // Turn Action click → Research Assistant. Local pending lives here so
  // the Block can spin without a room-shared pending card.
  export let onTurnAction = async () => {};

  // turnId -> actionId[] — which Turn Actions have already run on which
  // Block, so their icons disable rather than firing the same question at
  // Research Assistant twice. Room-shared and owned by ResearchPanel (it's
  // derived from `entriesByTab`, replayed to every peer on join — see
  // ResearchPanel.svelte's `doneActionsByTurn` prop), so it survives a
  // refresh; RoomTabs only reads it, via RecordingRoom.svelte's plumbing.
  export let doneActionsByTurn = {};

  let pendingTurnId = null;
  let pendingActionId = null;

  async function handleTurnAction(actionId, turnId) {
    pendingTurnId = turnId;
    pendingActionId = actionId;
    try {
      await onTurnAction(actionId, turnId);
    } finally {
      pendingTurnId = null;
      pendingActionId = null;
    }
  }

  const TRANSCRIPTION_STATUS_LABEL = {
    stopped: "Not transcribing",
    unsupported: "Transcription isn't supported in this browser",
    starting: "Starting transcription…",
    running: "Transcribing your mic",
    retrying: "Transcription lost connection — retrying…",
  };

  const TEXT_DEBOUNCE_MS = 300;

  // ─── Shared room state, driven entirely by inbound WS messages ─────────
  let tabs = []; // [{id, title}], in server order — mirrors the room for everyone
  let activeTabId = null;
  // Flips true once the first tab_state WS message has been applied — the
  // real signal that this peer's shared room state is live, vs. inferring
  // readiness from a DOM element's rendered geometry (e2e tests wait on
  // this rather than racing the Notes surface's visibility).
  let wsReady = false;

  // Per-tab video/text is tracked for *every* tab, not just the active one,
  // because the server broadcasts tab_video/tab_text for whichever tab a
  // peer is acting on — a background tab someone else is loading a video
  // into must already be up to date by the time you switch to it.
  let tabVideos = {}; // tabId -> {videoId,playing,positionSec,positionAtMs} | null

  // tabId -> string. Exported (two-way bound up through RecordingRoom.svelte
  // to +page.svelte, same `bind:` pattern as selectedDeviceId/gainValue)
  // because this is the one place that holds
  // the true, complete, current value for every tab at all times — both
  // this browser's own just-typed (not-yet-broadcast) keystrokes AND every
  // peer's broadcast tab_text. ResearchPanel.svelte reads this directly as
  // a plain prop instead of keeping its own second listener on the
  // tab_text broadcast, which is deliberately asymmetric (excludes the
  // sender, so a typist's own Notes surface isn't clobbered by an echo of
  // its own keystrokes) — lossy for anyone who isn't RoomTabs itself.
  export let tabTexts = {}; // tabId -> string

  // ─── The Notes editing surface (contenteditable, see ADR-0008) ─────────
  // HOW TO GET AT THIS ELEMENT (this file's own refreshSelectionPopup is
  // the first caller — see the highlight → Annotation block below): three
  // equivalent handles, all pointing at the same element, pick whichever
  // suits the caller —
  //   1. `bind:notesEl` on <RoomTabs> — this exported prop is the
  //      component's own `bind:this` target, so a parent binding it gets
  //      the live element (or null while the Transcript is showing, or
  //      before the first tab_state lands). Same pattern as tabTexts.
  //   2. `id="shared-notes-editor"` — a stable, unique document id.
  //   3. `[data-notes-editor]` — for querying without hardcoding the id.
  // It is a real HTMLElement, so getSelection()/getBoundingClientRect()
  // behave normally; `notesEl.contains(selection.anchorNode)` is the
  // "is this selection ours" test (selectionIsInside in notes-editor.js).
  export let notesEl = null;

  // Which tab's text the DOM currently holds, and which tab (if any) has
  // keystrokes still sitting in the outbound debounce. Both feed
  // planInboundNotesUpdate — see notes-editor.js for why.
  let notesDomTabId = null;
  let unsentTabId = null;

  // ─── Highlight → popup → Annotation (ADR-0008, tickets 03 and 05) ──────
  //
  // Highlighting text raises a floating popup next to the highlight. Its
  // actions are Comment (opens a short input; submitting sends
  // `annotation_create`) and one button per configured Custom Prompt, which
  // fires IMMEDIATELY — no compose step at all, because a Custom Prompt is
  // fully self-contained from its saved template (ADR-0008 explicitly
  // rejected pausing for a typed follow-up). A prompt click sends
  // `annotation_ask` and the answer comes back as a Card in the same shared
  // Annotation list the Comments are in.
  //
  // The popup itself is SelectionPopup.svelte — presentational, takes its
  // actions as data and never branches on an id, so both behaviours live
  // here rather than in it.
  //
  // The quote is frozen the moment the highlight is captured and is what
  // gets sent — it is never re-derived from the DOM at submit/fire time, so
  // editing Notes in between cannot change what the Annotation claims was
  // highlighted (CONTEXT.md's **Annotation**). The server re-uses that same
  // frozen quote as `{selection}`.
  //
  // SURFACES, and what ticket 06 has left to do: `selectionSurfaces` below
  // is the list of elements a highlight may come from, each with the tab its
  // Annotation belongs to. Everything downstream of it —
  // resolveSelectionSurface, the quote, the popup, both actions — is
  // element-agnostic (see selection-annotations.js). Registering the
  // Transcript is adding an entry to that array, not a second code path.

  const SELECTION_ACTION_COMMENT = "comment";

  // [{id, title}] — every configured Custom Prompt, id + title only. The
  // template text stays on the server (see ws-rooms.js's annotation_ask).
  export let customPrompts = [];

  // Guest Research Access, resolved by the page — the same value that
  // decides whether Ask is available. Prompt buttons still render without
  // it, disabled, rather than disappearing.
  export let canRunCustomPrompts = false;

  $: selectionActions = [
    {
      id: SELECTION_ACTION_COMMENT,
      label: "Comment",
      title: "Comment on the highlighted text",
      icon: AnnotationPlus,
    },
    ...customPromptActions(customPrompts, {
      canRun: canRunCustomPrompts,
      icon: FileSearch02,
    }),
  ];

  // Every element a highlight may be taken from, with the tab an Annotation
  // made there is filed under. One entry today; ticket 06 adds the
  // Transcript's.
  $: selectionSurfaces =
    notesEl && activeTabId && !viewingTranscript
      ? [{ el: notesEl, tabId: activeTabId }]
      : [];

  // { quote, rect, tabId } — what the popup is anchored to, or null when
  // nothing usable is highlighted. `quote` is the frozen text; `rect` is
  // only geometry and may be re-measured freely; `tabId` is the surface's,
  // captured at highlight time so switching tabs before firing cannot
  // re-file the Annotation under a tab that never held the quote.
  let selectionAnchor = null;
  // A clone of the highlighted Range, kept so the popup can stay anchored
  // after the live selection is gone (clicking into the comment input
  // collapses it). Geometry only — never a source of quote text.
  let anchorRange = null;
  // Which action's follow-up UI is open. While this is set the popup stops
  // tracking the live selection, so focusing the input doesn't dismiss the
  // very popup that input belongs to.
  let openSelectionActionId = null;
  let commentDraft = "";
  let commentInputEl = null;

  const annotationOutbox = createAnnotationOutbox();

  function clearSelectionPopup() {
    selectionAnchor = null;
    anchorRange = null;
    openSelectionActionId = null;
    commentDraft = "";
  }

  function refreshSelectionPopup() {
    // Frozen while an action's follow-up UI is open — see openSelectionActionId.
    if (openSelectionActionId) return;
    if (typeof window === "undefined") return;
    const selection = window.getSelection?.();
    const surface = resolveSelectionSurface(selectionSurfaces, selection);
    if (!surface) {
      selectionAnchor = null;
      anchorRange = null;
      return;
    }
    const quote = selectionText(selection);
    const rect = selectionRect(selection);
    if (!quote || !rect) {
      selectionAnchor = null;
      anchorRange = null;
      return;
    }
    anchorRange = selection.getRangeAt(0).cloneRange();
    selectionAnchor = { quote, rect, tabId: surface.tabId };
  }

  /** Re-measures the anchor after a scroll/resize. The popup is
   *  position:fixed in viewport coordinates, so a scroll that moves the
   *  highlighted text would otherwise leave it pointing at nothing. */
  function repositionSelectionPopup() {
    if (!selectionAnchor || !anchorRange) return;
    const rect = rectOfRange(anchorRange);
    if (!rect) {
      clearSelectionPopup();
      return;
    }
    selectionAnchor = { ...selectionAnchor, rect };
  }

  async function onSelectionAction(actionId) {
    // A Custom Prompt fires on the click itself — no composer, no second
    // confirmation, nothing to type (ADR-0008: "every Custom Prompt fires
    // immediately, fully self-contained from its saved template").
    const customPromptId = parsePromptActionId(actionId);
    if (customPromptId) {
      runCustomPrompt(customPromptId);
      return;
    }
    if (actionId !== SELECTION_ACTION_COMMENT) return;
    openSelectionActionId = SELECTION_ACTION_COMMENT;
    commentDraft = "";
    await tick();
    commentInputEl?.focus();
  }

  /** Fires one Custom Prompt against the current highlight. The Card comes
   *  back over `annotation_entry` like any other Annotation — nothing is
   *  rendered optimistically here, so the panel never shows a row the room
   *  doesn't have. */
  function runCustomPrompt(customPromptId) {
    if (!canRunCustomPrompts) return; // same gate as ws-rooms.js's annotation_ask
    const anchor = selectionAnchor;
    const payload = buildAnnotationAskPayload({
      id: makeAnnotationId(),
      tabId: anchor?.tabId,
      customPromptId,
      // The frozen quote, not a fresh read of the DOM — it is both the
      // Annotation's anchor and `{selection}`'s value.
      quote: anchor?.quote,
      // Placeholder ingredients only. The server keeps just the ones this
      // prompt's own template references and discards the rest before the
      // request is built (see buildCustomPromptRequest) — a prompt written
      // against `{selection}` alone never sees the notes around it.
      currentTab: tabTexts[anchor?.tabId] ?? "",
      transcript: formatTranscriptForPrompt(transcriptLines),
      videoTitle: tabVideoTitles[anchor?.tabId] ?? "",
    });
    if (!payload) return;
    // Same reasoning as a Comment's: send() is a no-op on a dropped socket,
    // and annotation_ask is idempotent by id server-side (a replayed ask
    // re-broadcasts the stored Card and does not spend a second lookup).
    annotationOutbox.track(payload);
    send(payload);
    clearSelectionPopup();
    window.getSelection?.()?.removeAllRanges?.();
  }

  function submitComment() {
    const text = commentDraft.trim();
    const anchor = selectionAnchor;
    if (!text || !anchor?.quote || !anchor?.tabId) return;
    const payload = {
      type: "annotation_create",
      tabId: anchor.tabId,
      id: makeAnnotationId(),
      kind: "comment",
      // The quote captured when the text was highlighted — deliberately
      // not re-read from the DOM here.
      quote: anchor.quote,
      text,
    };
    // Tracked before the send, not after: send() is a no-op on a dropped
    // socket (room-connection.js), and an untracked Comment lost that way
    // would disappear with no error anywhere. See annotation-outbox.js.
    annotationOutbox.track(payload);
    send(payload);
    clearSelectionPopup();
    window.getSelection?.()?.removeAllRanges?.();
  }

  function onCommentKeydown(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      clearSelectionPopup();
    }
  }

  function onDocumentKeydown(e) {
    if (e.key === "Escape" && selectionAnchor) clearSelectionPopup();
  }

  /** A click that lands outside both the popup and the Notes surface means
   *  the person has moved on — an open composer shouldn't follow them
   *  around the page. */
  function onDocumentPointerDown(e) {
    if (!selectionAnchor) return;
    const target = e.target;
    if (target?.closest?.("[data-testid='selection-popup']")) return;
    if (notesEl?.contains?.(target)) return;
    clearSelectionPopup();
  }

  /** The server echoed one of our own Annotations back — it is room state
   *  now, so drop it from the outbox. Routed here by the page alongside
   *  ResearchPanel's own copy (see +page.svelte). */
  export function applyAnnotationEntry(msg) {
    if (msg?.entry?.id) annotationOutbox.acknowledge(msg.entry.id);
  }

  /** A Card's lookup failed. The server clearly has the Annotation (it
   *  stored it, ran the prompt and failed), so this is just as much an
   *  acknowledgement as annotation_entry — re-sending the ask on the next
   *  reconnect would only re-broadcast the same errored row. */
  export function applyAnnotationError(msg) {
    if (msg?.entry?.id) annotationOutbox.acknowledge(msg.entry.id);
  }

  /** Re-announce Comments the server never confirmed, on every successful
   *  connect — AGENTS.md's sync rule, registered via room.registerResync
   *  in +page.svelte rather than hand-rolled here. */
  export function resyncAnnotations() {
    annotationOutbox.resync(send);
  }

  // tabId -> YouTube title, filled from TabVideoPlayer's IFrame API once
  // getVideoData() returns one. Local to this browser (titles aren't on
  // tab_video). Bound up to ResearchPanel so `{current_tab}` can bundle it.
  export let tabVideoTitles = {};

  // The Transcript is a sibling piece of room content, not an entry in
  // `tabs` (see room-state-store.js and ADR-0002) — but "which pill the
  // room is looking at" is still one room-shared value: activeTabId can
  // hold either a real tab's id or the reserved TRANSCRIPT_TAB_ID, and
  // switching to either is broadcast to every peer via the same tab_switch/
  // tabs_state round trip (see room-state-store.js's switchTab). So
  // whether we're showing the Transcript is *derived* from activeTabId,
  // never tracked as separate local-only state.
  let transcriptLines = []; // [{id, speaker, text, at}], server (append) order
  $: viewingTranscript = activeTabId === TRANSCRIPT_TAB_ID;

  let videoPlayerRef = null; // the mounted TabVideoPlayer for activeTabId

  // Room-wide hold-to-talk duck (not per-tab — see applyDuck/resyncDuck).
  let talking = false; // true while *this* browser is holding Talk
  let roomTalking = false; // true while any peer (including us) is holding Talk

  // Room-shared "a transcript_line is probably about to land somewhere in
  // the room" signal (see ws-rooms.js's transcript_activity protocol doc) —
  // set via applyTranscriptActivity, same routing pattern as applyDuck.
  // Deliberately separate from transcriptionStatus above: that prop is
  // this browser's own recognizer health, this is "is anyone's speech
  // being processed right now," true even for a peer whose own browser
  // has no microphone or no Web Speech API support at all.
  let transcriptActivity = false;

  let textDebounceTimer = null;

  // Shared notes text size — a per-browser display preference (like theme),
  // never sent over the WS. See $lib/notes-text-size.js.
  let notesFontSize = 16;

  function setNotesFontSize(size) {
    notesFontSize = size;
    setNotesTextSize(size);
  }

  $: activeVideoPlaying = !!tabVideos[activeTabId]?.playing;

  // HMR / parent remount resets this component's lets to empty, but the WS
  // (owned by the page) may still be open — so we never get the join replay.
  // Ask the server for the room's current tabs/video/text on every mount.
  onMount(() => {
    send({ type: "tabs_sync" });
    notesFontSize = getNotesTextSize();
    // `selectionchange` on document is the only event that fires for every
    // way a selection can appear or vanish — mouse drag, shift-arrow,
    // double-click, select-all, touch handles — so one listener replaces a
    // pile of mouseup/keyup guesses. `true` on scroll to catch the Notes
    // surface's own inner scrolling, not just the window's.
    document.addEventListener("selectionchange", refreshSelectionPopup);
    document.addEventListener("scroll", repositionSelectionPopup, true);
    window.addEventListener("resize", repositionSelectionPopup);
    document.addEventListener("keydown", onDocumentKeydown);
    document.addEventListener("mousedown", onDocumentPointerDown, true);
  });

  onDestroy(() => {
    if (typeof document === "undefined") return;
    document.removeEventListener("selectionchange", refreshSelectionPopup);
    document.removeEventListener("scroll", repositionSelectionPopup, true);
    window.removeEventListener("resize", repositionSelectionPopup);
    document.removeEventListener("keydown", onDocumentKeydown);
    document.removeEventListener("mousedown", onDocumentPointerDown, true);
  });

  // Switching tabs (or to the Transcript) reuses the same Notes element for
  // entirely different text — a popup still anchored to the old tab's
  // highlight would quote text that is no longer on screen.
  let popupTabId = null;
  $: if (activeTabId !== popupTabId) {
    popupTabId = activeTabId;
    clearSelectionPopup();
  }

  // ─── Inbound — called by the page's ws.onmessage, one method per type ──

  export async function applyTabsState(msg) {
    tabs = msg.tabs;
    activeTabId = msg.activeTabId;
    wsReady = true;
    // The active tab's player just (re)mounted (see {#key} below) — bring
    // it up to date with whatever we already know about that tab's video.
    await tick();
    pushActiveVideoToPlayer();
  }

  export function applyTabVideo(msg) {
    tabVideos = {
      ...tabVideos,
      [msg.tabId]: msg.videoId
        ? {
            videoId: msg.videoId,
            playing: msg.playing,
            positionSec: msg.positionSec,
            positionAtMs: msg.positionAtMs,
          }
        : null,
    };
    if (!msg.videoId && tabVideoTitles[msg.tabId]) {
      const next = { ...tabVideoTitles };
      delete next[msg.tabId];
      tabVideoTitles = next;
    }
    if (msg.tabId === activeTabId) videoPlayerRef?.applyState?.(msg);
  }

  function rememberVideoTitle(title) {
    if (!activeTabId || viewingTranscript) return;
    const t = String(title || "").trim();
    if (!t || tabVideoTitles[activeTabId] === t) return;
    tabVideoTitles = { ...tabVideoTitles, [activeTabId]: t };
  }

  export function applyTabText(msg) {
    tabTexts = { ...tabTexts, [msg.tabId]: msg.text };
  }

  export function applyTranscriptState(msg) {
    transcriptLines = msg.lines;
  }

  export function applyTranscriptLine(msg) {
    transcriptLines = [
      ...transcriptLines,
      { id: msg.id, speaker: msg.speaker, text: msg.text, at: msg.at },
    ];
  }

  export function applyDuck(msg) {
    roomTalking = !!msg.talking;
  }

  /** Re-announce a held Talk after a WS reconnect. */
  export function resyncDuck() {
    if (talking) send({ type: "yt_duck", talking: true });
  }

  export function applyTranscriptActivity(msg) {
    transcriptActivity = !!msg.active;
  }

  function pushActiveVideoToPlayer() {
    if (!videoPlayerRef || !activeTabId || viewingTranscript) return;
    const v = tabVideos[activeTabId];
    videoPlayerRef.applyState(
      v
        ? { tabId: activeTabId, ...v, triggerAtMs: Date.now() + clockOffset }
        : { tabId: activeTabId, videoId: "" },
    );
  }

  // ─── Outbound — tab structure ───────────────────────────────────────────

  function makeTabId() {
    return (
      "tab-" +
      Math.random().toString(36).slice(2, 10) +
      Math.random().toString(36).slice(2, 6)
    );
  }

  function addTab() {
    send({ type: "tab_create", tabId: makeTabId() });
  }

  // Handles switching to a real tab OR to the Transcript — both go over the
  // wire as the same 'tab_switch' message (room-state-store.js's switchTab
  // accepts the reserved TRANSCRIPT_TAB_ID as a valid destination), so
  // "which pill the room is looking at" is one shared value, broadcast to
  // every peer exactly like switching to any real tab already was.
  function switchTab(tabId) {
    if (tabId === activeTabId) return;
    send({ type: "tab_switch", tabId });
  }

  function switchToTranscript() {
    switchTab(TRANSCRIPT_TAB_ID);
  }

  function closeTab(tabId, event) {
    event?.stopPropagation();
    send({ type: "tab_close", tabId });
  }

  // ─── Inbound — painting the shared text onto the Notes surface ──────────
  // The <textarea> this replaced had a `value={...}` binding, which only
  // touched the DOM when the bound value actually changed — so an unrelated
  // peer's broadcast landing mid-keystroke never disturbed a typist. A
  // contenteditable gets no such binding: assigning on every inbound
  // broadcast would fight the local cursor. planInboundNotesUpdate() is
  // that guard, made explicit and testable (see notes-editor.js).

  $: notesText =
    !viewingTranscript && activeTabId ? (tabTexts[activeTabId] ?? "") : "";
  // `notesEl` is listed so this re-runs the moment bind:this fills it in.
  $: syncNotesSurface(notesEl, activeTabId, notesText);

  function syncNotesSurface(el, tabId, text) {
    if (!el || !tabId) return;
    const tabChanged = tabId !== notesDomTabId;
    const { write, cancelUnsent } = planInboundNotesUpdate({
      domText: readNotesText(el),
      nextText: text,
      tabChanged,
      hasUnsentLocalEdit: unsentTabId === tabId,
      selectionInside: selectionIsInside(
        el,
        typeof window === "undefined" ? null : window.getSelection?.(),
      ),
    });
    if (write) el.textContent = text;
    if (cancelUnsent) {
      clearTimeout(textDebounceTimer);
      textDebounceTimer = null;
      unsentTabId = null;
    }
    notesDomTabId = tabId;
  }

  // ─── Outbound — shared text (last write wins) ───────────────────────────
  // Debounced so typing doesn't flood the socket. The server never echoes a
  // tab_text back to its sender, so this browser's own Notes surface is
  // never clobbered mid-keystroke; a concurrent edit from the *other* peer
  // can still overwrite unsent local keystrokes — an accepted trade-off for
  // a basic, no-save-state shared surface (no operational transform here).

  function onNotesInput(e) {
    const tabId = activeTabId;
    if (!tabId) return;
    const text = readNotesText(e.currentTarget);
    tabTexts = { ...tabTexts, [tabId]: text };
    notesDomTabId = tabId;
    unsentTabId = tabId;
    clearTimeout(textDebounceTimer);
    textDebounceTimer = setTimeout(() => {
      textDebounceTimer = null;
      if (unsentTabId === tabId) unsentTabId = null;
      send({ type: "tab_text", tabId, text });
      // We just made this the last write, so the model has to agree with
      // what we broadcast. Without this, a peer edit that landed mid-typing
      // (and was deliberately not painted over the caret) would linger in
      // `tabTexts` — the room would hold our text while ResearchPanel and a
      // later re-render still read theirs.
      tabTexts = { ...tabTexts, [tabId]: text };
    }, TEXT_DEBOUNCE_MS);
  }

  // A textarea only ever held plain text. A contenteditable would happily
  // swallow pasted HTML — fonts, colours, links — and then broadcast that
  // markup's rendered text while showing something else. Force plain text
  // so pasting looks exactly like it did before.
  function onNotesPaste(e) {
    const text = e.clipboardData?.getData("text/plain");
    if (text == null) return;
    e.preventDefault();
    // Deprecated, but the only cross-browser insert that keeps both the
    // caret and the native undo stack — and it fires `input`, so the
    // debounced send above runs as usual.
    const inserted = document.execCommand?.("insertText", false, text);
    if (inserted) return;
    // Fallback for a host without execCommand: splice the text in by hand,
    // then drive the same outbound path the input event would have.
    const sel = window.getSelection?.();
    const el = e.currentTarget;
    if (sel?.rangeCount) {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      const node = document.createTextNode(text);
      range.insertNode(node);
      range.setStartAfter(node);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    } else {
      el.textContent = readNotesText(el) + text;
    }
    onNotesInput({ currentTarget: el });
  }

  // ─── Outbound — hold-to-talk (room-wide, not per-tab) ───────────────────

  function startTalk(e) {
    e.currentTarget.setPointerCapture(e.pointerId);
    if (talking) return;
    talking = true;
    send({ type: "yt_duck", talking: true });
  }

  function endTalk() {
    if (!talking) return;
    talking = false;
    send({ type: "yt_duck", talking: false });
  }
</script>

<div class="room-tabs" data-ws-ready={wsReady}>
  <div class="tab-strip">
    {#each tabs as tab (tab.id)}
      <div class="tab-pill" class:active={tab.id === activeTabId}>
        <button
          type="button"
          class="tab-title"
          aria-label={tab.title}
          on:click={() => switchTab(tab.id)}
        >
          {tab.title}
        </button>
        {#if tabs.length > 1}
          <button
            type="button"
            class="btn-ghost btn-sm btn-icon tab-close"
            aria-label="Close {tab.title}"
            on:click={(e) => closeTab(tab.id, e)}
          >
            &times;
          </button>
        {/if}
      </div>
    {/each}
    <div class="tab-pill transcript-pill" class:active={viewingTranscript}>
      <button
        type="button"
        class="tab-title"
        aria-label="Transcript"
        on:click={switchToTranscript}
      >
        Transcript
        {#if transcriptionStatus !== "stopped"}
          <span
            class="transcription-status-dot"
            data-status={transcriptionStatus}
            title={TRANSCRIPTION_STATUS_LABEL[transcriptionStatus]}
            aria-label={TRANSCRIPTION_STATUS_LABEL[transcriptionStatus]}
          ></span>
        {/if}
        {#if transcriptActivity}
          <span
            class="transcript-activity-pulse"
            title="Transcript incoming…"
            aria-label="Transcript incoming…"
          ></span>
        {/if}
      </button>
    </div>
    <button
      type="button"
      class="btn-ghost btn-icon"
      on:click={addTab}
      aria-label="Add tab"
      title="Add tab"><Plus /></button
    >
  </div>

  <div class="tab-content">
    {#if viewingTranscript}
      <TranscriptTab
        lines={transcriptLines}
        {pendingTurnId}
        {pendingActionId}
        {doneActionsByTurn}
        onTurnAction={handleTurnAction}
      />
    {:else if activeTabId}
      <div class="shared-notes">
        
        <div class="notes-toolbar-2">
          {#key activeTabId}
            <TabVideoPlayer
              tabId={activeTabId}
              {send}
              {clockOffset}
              {talking}
              {roomTalking}
              reportVideoTitle={rememberVideoTitle}
              bind:this={videoPlayerRef}
            >
              <svelte:fragment slot="controls-left">
                {#if activeVideoPlaying}
                  <button
                    type="button"
                    class="btn-secondary talk-btn"
                    class:is-active={talking}
                    aria-pressed={talking}
                    title="Hold to lower your local video volume"
                    on:pointerdown={startTalk}
                    on:pointerup={endTalk}
                    on:pointercancel={endTalk}
                    on:lostpointercapture={endTalk}
                    on:contextmenu|preventDefault
                  >
                    Talk
                  </button>
                {/if}
              </svelte:fragment>
            </TabVideoPlayer>
          {/key}
        </div>
        
        <div class="notes-toolbar-1">
          <span class="notes-toolbar-label">Text size</span>
          <div
            class="text-size-group"
            role="group"
            aria-label="Notes text size"
          >
            {#each NOTES_TEXT_SIZES as size (size)}
              <button
                type="button"
                class="btn-ghost btn-sm text-size-btn"
                class:is-active={notesFontSize === size}
                aria-pressed={notesFontSize === size}
                on:click={() => setNotesFontSize(size)}
              >
                {size}
              </button>
            {/each}
          </div>
        </div>


        <!-- The Notes editing surface. A contenteditable rather than a
             <textarea> (ADR-0008) so a later ticket can anchor a popup to
             an arbitrary highlighted span of it — see the `notesEl` block
             at the top of this file for how to get hold of the element.
             Its text is painted by syncNotesSurface(), never by a
             `value={...}`-style binding. -->
        <div
          id="shared-notes-editor"
          data-notes-editor
          class="shared-notes-editor"
          class:is-empty={notesText === ""}
          style="font-size: {notesFontSize}px"
          contenteditable="true"
          role="textbox"
          aria-multiline="true"
          aria-label="Shared notes — visible to everyone in the room…"
          aria-placeholder="Share notes between you and your guests…"
          data-placeholder="Share notes between you and your guests…"
          bind:this={notesEl}
          on:input={onNotesInput}
          on:paste={onNotesPaste}
        ></div>
      </div>

      <!-- Anchored to the highlight, not to this container — it is
           position: fixed in viewport coordinates (see SelectionPopup.svelte
           / selection-popup.js). Ticket 05 adds its Custom Prompt buttons by
           extending `selectionActions`, not by adding markup here. -->
      <SelectionPopup
        rect={selectionAnchor?.rect ?? null}
        actions={selectionActions}
        openActionId={openSelectionActionId}
        onAction={onSelectionAction}
        ariaLabel="Actions for the highlighted notes text"
      >
        {#if openSelectionActionId === SELECTION_ACTION_COMMENT}
          <form
            class="selection-comment"
            on:submit|preventDefault={submitComment}
          >
            <p class="selection-comment-quote" title={selectionAnchor?.quote}>
              “{selectionAnchor?.quote ?? ""}”
            </p>
            <div class="selection-comment-row">
              <input
                type="text"
                class="selection-comment-input"
                data-testid="selection-comment-input"
                placeholder="Add a comment…"
                aria-label="Comment on the highlighted text"
                maxlength={MAX_ANNOTATION_TEXT_LEN}
                bind:this={commentInputEl}
                bind:value={commentDraft}
                on:keydown={onCommentKeydown}
              />
              <button
                type="submit"
                class="btn-secondary btn-sm"
                disabled={!commentDraft.trim()}
              >
                Comment
              </button>
            </div>
          </form>
        {/if}
      </SelectionPopup>
    {:else}
      <p class="tab-content-empty">Connecting…</p>
    {/if}
  </div>
</div>

<style>
  .selection-comment {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 240px;
  }

  /* The frozen quote, shown so it's obvious what the comment will be
     attached to. Clamped rather than scrolled — the popup is a small
     floating card, not a reading surface. */
  .selection-comment-quote {
    margin: 0;
    padding: 0 2px;
    font-size: 12px;
    font-style: italic;
    color: var(--muted);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .selection-comment-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .selection-comment-input {
    flex: 1;
    min-width: 0;
    padding: 5px 8px;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--bg-elevated);
    color: var(--text);
    font-size: 13px;
  }

  .selection-comment-input:focus {
    outline: none;
    border-color: var(--accent);
  }

  .room-tabs {
    display: flex;
    flex-direction: column;
    gap: 12px;
    max-width: 750px;
    margin-right: auto;
    margin-left: auto;
  }

  .tab-strip {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .notes-toolbar-1 {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .tab-pill {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 4px 2px 4px 12px;
    height: 30px;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: var(--bg-elevated);
    color: var(--muted);
    font-size: 13px;
  }
  .tab-pill.active {
    background: var(--accent);
    color: #fff;
    border-color: var(--accent);
  }
  .tab-pill.active .tab-close,
  .tab-pill.active .tab-close:hover {
    color: #fff;
    background: transparent;
  }

  .tab-title {
    background: none;
    border: none;
    padding: 0 12px 0 0;
    color: inherit;
    font: inherit;
    cursor: pointer;
    width: 100%;
    text-align: center;
  }

  .transcription-status-dot {
    display: inline-block;
    width: 7px;
    height: 7px;
    margin-left: 5px;
    border-radius: 50%;
    vertical-align: middle;
    background: var(--muted);
  }
  .transcription-status-dot[data-status="running"] {
    background: var(--success);
  }
  .transcription-status-dot[data-status="starting"] {
    background: var(--warn);
  }
  .transcription-status-dot[data-status="retrying"] {
    background: var(--danger);
    box-shadow: 0 0 4px var(--danger);
  }

  /* Room-shared "something's coming" signal — deliberately a different hue
     and a pulse (not a solid fill) from transcription-status-dot above, so
     "my mic's recognizer is healthy" and "someone's speech is being
     processed right now" never read as the same fact at a glance. */
  .transcript-activity-pulse {
    display: inline-block;
    width: 7px;
    height: 7px;
    margin-left: 5px;
    border-radius: 50%;
    vertical-align: middle;
    background: var(--accent);
    animation: transcript-activity-pulse 1s ease-in-out infinite;
  }
  @keyframes transcript-activity-pulse {
    0%, 100% { opacity: 0.35; transform: scale(0.85); }
    50% { opacity: 1; transform: scale(1.15); }
  }

  /* Nested inside the already-bordered .tab-pill — no second border. */
  .tab-close {
    border-color: transparent;
    opacity: 0.7;
    width: 24px;
    height: 24px;
    display: flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
  }
  .tab-close:hover {
    opacity: 1;
  }

  .tab-content {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .tab-content-empty {
    color: var(--muted);
    font-size: 13px;
  }

  /* Press-and-hold control, not a click toggle — kept visually distinct
     from a plain secondary button via letter-spacing/uppercase, but same
     weight/size as Play so it doesn't compete with Start Recording. */
  .talk-btn {
    margin-right: auto;
    min-width: 88px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    user-select: none;
    touch-action: none;
  }

  .notes-toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .notes-toolbar-label {
    font-size: 12px;
    color: var(--muted);
  }

  .text-size-group {
    display: flex;
    gap: 2px;
  }

  .text-size-btn {
    min-width: 30px;
    font-variant-numeric: tabular-nums;
  }
  .text-size-btn.is-active {
    background: var(--bg-elevated);
    border-color: var(--accent);
    color: var(--text);
  }

  .shared-notes {
    padding: 16px;
    border-radius: 10px;
    border: 1px solid var(--border);
    background: var(--bg-elevated);
    color: var(--text);
    font-family: inherit;
    line-height: 1.5;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .shared-notes:focus-within {
    outline: none;
    border-color: var(--accent);
  }
  .shared-notes-editor {
    width: 100%;
    min-height: 80vh;
    font-size: 16px;
    line-height: 1.5;
    font-family: inherit;
    color: inherit;
    background: transparent;
    border: none;
    outline: none;
    cursor: text;
    /* A textarea wrapped long lines and honoured every newline the user
       typed; a plain block would collapse both. */
    white-space: pre-wrap;
    overflow-wrap: break-word;
  }
  .shared-notes-editor:focus-within {
    outline: none;
    border-color: var(--accent);
  }
  /* The `placeholder` attribute a textarea had. Driven by a class rather
     than :empty — a contenteditable the user has emptied usually still
     holds a stray <br>, which :empty would not match. */
  .shared-notes-editor.is-empty::before {
    content: attr(data-placeholder);
    color: var(--muted);
    pointer-events: none;
  }
</style>
