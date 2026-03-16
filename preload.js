const { contextBridge, ipcRenderer } = require("electron");
const { convert: hangulConvert } = require("hangul-romanization");
const { pinyin } = require("pinyin-pro");
const Kuroshiro = require("kuroshiro").default;
const KuromojiAnalyzer = require("kuroshiro-analyzer-kuromoji");

const kuroshiro = new Kuroshiro();
const kuroshiroReady = kuroshiro.init(new KuromojiAnalyzer());

contextBridge.exposeInMainWorld("spotify", {
  login: () => ipcRenderer.invoke("login"),
  getToken: () => ipcRenderer.invoke("get-token"),
  onTokenReady: (cb) => ipcRenderer.on("token-ready", (_e, token) => cb(token)),
  onTokenRefreshed: (cb) => ipcRenderer.on("token-refreshed", (_e, token) => cb(token)),
});

contextBridge.exposeInMainWorld("kuroshiro", {
  convert: async (text) => {
    await kuroshiroReady;
    return kuroshiro.convert(text, { to: "romaji", mode: "spaced" });
  },
});

contextBridge.exposeInMainWorld("hangulRomanization", {
  convert: (text) => hangulConvert(text),
});

contextBridge.exposeInMainWorld("pinyinPro", {
  convert: (text) => pinyin(text, { toneType: "symbol", type: "string" }),
});

contextBridge.exposeInMainWorld("genius", {
  fetchLyrics: (artist, title) => ipcRenderer.invoke("fetch-genius-lyrics", artist, title),
});

contextBridge.exposeInMainWorld("electronWindow", {
  getPos: () => ipcRenderer.invoke("get-window-pos"),
  setPos: (x, y) => ipcRenderer.send("set-window-pos", x, y),
  getSize: () => ipcRenderer.invoke("get-window-size"),
  setSize: (w, h) => ipcRenderer.send("set-window-size", w, h),
  minimize: () => ipcRenderer.send("minimize-window"),
  setOpacity: (v) => ipcRenderer.send("set-window-opacity", v),
});
