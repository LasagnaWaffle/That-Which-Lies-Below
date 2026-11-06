window.TERMINAL_CONFIG = {
  // Production URL of the n8n Webhook node (POST).
  WEBHOOK_URL: "https://lasagnawaffle.app.n8n.cloud/webhook/underground",

  // Everything from STATE_START onward is hidden from the terminal.
  // If STATE_END also appears after it, only the text between the two is hidden.
  STATE_START: "<<<STATE>>>",
  STATE_END: "<<<END_STATE>>>",

  // Sent to the AI automatically on first load and after /reset (not shown on screen).
  // Leave empty to wait for the user to type first.
  START_MESSAGE: "",

  // Typing speed of AI replies. 0 prints instantly.
  TYPE_CHARS_PER_SECOND: 50,
};
