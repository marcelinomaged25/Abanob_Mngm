import { isChatPath, unlockChat } from "./chatAccess.js";
import "./chatMascot.css";

export default function ChatMascot() {
  if (isChatPath()) return null;
  return (
    <a
      className="chat-mascot"
      href="/ask-about-ritual"
      onClick={unlockChat}
      aria-label="افتح الشات مع خادم الكنيسة"
      title="شات مع خادم"
    >
      <span className="chat-mascot-ripple" aria-hidden="true" />
      <img src="/app-icon.png" alt="" width="76" height="76" />
      <span className="chat-mascot-label" aria-hidden="true">
        شات مع خادم
      </span>
    </a>
  );
}
