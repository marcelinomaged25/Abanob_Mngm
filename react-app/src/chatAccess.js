const CHAT_PATH = "/ask-about-ritual";
const UNLOCK_KEY = "abanoub-chat-unlocked";

export const isChatPath = () => [CHAT_PATH, `${CHAT_PATH}/`].includes(window.location.pathname);

export const unlockChat = () => {
  try {
    window.sessionStorage.setItem(UNLOCK_KEY, "1");
  } catch {
    /* Private mode can block storage; the link still works for the current visit. */
  }
};

export const isChatUnlocked = () => {
  try {
    return window.sessionStorage.getItem(UNLOCK_KEY) === "1";
  } catch {
    return false;
  }
};
