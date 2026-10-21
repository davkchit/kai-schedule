import { useEffect, useRef } from 'react';

// Swiping between days on the phone's day view, the way native apps feel:
// the day under the finger follows it 1:1, resists at the first and last day
// instead of stopping dead, and on release the gesture's speed decides —
// a quick flick turns the page even when short, a slow drag only past a third
// of the width. The next day then arrives from where the finger left the old
// one, so there is no seam between dragging and animating.
//
// Only transform is touched, written straight to the element (no React render
// per frame). Vertical scrolling stays the browser's: the container has
// touch-action: pan-y, and a gesture that starts vertical is left alone.

const LOCK_DISTANCE = 10;
const COMMIT_SHARE = 0.3;
// Apple's projection of where a flick would come to rest (Designing Fluid Interfaces).
const DECELERATION = 0.998;
const project = (velocityPerSecond) => ((velocityPerSecond / 1000) * DECELERATION) / (1 - DECELERATION);
// Past an edge the page follows less and less, like a real thing slowing before it stops.
const rubberband = (offset, width, constant = 0.55) => (offset * width * constant) / (width + constant * Math.abs(offset));

/**
 * containerRef — the whole day view, the swipe area: the day panels
 * (.day-schedule, the shown one has .active) are inside it, and so is the
 * empty space below a short day. Children marked data-swipe-ignore (the tab
 * strip) keep their own horizontal scrolling. canGo(direction) says whether a day exists that way
 * ('next' = to the left, 'prev' = to the right); onCommit(direction, fromPx)
 * switches the day, fromPx being where the new day should start its entry.
 */
export function useDaySwipe(containerRef, { enabled, canGo, onCommit }) {
    // The latest callbacks without re-binding the listeners on every render.
    const handlers = useRef({ canGo, onCommit });
    handlers.current = { canGo, onCommit };

    useEffect(() => {
        const container = containerRef.current;

        if (!container || !enabled) {
            return undefined;
        }

        let gesture = null;

        function panel() {
            return container.querySelector('.day-schedule.active');
        }

        function onDown(event) {
            // The tab strip scrolls sideways on its own; a swipe there is not a day turn.
            if (event.pointerType === 'mouse' || !event.isPrimary || event.target.closest?.('[data-swipe-ignore]')) {
                return;
            }

            gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, axis: null, offset: 0, history: [], el: panel() };
        }

        function onMove(event) {
            if (!gesture || event.pointerId !== gesture.id || !gesture.el) {
                return;
            }

            const dx = event.clientX - gesture.x;
            const dy = event.clientY - gesture.y;

            if (!gesture.axis) {
                if (Math.abs(dx) > LOCK_DISTANCE && Math.abs(dx) > Math.abs(dy) * 1.2) {
                    gesture.axis = 'x';
                    gesture.width = container.clientWidth || 1;
                    gesture.el.style.transition = 'none';
                    container.setPointerCapture?.(event.pointerId);
                } else if (Math.abs(dy) > LOCK_DISTANCE) {
                    gesture = null; // a scroll, not a swipe
                    return;
                } else {
                    return;
                }
            }

            const direction = dx < 0 ? 'next' : 'prev';
            gesture.offset = handlers.current.canGo(direction) ? dx : rubberband(dx, gesture.width);
            gesture.el.style.transform = `translate3d(${gesture.offset}px, 0, 0)`;
            gesture.history.push({ x: event.clientX, t: event.timeStamp });
            if (gesture.history.length > 6) gesture.history.shift();
        }

        function settleBack(el) {
            el.style.transition = 'transform 0.34s var(--ease-spring, cubic-bezier(0.22, 1, 0.36, 1))';
            el.style.transform = '';
            el.addEventListener('transitionend', () => { el.style.transition = ''; }, { once: true });
        }

        function onUp(event) {
            if (!gesture || event.pointerId !== gesture.id) {
                return;
            }

            const { el, axis, offset, width, history } = gesture;
            gesture = null;

            if (axis !== 'x' || !el) {
                return;
            }

            const first = history[0];
            const last = history[history.length - 1];
            const velocity = first && last && last.t > first.t ? ((last.x - first.x) / (last.t - first.t)) * 1000 : 0;
            const projected = offset + project(velocity);
            const direction = projected < 0 ? 'next' : 'prev';
            // The direction of travel at release decides, not just the distance:
            // dragged far then pulled back means "stay".
            const turned = event.type !== 'pointercancel'
                && Math.abs(projected) > width * COMMIT_SHARE
                && Math.sign(velocity || offset) === Math.sign(projected)
                && handlers.current.canGo(direction);

            if (!turned) {
                settleBack(el);
                return;
            }

            el.style.transition = '';
            el.style.transform = '';
            // The new day enters from just beyond where the old one was let go.
            handlers.current.onCommit(direction, direction === 'next' ? offset + width : offset - width);
        }

        container.addEventListener('pointerdown', onDown);
        container.addEventListener('pointermove', onMove);
        container.addEventListener('pointerup', onUp);
        container.addEventListener('pointercancel', onUp);

        return () => {
            container.removeEventListener('pointerdown', onDown);
            container.removeEventListener('pointermove', onMove);
            container.removeEventListener('pointerup', onUp);
            container.removeEventListener('pointercancel', onUp);
        };
    }, [containerRef, enabled]);
}
