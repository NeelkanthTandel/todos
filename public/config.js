// Deploy-time settings. Edit this file (or overwrite it in your container) per environment.
window.TODO_CONFIG = {
  // "local": data lives only in this browser's localStorage.
  // "http":  also mirror to a server at apiBase (see the contract at the top of storage.js).
  storage: "local",
  // Prefix for localStorage keys. Change it if another app shares this origin (e.g. you.github.io).
  namespace: "todos",
  apiBase: "/api",
  // Cookies go to the API only when it's on this site's origin. Use "include" for an API on another origin
  // (it must then send CORS headers for this exact origin, with Access-Control-Allow-Credentials: true).
  credentials: "same-origin",
};
