import { useEffect, useRef, useState } from "react";
import { isChatPath, unlockChat } from "./chatAccess.js";
import "./chatMascot.css";

const STORAGE_KEY = "abanoub-chat-mascot-position";
const EDGE = 8;
const DRAG_THRESHOLD = 6;

function clampPosition(x, y, width, height) {
  const maxX = Math.max(EDGE, window.innerWidth - width - EDGE);
  const maxY = Math.max(EDGE, window.innerHeight - height - EDGE);
  return {
    x: Math.min(Math.max(x, EDGE), maxX),
    y: Math.min(Math.max(y, EDGE), maxY),
  };
}

function readSavedPosition() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    return Number.isFinite(saved?.x) && Number.isFinite(saved?.y) ? saved : null;
  } catch {
    return null;
  }
}

export default function ChatMascot() {
  const onChat = isChatPath();
  const mascotRef = useRef(null);
  const drag = useRef(null);
  const moved = useRef(false);
  const [position, setPosition] = useState(readSavedPosition);
  const [dragging, setDragging] = useState(false);
  const hasPosition = Boolean(position);

  useEffect(() => {
    if (!position) return undefined;
    const keepVisible = () => {
      const element = mascotRef.current;
      if (!element) return;
      setPosition((current) =>
        current
          ? clampPosition(current.x, current.y, element.offsetWidth, element.offsetHeight)
          : current,
      );
    };
    keepVisible();
    window.addEventListener("resize", keepVisible);
    window.addEventListener("orientationchange", keepVisible);
    return () => {
      window.removeEventListener("resize", keepVisible);
      window.removeEventListener("orientationchange", keepVisible);
    };
  }, [hasPosition]);

  const onPointerDown = (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: 0,
      originY: 0,
      width: 0,
      height: 0,
    };
    moved.current = false;
  };

  const onPointerMove = (event) => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    if (!moved.current) {
      if (Math.hypot(event.clientX - state.startX, event.clientY - state.startY) < DRAG_THRESHOLD) return;
      const element = mascotRef.current;
      if (!element) return;
      const rect = element.getBoundingClientRect();
      moved.current = true;
      setDragging(true);
      state.originX = rect.left;
      state.originY = rect.top;
      state.width = rect.width;
      state.height = rect.height;
    }
    event.preventDefault();
    setPosition(
      clampPosition(
        state.originX + (event.clientX - state.startX),
        state.originY + (event.clientY - state.startY),
        state.width,
        state.height,
      ),
    );
  };

  const onPointerEnd = (event) => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
    if (!moved.current) return;
    setPosition((current) => {
      if (current) {
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
        } catch {
          /* storage full or blocked; position still applies for this visit */
        }
      }
      return current;
    });
  };

  const onClick = (event) => {
    if (moved.current) {
      event.preventDefault();
      moved.current = false;
      return;
    }
    unlockChat();
  };

  if (onChat) return null;

  return (
    <a
      ref={mascotRef}
      className={`chat-mascot${position ? " chat-mascot--placed" : ""}${dragging ? " chat-mascot--dragging" : ""}`}
      style={position ? { left: position.x, top: position.y, right: "auto", bottom: "auto" } : undefined}
      href="/ask-about-ritual"
      draggable="false"
      onClick={onClick}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      aria-label="افتح الشات مع خادم الكنيسة. تقدر تسحب الأيقونة وتحركها في المكان اللي تحبه."
      title="شات مع خادم"
    >
      <span className="chat-mascot-ripple" aria-hidden="true" />
      <img src="/app-icon.png" alt="" width="76" height="76" draggable="false" />
      <span className="chat-mascot-label" aria-hidden="true">
        شات مع خادم
      </span>
    </a>
  );
}
