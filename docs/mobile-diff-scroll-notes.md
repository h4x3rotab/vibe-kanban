# Mobile Diff Scroll Notes

## Symptom

On mobile, horizontal scrolling inside the diff view is unstable:

- the diff content can move horizontally for a short moment
- then it snaps back to the original position
- roughly `1/10` swipe attempts succeeds
- once horizontal scrolling is successfully engaged, it continues to work until the gesture fully stops
- after stopping, the problem usually returns and the user must retry

This is not a simple "horizontal scroll never starts" failure. The stronger signal is that scroll state is being reset after it begins.

## Attempts And Outcomes

### 1. Suppress comment creation after touch drag

Location:

- `packages/web-core/src/pages/workspaces/PierreDiffCard.tsx`

Change:

- recorded touch start position
- treated real movement as a drag
- suppressed line-comment creation after a drag gesture

Reasoning:

- if line tap/comment interaction was stealing the touch sequence, separating tap from drag should let horizontal scroll win

Outcome:

- did not materially help

Why this likely failed:

- the user still observed the diff move briefly and then snap back
- that points more toward scroll position reset than gesture recognition failure

### 2. Apply mobile scroll CSS to the diff code area

Location:

- `packages/web-core/src/pages/workspaces/PierreDiffCard.tsx`

Change:

- applied mobile-oriented CSS to the diff code scroller:
  - `-webkit-overflow-scrolling: touch`
  - `overscroll-behavior-x: contain`
  - `touch-action: pan-x`

Reasoning:

- if the browser was not treating the code pane as the true horizontal scroller, these properties could make the scroller claim the gesture directly

Outcome:

- horizontal scrolling improved from roughly `10%` success to `70%`
- vertical scrolling became broken

Why this likely failed:

- it improved one axis by over-constraining touch behavior
- this indicates we were acting on the wrong layer
- the real issue is not just "allow horizontal pan"; the view also needs normal vertical interaction

### 3. Move mobile comment interaction to the gutter only

Location:

- `packages/web-core/src/pages/workspaces/PierreDiffCard.tsx`

Change:

- desktop kept `onLineClick`
- mobile switched to `onLineNumberClick`
- the code body stopped being the mobile comment target

Reasoning:

- if the code body itself was competing with horizontal dragging, restricting comment interaction to the gutter would separate scroll from comment creation cleanly

Outcome:

- vertical scrolling recovered
- horizontal scrolling returned to the original broken state

Why this likely failed:

- it showed that comment hit-target competition is not the main cause
- comments on the code body were not the dominant source of the snap-back

### 4. Stabilize review context to avoid diff rerenders

Location:

- `packages/web-core/src/shared/hooks/ReviewProvider.tsx`

Change:

- wrapped review actions in `useCallback`
- memoized the provider value with `useMemo`

Reasoning:

- `@pierre/diffs` can force a re-render when option object identities change
- if the diff DOM was being rebuilt during a swipe, that would reset `scrollLeft`

Outcome:

- no user-visible improvement

Why this likely failed:

- review-context churn is not the primary reset trigger
- there may still be rerender/remount activity elsewhere, but this specific source was not enough to explain the issue

### 5. Simulate horizontal dragging in JavaScript

Location:

- `packages/web-core/src/pages/workspaces/PierreDiffCard.tsx`

Change:

- intercepted mobile touch movement
- tried to drive `scrollLeft` manually from touch deltas
- later tried a document-level captured touch sequence so the gesture could continue outside the original element

Reasoning:

- once the reset problem was reduced, this looked like a way to make the diff keep scrolling horizontally for the whole gesture

Outcome:

- this removed the obvious snap-back
- but it only allowed a small amount of horizontal movement at a time
- it felt like artificial drag, not native scrolling

Why this likely failed:

- browser scrolling and application-level drag simulation are different interaction models
- even when technically functional, the result was not faithful native mobile scroll behavior
- this was the wrong abstraction layer

### 6. Move the horizontal scroller out of the shadow-internal code panes

Location:

- `packages/web-core/src/pages/workspaces/PierreDiffCard.tsx`

Change:

- removed the JavaScript touch simulation
- made the outer light-DOM wrapper the horizontal scroller
- rendered the `FileDiff` host with `block min-w-full w-max`
- made inner `[data-code]` panes `overflow: visible` with `width: max-content`
- made `[data-diffs]` itself `width: max-content` with `min-width: 100%`
- kept the scroll-position preservation across shadow DOM rebuilds

Reasoning:

- if the browser can treat a normal light-DOM wrapper as the horizontal scroll container, mobile gets native scrolling behavior again
- this avoids fighting the shadow-internal scroll structure directly

Outcome:

- this worked

Why this worked:

- it changed the ownership of horizontal scrolling, instead of trying to coerce the old owner with CSS or simulated drag
- the browser now scrolls a normal outer container
- the inner diff structure can still rebuild without taking control of the gesture path

## Final Read

The main problem was not comment taps.

The main problem was that the effective horizontal scroll owner was too deep inside the diff widget, and mobile interaction there was unstable. Attempts to patch gesture behavior at the inner layer either:

- did nothing
- improved one axis while breaking the other
- or created non-native drag behavior

The clean fix was to move horizontal scroll ownership to the outer wrapper and let the browser handle it natively.

## Remaining Hypotheses

### 1. Outer list / virtualization is resetting the diff row

Relevant files:

- `packages/ui/src/components/ChangesPanel.tsx`
- `packages/web-core/src/pages/workspaces/ChangesPanelContainer.tsx`

Why it still looks plausible:

- the diff cards live inside `react-virtuoso`
- a remount or DOM replacement at the row level would reset horizontal scroll position
- this fits the observed "scroll starts, then snaps back" behavior better than a pure touch-target bug

### 2. Selection-driven scroll effects are yanking the diff back

Relevant file:

- `packages/web-core/src/pages/workspaces/ChangesPanelContainer.tsx`

Why it still looks plausible:

- the container has effects that call `scrollToIndex` and `scrollIntoView`
- if selection state changes during or immediately after a gesture, it could pull the view back to an anchored position

### 3. The actual scrollable element is not the one we patched

Why it still looks plausible:

- the user can briefly move the diff before it resets
- if an inner element owns horizontal scroll while an outer element rerenders or repositions, patching `[data-code]` alone would not solve the root cause

## Practical Lessons

- Do not simulate drag for this class of problem unless there is no native scroll path left.
- When a mobile nested scroller behaves inconsistently, first verify whether the wrong DOM layer owns scrolling.
- Shadow-DOM-based widgets are much easier to integrate on mobile when the light-DOM wrapper owns the scroll container.
