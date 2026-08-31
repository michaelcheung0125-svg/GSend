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
  "app.footer": "Direct browser-to-browser transfer. Files never touch a server.",
  "app.privacy": "Privacy",
  "app.language": "切換到中文",
  "app.languageShort": "中文",

  "ended.title": "Session ended",
  "ended.default": "The session is closed.",
  "ended.startOver": "Start over",

  "landing.title": "Move files between your devices",
  "landing.subtitle": "One code, one direct connection. Up to {size} per file.",
  "landing.start": "Start a session",
  "landing.orJoin": "or join one",
  "landing.join": "Join",
  "landing.codeLabel": "4-digit code",

  "host.creating": "Creating a session…",
  "host.reserving": "Reserving a code.",
  "host.title": "On the other device",
  "host.subtitle": "Open this site and enter the code, or scan the square.",
  "host.codeLabel": "Code {code}",
  "host.expiresIn": "Expires in {seconds}s",
  "host.expired": "Expired",
  "host.qrAlt": "QR code for this session",
  "host.linkCopied": "Link copied",
  "host.cancel": "Cancel",
  "host.sharePendingFiles":
    "{count} shared file(s) will go as soon as the other device connects.",
  "host.sharePendingText": "Shared text will go as soon as the other device connects.",

  "pairing.deviceConnected": "A device connected",
  "pairing.approvePrompt":
    "Only continue if this was you or someone you are expecting. Nothing is sent until you approve.",
  "pairing.approve": "Approve",
  "pairing.decline": "Decline",
  "pairing.waitingTitle": "Waiting for the other device",
  "pairing.waitingBody":
    "The other device dropped off. It has a few minutes to come back before this session closes.",
  "pairing.almostThere": "Almost there",
  "pairing.connecting": "Connecting",
  "pairing.waitingApproval": "Waiting for the other device to approve.",
  "pairing.connectingBody": "Connecting to the other device…",
  "pairing.noDirectRoute":
    "Could not open a direct connection on this network. Put both devices on the same Wi-Fi and try again.",

  "transfer.dropHere": "Drop files here",
  "transfer.chooseFiles": "Choose files",
  "transfer.textPlaceholder": "Send text or a link",
  "transfer.textLabel": "Text to send",
  "transfer.send": "Send",
  "transfer.copy": "Copy",
  "transfer.save": "Save",
  "transfer.cancel": "Cancel",

  "status.connected": "Connected",
  "status.peerAway": "The other device dropped off — waiting for it to come back",
  "status.reconnecting": "Reconnecting…",
  "status.lost": "Connection lost",
  "status.connecting": "Connecting…",

  "row.sent": "Sent",
  "row.received": "Received",
  "row.cancelled": "Cancelled",
  "row.failed": "Failed",
  "row.paused": "Paused — waiting to reconnect",
  "row.pending": "Waiting for the other device",
  "row.progress": "{percent}% · {transferred}",

  "notice.skipped": "{count} file(s) skipped: over the {limit} MB limit.",
  "notice.allTooLarge": "Files above {limit} MB are not supported yet.",

  "error.badCode": "Enter the 4 digits shown on the other device.",
  "error.declinedByYou": "You declined the connection.",
  "error.declinedByPeer": "The other device declined the connection.",
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
  "app.footer": "瀏覽器之間直接傳輸,檔案不經過伺服器。",
  "app.privacy": "隱私說明",
  "app.language": "Switch to English",
  "app.languageShort": "EN",

  "ended.title": "連線已結束",
  "ended.default": "這個連線已經關閉。",
  "ended.startOver": "重新開始",

  "landing.title": "在你的裝置之間傳檔案",
  "landing.subtitle": "一組數字碼,一條直接連線。每個檔案最大 {size}。",
  "landing.start": "建立連線",
  "landing.orJoin": "或加入一個",
  "landing.join": "加入",
  "landing.codeLabel": "4 位數字碼",

  "host.creating": "正在建立連線…",
  "host.reserving": "正在取得數字碼。",
  "host.title": "在另一台裝置上",
  "host.subtitle": "開啟這個網站並輸入數字碼,或掃描下方方塊。",
  "host.codeLabel": "數字碼 {code}",
  "host.expiresIn": "{seconds} 秒後失效",
  "host.expired": "已失效",
  "host.qrAlt": "這個連線的 QR code",
  "host.linkCopied": "已複製連結",
  "host.cancel": "取消",
  "host.sharePendingFiles": "已分享的 {count} 個檔案會在另一台裝置連上後送出。",
  "host.sharePendingText": "已分享的文字會在另一台裝置連上後送出。",

  "pairing.deviceConnected": "有一台裝置已連線",
  "pairing.approvePrompt": "只有在這是你自己、或你正在等待的人時才繼續。你按下同意之前不會送出任何東西。",
  "pairing.approve": "同意",
  "pairing.decline": "拒絕",
  "pairing.waitingTitle": "正在等待另一台裝置",
  "pairing.waitingBody": "另一台裝置離線了。它還有幾分鐘可以回來,否則這個連線就會關閉。",
  "pairing.almostThere": "就快好了",
  "pairing.connecting": "連線中",
  "pairing.waitingApproval": "正在等待另一台裝置同意。",
  "pairing.connectingBody": "正在連線到另一台裝置…",
  "pairing.noDirectRoute": "在這個網路環境下無法建立直接連線。請讓兩台裝置連上同一個 Wi-Fi 再試一次。",

  "transfer.dropHere": "把檔案拖到這裡",
  "transfer.chooseFiles": "選擇檔案",
  "transfer.textPlaceholder": "傳送文字或連結",
  "transfer.textLabel": "要傳送的文字",
  "transfer.send": "傳送",
  "transfer.copy": "複製",
  "transfer.save": "儲存",
  "transfer.cancel": "取消",

  "status.connected": "已連線",
  "status.peerAway": "另一台裝置離線了——正在等它回來",
  "status.reconnecting": "重新連線中…",
  "status.lost": "連線中斷",
  "status.connecting": "連線中…",

  "row.sent": "已送出",
  "row.received": "已接收",
  "row.cancelled": "已取消",
  "row.failed": "失敗",
  "row.paused": "已暫停——等待重新連線",
  "row.pending": "正在等待另一台裝置",
  "row.progress": "{percent}% · {transferred}",

  "notice.skipped": "已略過 {count} 個檔案:超過 {limit} MB 上限。",
  "notice.allTooLarge": "目前尚不支援超過 {limit} MB 的檔案。",

  "error.badCode": "請輸入另一台裝置上顯示的 4 位數字。",
  "error.declinedByYou": "你拒絕了這個連線。",
  "error.declinedByPeer": "另一台裝置拒絕了這個連線。",
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
