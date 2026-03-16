const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const express = require("express");
const http = require("http");
const crypto = require("crypto");
const CLIENT_ID = "3508875c44254a518a96d91cfe96450b";
const GENIUS_TOKEN = "InCSp34L9lU9pFMV5nfL41tOthLDIXvNqk4g10P8TrQTsDI7cJwCcLegbKIBimI0";
const REDIRECT_URI = "http://127.0.0.1:8888/callback";
const SCOPES = [
  "streaming",
  "user-read-email",
  "user-read-private",
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
].join(" ");

let mainWindow;
let authWindow;
let accessToken = null;
let refreshToken = null;
let codeVerifier = null;

// ── PKCE helpers ──────────────────────────────────────────────────────────────
function generateCodeVerifier() {
  return crypto.randomBytes(64).toString("base64url");
}

function generateCodeChallenge(verifier) {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

// ── Auth callback server ──────────────────────────────────────────────────────
const expressApp = express();
let callbackServer = null;

function startCallbackServer(resolve, reject) {
  expressApp.get("/callback", async (req, res) => {
    const { code, error } = req.query;
    if (error || !code) {
      res.send("<h2>Auth failed. You can close this.</h2>");
      return reject(new Error(error || "No code"));
    }

    try {
      const params = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        code_verifier: codeVerifier,
      });

      const response = await fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
      });

      const data = await response.json();
if (data.error) throw new Error(`${data.error}: ${data.error_description}`);

      accessToken = data.access_token;
      refreshToken = data.refresh_token;

      res.send("<h2>Logged in! You can close this window.</h2>");
      if (authWindow && !authWindow.isDestroyed()) authWindow.close();
      resolve(accessToken);
    } catch (e) {
      console.error("Auth error:", e.message);
      res.send(`<h2>Auth error</h2><pre>${e.message}</pre>`);
      reject(e);
    } finally {
      if (callbackServer) callbackServer.close();
    }
  });

  callbackServer = http.createServer(expressApp).listen(8888);
}

// ── Spotify login ─────────────────────────────────────────────────────────────
function loginWithSpotify() {
  return new Promise((resolve, reject) => {
    codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);

    startCallbackServer(resolve, reject);

    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      response_type: "code",
      redirect_uri: REDIRECT_URI,
      scope: SCOPES,
      code_challenge_method: "S256",
      code_challenge: codeChallenge,
    });

    const authUrl = `https://accounts.spotify.com/authorize?${params}`;

    authWindow = new BrowserWindow({
      width: 480,
      height: 480,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
    authWindow.loadURL(authUrl);
  });
}

// ── Token refresh ─────────────────────────────────────────────────────────────
async function refreshAccessToken() {
  if (!refreshToken) return;
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
  });
  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const data = await response.json();
  if (data.access_token) {
    accessToken = data.access_token;
    if (data.refresh_token) refreshToken = data.refresh_token;
    mainWindow.webContents.send("token-refreshed", accessToken);
  }
}

// ── IPC handlers ──────────────────────────────────────────────────────────────
ipcMain.handle("get-token", () => accessToken);
ipcMain.handle("login", async () => {
  const token = await loginWithSpotify();
  return token;
});
ipcMain.handle("refresh-token", refreshAccessToken);

ipcMain.handle("fetch-genius-lyrics", async (_e, artist, title) => {
  try {
    console.log("[Genius] searching for:", artist, "-", title);
    const searchRes = await fetch(
      `https://api.genius.com/search?q=${encodeURIComponent(`${artist} ${title}`)}`,
      { headers: { Authorization: `Bearer ${GENIUS_TOKEN}` } }
    );
    const searchData = await searchRes.json();
    console.log("[Genius] raw response:", JSON.stringify(searchData).slice(0, 300));
    const hit = searchData.response?.hits?.[0]?.result;
    if (!hit) { console.log("[Genius] no search hit"); return null; }
    console.log("[Genius] found:", hit.full_title, "→", hit.url);

    const pageRes = await fetch(hit.url, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" },
    });
    console.log("[Genius] page status:", pageRes.status);
    const html = await pageRes.text();

    // Extract all data-lyrics-container div contents (depth-aware to handle nested tags)
    const chunks = [];
    let searchFrom = 0;
    while (true) {
      const attrIdx = html.indexOf('data-lyrics-container="true"', searchFrom);
      if (attrIdx === -1) break;
      const openEnd = html.indexOf('>', attrIdx) + 1;
      let depth = 1, pos = openEnd;
      while (depth > 0 && pos < html.length) {
        const nextOpen  = html.indexOf('<div', pos);
        const nextClose = html.indexOf('</div>', pos);
        if (nextClose === -1) break;
        if (nextOpen !== -1 && nextOpen < nextClose) { depth++; pos = nextOpen + 4; }
        else { depth--; if (depth > 0) pos = nextClose + 6; else chunks.push(html.slice(openEnd, nextClose)); }
      }
      searchFrom = openEnd;
    }
    console.log("[Genius] lyric chunks found:", chunks.length);
    if (!chunks.length) return null;

    const text = chunks
      .join("\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .split("\n")
      .filter((line) => !/^\d+\s+Contributor/i.test(line) && !/Lyrics$/.test(line.trim()) && !/^\[.+\]$/.test(line.trim()))
      .join("\n")
      .trim();

    return text || null;
  } catch (e) {
    console.log("[Genius] error:", e.message);
    return null;
  }
});

ipcMain.on("minimize-window", () => mainWindow.minimize());
ipcMain.on("set-window-opacity", (_e, value) => mainWindow.setOpacity(value));
ipcMain.handle("get-window-pos", () => mainWindow.getPosition());
ipcMain.on("set-window-pos", (_e, x, y) => mainWindow.setPosition(Math.round(x), Math.round(y)));
ipcMain.on("set-window-size", (_e, w, h) => mainWindow.setSize(Math.round(w), Math.round(h)));
ipcMain.handle("get-window-size", () => mainWindow.getSize());

// ── Main window ───────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  mainWindow = new BrowserWindow({
    width: 280,
    height: 380,
    minWidth: 280,
    minHeight: 380,
    transparent: true,
    vibrancy: "under-window",
    frame: false,
    hasShadow: true,
    icon: path.join(__dirname, "assets/icon.icns"),
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile("index.html");

  // Auto-login on launch — show player only after auth succeeds
  try {
    await loginWithSpotify();
    mainWindow.show();
    mainWindow.webContents.send("token-ready", accessToken);
  } catch (e) {
    console.error("Login failed:", e);
    mainWindow.show(); // show anyway so the user isn't left with nothing
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Refresh token every 50 minutes
setInterval(refreshAccessToken, 50 * 60 * 1000);
