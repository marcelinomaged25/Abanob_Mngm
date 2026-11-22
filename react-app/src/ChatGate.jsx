import { unlockChat } from "./chatAccess.js";
import "./chatMascot.css";

export default function ChatGate() {
  const open = () => {
    unlockChat();
    window.location.reload();
  };
  return (
    <main className="chat-gate" dir="rtl" lang="ar">
      <section className="chat-gate-card">
        <img src="/app-icon.png" alt="القديس أبانوب" />
        <h1>الشات بيتفتح من أيقونة القديس</h1>
        <p>
          أيقونة القديس أبانوب بتتحرك في صفحات الموقع. دوس عليها عشان تفتح الشات وتسأل على طول، أو استخدم
          الزرار هنا.
        </p>
        <button type="button" onClick={open}>
          افتح الشات
        </button>
        <a href="/">العودة للرئيسية</a>
      </section>
    </main>
  );
}
