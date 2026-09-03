/**
 * Every user-visible string. English is the source of truth: its keys define the type,
 * so a missing or stray translation is a compile error rather than a gap someone spots
 * in production.
 *
 * Placeholders are written `{name}` and filled by `format`.
 */

export const en = {
  "app.back": "Back to start",
  "app.endSession": "End session",
  "app.stop": "Stop",
  "app.footer": "Direct browser-to-browser transfer. Files never touch a server.",
  "app.privacy": "Privacy",
  "app.language": "切換到中文",
  "app.languageShort": "中文",

  "ended.kicker": "Closed",
  "ended.title": "Session ended",
  "ended.default": "The session is closed.",
  "ended.startOver": "Start over",

  "landing.kicker": "Browser to browser · nothing stored",
  "landing.title": "Move files between your devices",
  "landing.subtitle":
    "Pick what to send, get a 4-digit code, and the other device receives it the moment it enters the code.",
  "landing.limitDisk": "Files are limited only by the receiving device's free disk space.",
  "landing.limitSize": "Up to {size} per file.",
  "landing.dropHere": "Drop files here",
  "landing.chooseFiles": "Choose files",
  "landing.textPlaceholder": "Or send text or a link",
  "landing.textLabel": "Text to send",
  "landing.getCode": "Get a code",
  "landing.staged": "{count} file(s) · {size}",
  "landing.clear": "Clear",
  "landing.receiveOnly":
    "Nothing picked yet — a code with an empty queue still opens a session to receive into.",
  "landing.orJoin": "or join one",
  "landing.join": "Join and receive",
  "landing.joinSub": "Enter the 4 digits shown on the other device.",
  "landing.joinFolderHint":
    "Joining asks where to save. Everything sent during this session lands in that folder, written straight to disk with no size limit.",
  "landing.qrHint": "Scanning the square on the other screen also joins — no typing needed.",
  "landing.codeLabel": "4-digit code",

  "host.creating": "Creating a session…",
  "host.reserving": "Reserving a code.",
  "host.kicker": "On the other device",
  "host.title": "Open this site and enter the code",
  "host.subtitle": "Or scan the square.",
  "host.burnNote":
    "The code dies the moment one device joins, expires after 60 seconds, and only 12 attempts a minute are allowed. Sending starts on its own once a device is through — watch this screen and stop it if the device is not yours.",
  "host.copy": "Copy",
  "host.codeLabel": "Code {code}",
  "host.expiresIn": "Expires in {seconds}s",
  "host.expired": "Expired",
  "host.qrAlt": "QR code for this session",
  "host.linkCopied": "Link copied",
  "host.cancel": "Cancel",
  "host.queuedFiles": "{count} file(s) · {size} — starts moving the moment a device joins.",
  "host.queuedText": "Text queued — it goes the moment a device joins.",
  "host.queuedNothing": "Nothing queued. This session will receive whatever the other device sends.",

  "pairing.waitingTitle": "Waiting for the other device",
  "pairing.waitingBody":
    "The other device dropped off. It has a few minutes to come back before this session closes.",
  "pairing.almostThere": "Almost there",
  "pairing.connecting": "Connecting",
  "pairing.connectingBody": "Connecting to the other device…",
  "pairing.noDirectRoute":
    "Could not open a direct connection between these two networks. Mobile data usually blocks it — putting both devices on the same Wi-Fi is the reliable fix.",

  "transfer.session": "This session",
  "transfer.sessionMeta": "{count} item(s) · up {up} · down {down}",
  "transfer.peerJoined": "A device joined and is receiving. Stop the session if that was not you.",
  "transfer.stop": "Stop",
  "transfer.dismiss": "Dismiss",
  "transfer.saveFolder": "Arriving files are written straight into {folder}.",
  "transfer.saveBrowser":
    "Received files sit in this browser's storage and survive a reload, until you press Save.",
  "transfer.dropHere": "Drop files here",
  "transfer.chooseFiles": "Choose files",
  "transfer.chooseFolder": "Choose where to save",
  "transfer.textPlaceholder": "Send text or a link",
  "transfer.textLabel": "Text to send",
  "transfer.send": "Send",
  "transfer.copy": "Copy",
  "transfer.save": "Save",
  "transfer.cancel": "Cancel",
  "transfer.limitDisk": "disk",

  "status.connected": "Connected",
  "status.peerAway": "The other device dropped off — waiting for it to come back",
  "status.reconnecting": "Reconnecting…",
  "status.lost": "Connection lost",
  "status.connecting": "Connecting…",

  "row.sent": "Sent",
  "row.received": "Received",
  "row.savedTo": "Saved · {name}",
  "row.cancelled": "Cancelled",
  "row.failed": "Failed",
  "row.paused": "Paused — waiting to reconnect",
  "row.pending": "Waiting for the other device",
  "row.progress": "{percent}% · {transferred}",

  "notice.noFolder":
    "No folder picked, so files land in this browser's storage — up to {size} each, and you save them by hand.",

  "error.badCode": "Enter the 4 digits shown on the other device.",
  "error.stopped": "You stopped the session.",
  "error.nobodyJoined": "Nobody joined in time. Start a new session.",
  "error.peerEnded": "The other device ended the session.",
  "error.sessionIdle": "The session was closed after sitting idle.",
  "error.expiredWhileAway": "The session expired while this page was away. Start a new one.",
  "error.serverLost": "Lost the connection to the server.",
  "error.peerGone": "The other device left and did not come back.",
  "error.idle": "session idle",

  "server.code_not_found": "That code does not exist. Check the digits and try again.",
  "server.code_expired": "That code has expired. Ask for a fresh one.",
  "server.session_full": "That code has already been used by another device.",
  "server.bad_key": "This session could not be resumed.",
  "server.rate_limited": "Too many attempts. Wait a minute and try again.",
  "server.no_capacity": "The server is busy right now. Try again in a moment.",
  "server.bad_request": "Malformed request.",

  "cancel.sender-cancelled": "Cancelled by the sender",
  "cancel.receiver-cancelled": "Cancelled by the receiver",
  "cancel.sender-reloaded": "The sender's page reloaded and cannot re-read the file",
  "cancel.too-large": "The receiving device cannot take a file this large (limit {limit} MB)",
  "cancel.peer-lost": "The other device lost this transfer",
  "cancel.write-failed": "Could not write to storage",
  "cancel.assemble-failed": "Could not assemble the file",
  "cancel.stream-gap": "The stream lost its place",
  "cancel.read-failed": "The sender could not read the file",
  "cancel.unknown": "Stopped",
} as const;

