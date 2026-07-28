/**
 * Copyright (c) Microsoft Corporation.
 * Licensed under the Apache License, Version 2.0.
 */

type CursorMessage = {
  type: 'tyrs.cursor';
  action: 'move' | 'press' | 'release' | 'wheel' | 'thinking' | 'hide' | 'prepare';
  x?: number;
  y?: number;
  key?: string;
  visual?: boolean;
};

type Gesture = {
  kind: string;
  x?: number;
  y?: number;
  key?: string;
  armedAt: number;
  expiresAt: number;
};

declare global {
  interface Window {
    __tyrsCursorInstalled?: boolean;
  }
}

if (!window.__tyrsCursorInstalled) {
  window.__tyrsCursorInstalled = true;
  installCursor();
}

function installCursor(): void {
  const host = document.createElement('div');
  host.dataset.tyrsCursor = 'true';
  Object.assign(host.style, {
    all: 'initial',
    position: 'fixed',
    inset: '0',
    zIndex: '2147483647',
    pointerEvents: 'none',
    overflow: 'hidden',
  });
  (document.documentElement || document).appendChild(host);
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      :host { all: initial }
      #cursor {
        position: fixed; left: 0; top: 0; width: 46px; height: 48px;
        transform: translate3d(-80px,-80px,0); transform-origin: 8px 7px;
        opacity: 0; will-change: transform, opacity, filter;
        filter: drop-shadow(0 0 5px rgba(37,99,235,.8));
        transition: opacity 90ms linear, filter 120ms ease;
      }
      #cursor.visible { opacity: 1 }
      #cursor.thinking { animation: tyrs-pulse 920ms ease-in-out infinite }
      #cursor.pressed { filter: drop-shadow(0 0 9px rgba(37,99,235,1)); }
      @keyframes tyrs-pulse {
        0%,100% { filter: drop-shadow(0 0 4px rgba(37,99,235,.55)); }
        50% { filter: drop-shadow(0 0 11px rgba(37,99,235,1)); }
      }
    </style>
    <div id="cursor" aria-hidden="true">
      <svg width="46" height="48" viewBox="0 0 46 48" fill="none">
        <path d="M6 4.5L35.5 27.2L20.1 28.9L13.2 42.2L6 4.5Z"
          fill="#111827" stroke="white" stroke-width="3.2" stroke-linejoin="round"/>
        <path d="M20.4 28.7L29.2 41.4" stroke="#111827" stroke-width="6.2"
          stroke-linecap="round"/>
        <path d="M20.4 28.7L29.2 41.4" stroke="white" stroke-width="2.2"
          stroke-linecap="round"/>
      </svg>
    </div>`;

  const cursor = root.querySelector<HTMLDivElement>('#cursor')!;
  let x = -80;
  let y = -80;
  let rotation = 0;
  let gesture: Gesture | undefined;
  let animation: number | undefined;

  const render = (scaleX = 1, scaleY = 1) => {
    cursor.style.transform = `translate3d(${x - 6}px,${y - 5}px,0) rotate(${rotation}deg) scale(${scaleX},${scaleY})`;
  };

  const move = async (nextX: number, nextY: number, visual: boolean): Promise<void> => {
    cursor.classList.add('visible');
    if (!visual) {
      x = nextX;
      y = nextY;
      render();
      return;
    }
    if (animation !== undefined)
      cancelAnimationFrame(animation);
    const fromX = x < -40 ? nextX - 14 : x;
    const fromY = y < -40 ? nextY - 10 : y;
    const dx = nextX - fromX;
    const dy = nextY - fromY;
    const distance = Math.hypot(dx, dy);
    const duration = Math.min(440, Math.max(120, 95 + distance * 0.42));
    rotation = Math.max(-10, Math.min(10, Math.atan2(dy, Math.max(1, Math.abs(dx))) * 7));
    const started = performance.now();
    await new Promise<void>(resolve => {
      const tick = (now: number) => {
        const progress = Math.min(1, (now - started) / duration);
        const eased = 1 - Math.pow(1 - progress, 3);
        const arc = Math.sin(progress * Math.PI) * Math.min(18, distance * .07);
        x = fromX + dx * eased;
        y = fromY + dy * eased - arc;
        render(1 + Math.sin(progress * Math.PI) * .08, 1 - Math.sin(progress * Math.PI) * .04);
        if (progress < 1)
          animation = requestAnimationFrame(tick);
        else {
          animation = undefined;
          rotation = 0;
          render();
          resolve();
        }
      };
      animation = requestAnimationFrame(tick);
    });
  };

  const isAgentGesture = (kind: string, event: Event): boolean => {
    const current = gesture;
    if (!current || event.timeStamp + 1 < current.armedAt ||
        current.expiresAt < performance.now() || current.kind !== kind)
      return false;
    if (event instanceof KeyboardEvent && current.key && event.key !== current.key)
      return false;
    if (event instanceof PointerEvent && current.x !== undefined && current.y !== undefined &&
        Math.hypot(event.clientX - current.x, event.clientY - current.y) > 3)
      return false;
    gesture = undefined;
    return true;
  };

  const report = (kind: string, event: Event) => {
    if (!event.isTrusted)
      return;
    if (!isAgentGesture(kind, event))
      void chrome.runtime.sendMessage({ type: 'tyrs.user.input', kind }).catch(() => undefined);
  };
  addEventListener('pointerdown', event => report('pointerdown', event), true);
  addEventListener('wheel', event => report('wheel', event), { capture: true, passive: true });
  addEventListener('keydown', event => report('keydown', event), true);
  addEventListener('touchstart', event => report('touchstart', event), { capture: true, passive: true });

  chrome.runtime.onMessage.addListener((message: CursorMessage, _sender, respond) => {
    if (message?.type !== 'tyrs.cursor')
      return undefined;
    void (async () => {
      if (message.action === 'prepare') {
        const armedAt = performance.now();
        gesture = {
          kind: message.key ? 'keydown' : (message.x !== undefined ? 'pointerdown' : 'wheel'),
          x: message.x,
          y: message.y,
          key: message.key,
          armedAt,
          expiresAt: armedAt + 250,
        };
      } else if (message.action === 'move') {
        await move(message.x ?? x, message.y ?? y, message.visual === true);
      } else if (message.action === 'press') {
        cursor.classList.add('pressed');
        render(.9, .9);
      } else if (message.action === 'release') {
        cursor.classList.remove('pressed');
        render();
      } else if (message.action === 'thinking') {
        cursor.classList.toggle('thinking', message.visual === true);
      } else if (message.action === 'hide') {
        cursor.classList.remove('visible', 'pressed', 'thinking');
      }
      respond({ ok: true });
    })();
    return true;
  });
}