export type MessageKey = keyof typeof en;

/** Enforced to be complete: a missing key will not compile. */
export const zh: Record<MessageKey, string> = {
  "app.back": "回到首頁",
  "app.endSession": "結束連線",
  "app.stop": "中止",
  "app.footer": "瀏覽器之間直接傳輸,檔案不經過伺服器。",
  "app.privacy": "隱私說明",
  "app.language": "Switch to English",
  "app.languageShort": "EN",

  "ended.kicker": "已關閉",
  "ended.title": "連線已結束",
  "ended.default": "這個連線已經關閉。",
  "ended.startOver": "重新開始",

  "landing.kicker": "瀏覽器直連 · 檔案不經伺服器",
  "landing.title": "在你的裝置之間傳檔案",
  "landing.subtitle": "先選要傳的東西,拿到一組 4 位數字碼,另一台裝置輸入後就直接開始接收。",
  "landing.limitDisk": "檔案大小只受接收端剩餘磁碟空間限制。",
  "landing.limitSize": "每個檔案最大 {size}。",
  "landing.dropHere": "把檔案拖到這裡",
  "landing.chooseFiles": "選擇檔案",
  "landing.textPlaceholder": "或傳送文字、連結",
  "landing.textLabel": "要傳送的文字",
  "landing.getCode": "產生數字碼",
  "landing.staged": "{count} 個檔案 · {size}",
  "landing.clear": "清除",
  "landing.receiveOnly": "還沒選任何東西——空的佇列一樣可以產生數字碼,單純用來接收對方傳來的檔案。",
  "landing.orJoin": "或加入一個",
  "landing.join": "加入並接收",
  "landing.joinSub": "輸入另一台裝置上顯示的 4 位數字。",
  "landing.joinFolderHint": "加入時會問你要存到哪個資料夾。這次連線收到的所有檔案都會直接寫進那個資料夾,不經過中轉,也沒有大小上限。",
  "landing.qrHint": "掃描對方畫面上的方塊也可以直接加入,不用打數字。",
  "landing.codeLabel": "4 位數字碼",

  "host.creating": "正在建立連線…",
  "host.reserving": "正在取得數字碼。",
  "host.kicker": "在另一台裝置上",
  "host.title": "開啟這個網站並輸入數字碼",
  "host.subtitle": "或掃描下面的方塊。",
  "host.burnNote": "數字碼在第一台裝置加入後就作廢,60 秒後失效,而且每分鐘只允許 12 次嘗試。有裝置連上後就會自動開始傳送——請留意這個畫面,如果不是你的裝置就立刻中止。",
  "host.copy": "複製",
  "host.codeLabel": "數字碼 {code}",
  "host.expiresIn": "{seconds} 秒後失效",
  "host.expired": "已失效",
  "host.qrAlt": "這個連線的 QR code",
  "host.linkCopied": "已複製連結",
  "host.cancel": "取消",
  "host.queuedFiles": "{count} 個檔案 · {size}——有裝置加入就立刻開始傳送。",
  "host.queuedText": "文字已排入佇列,有裝置加入就送出。",
  "host.queuedNothing": "佇列是空的。這次連線會單純接收對方傳來的東西。",

  "pairing.waitingTitle": "正在等待另一台裝置",
  "pairing.waitingBody": "另一台裝置離線了。它還有幾分鐘可以回來,否則這個連線就會關閉。",
  "pairing.almostThere": "就快好了",
  "pairing.connecting": "連線中",
  "pairing.connectingBody": "正在連線到另一台裝置…",
  "pairing.noDirectRoute": "無法在這兩個網路之間建立直接連線。行動網路通常會擋掉這種連線——讓兩台裝置連上同一個 Wi-Fi 是最可靠的做法。",

  "transfer.session": "這次連線",
  "transfer.sessionMeta": "{count} 個項目 · 上傳 {up} · 下載 {down}",
  "transfer.peerJoined": "有一台裝置已加入並開始接收。如果那不是你,請立刻中止這次連線。",
  "transfer.stop": "中止",
  "transfer.dismiss": "知道了",
  "transfer.saveFolder": "收到的檔案會直接寫進「{folder}」。",
  "transfer.saveBrowser": "收到的檔案存在這個瀏覽器的儲存空間裡,重新整理也還在,直到你按下儲存。",
  "transfer.dropHere": "把檔案拖到這裡",
  "transfer.chooseFiles": "選擇檔案",
  "transfer.chooseFolder": "選擇儲存資料夾",
  "transfer.textPlaceholder": "傳送文字或連結",
  "transfer.textLabel": "要傳送的文字",
  "transfer.send": "傳送",
  "transfer.copy": "複製",
  "transfer.save": "儲存",
  "transfer.cancel": "取消",
  "transfer.limitDisk": "磁碟",

  "status.connected": "已連線",
  "status.peerAway": "另一台裝置離線了——正在等它回來",
  "status.reconnecting": "重新連線中…",
  "status.lost": "連線中斷",
  "status.connecting": "連線中…",

  "row.sent": "已送出",
  "row.received": "已接收",
  "row.savedTo": "已存檔 · {name}",
  "row.cancelled": "已取消",
  "row.failed": "失敗",
  "row.paused": "已暫停——等待重新連線",
  "row.pending": "正在等待另一台裝置",
  "row.progress": "{percent}% · {transferred}",

  "notice.noFolder": "沒有選資料夾,檔案會先收進這個瀏覽器的儲存空間——每個檔案上限 {size},而且要自己按儲存。",

  "error.badCode": "請輸入另一台裝置上顯示的 4 位數字。",
  "error.stopped": "你中止了這次連線。",
  "error.nobodyJoined": "沒有人在時限內加入。請重新建立連線。",
  "error.peerEnded": "另一台裝置結束了這個連線。",
  "error.sessionIdle": "連線閒置過久,已經關閉。",
  "error.expiredWhileAway": "這個頁面離開期間連線已經失效。請重新建立一個。",
  "error.serverLost": "與伺服器的連線中斷了。",
  "error.peerGone": "另一台裝置離開後沒有回來。",
  "error.idle": "閒置過久",

  "server.code_not_found": "這個數字碼不存在。請檢查數字後再試一次。",
  "server.code_expired": "這個數字碼已經失效。請對方重新產生一組。",
  "server.session_full": "這個數字碼已經被另一台裝置使用了。",
  "server.bad_key": "無法恢復這個連線。",
  "server.rate_limited": "嘗試次數過多。請等一分鐘後再試。",
  "server.no_capacity": "伺服器目前忙碌中。請稍後再試。",
  "server.bad_request": "請求格式錯誤。",

  "cancel.sender-cancelled": "傳送方已取消",
  "cancel.receiver-cancelled": "接收方已取消",
  "cancel.sender-reloaded": "傳送方的頁面重新載入了,無法繼續讀取該檔案",
  "cancel.too-large": "接收裝置無法接受這麼大的檔案(上限 {limit} MB)",
  "cancel.peer-lost": "另一台裝置遺失了這筆傳輸",
  "cancel.write-failed": "無法寫入儲存空間",
  "cancel.assemble-failed": "無法組合檔案",
  "cancel.stream-gap": "資料串流出現落差",
  "cancel.read-failed": "傳送方無法讀取該檔案",
  "cancel.unknown": "已停止",
};

export const DICTIONARIES = { en, zh } as const;
export type Language = keyof typeof DICTIONARIES;

export type MessageParams = Record<string, string | number>;

/** A translatable message plus whatever it needs interpolated. */
export interface Message {
  key: MessageKey;
  params?: MessageParams;
}

export function format(template: string, params?: MessageParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  );
}
