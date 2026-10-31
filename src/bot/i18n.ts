/**
 * Bot copy, in Amharic and English.
 *
 * Every string the bot can send lives here. Two reasons it is a table rather
 * than inline strings: the handler code stays readable when it is not carrying
 * two languages of prose, and — because `Copy` is a type both records must
 * satisfy — a string added in one language will not compile until the other
 * has it. A half-translated bot is worse than a monolingual one, since it
 * switches language mid-conversation.
 *
 * NOTE: this is our own wording, not the wording of the bot being cloned.
 * Screenshots of the original are coming; when they land, replace the values
 * below — the keys, flow and layout are already shaped to take them.
 */

import { escapeHtml } from "./api";

export type Lang = "am" | "en";

export const LANGS: Lang[] = ["am", "en"];

export function isLang(value: unknown): value is Lang {
  return value === "am" || value === "en";
}

/**
 * Telegram tells us the client's language; it is a better first guess than
 * picking a house default, but only a guess — the chooser still runs.
 */
export function guessLang(languageCode: string | null | undefined): Lang {
  return languageCode?.toLowerCase().startsWith("am") ? "am" : "en";
}

/** The lifecycle an application moves through, as the bot reports it. */
export type ApplicationStatus =
  | "submitted"
  | "processing"
  | "approved"
  | "printed"
  | "ready"
  | "collected"
  | "rejected";

export type FaqEntry = { id: string; question: string; answer: string };

type Copy = {
  languageName: string;
  chooseLanguage: string;
  languageChanged: string;

  welcome: (name: string) => string;
  menuPrompt: string;

  btnCheckStatus: string;
  btnFaq: string;
  btnAppointment: string;
  btnSupport: string;
  btnLanguage: string;
  btnBack: string;
  btnCancel: string;
  btnCheckAnother: string;

  askId: string;
  idInvalid: string;
  idRateLimited: (minutes: number) => string;
  checking: string;

  resultFound: (args: { status: string; last4: string; updated: string | null }) => string;
  resultNotFound: string;
  resultUnavailable: string;
  resultError: string;
  statusLabels: Record<ApplicationStatus, string>;

  faqPrompt: string;
  faq: FaqEntry[];

  appointment: string;

  supportAsk: string;
  supportTooLong: string;
  supportSent: string;
  supportFailed: string;
  supportCancelled: string;

  unknownInput: string;
  help: string;
  cancelled: string;

  // ---- main keyboard -------------------------------------------------------
  /**
   * The persistent reply keyboard, which is how the bot is actually driven.
   * These labels are matched against incoming message text, so changing one
   * changes a route — router.ts builds its routing table from this record
   * rather than from a second copy of the strings, which is what stops the two
   * drifting apart in one language only.
   */
  btnOtp1: string;
  btnOtp2: string;
  btnOtp3: string;
  btnScreenshot: string;
  btnUploadPdf: string;
  btnBuyPoints: string;
  btnMyPoints: string;
  btnSettings: string;
  /** Shown only to admins, below the customer buttons. */
  btnAdmin: string;

  /** `name` is the first name or @username, already escaped; may be empty. */
  welcomeBot: (args: { name: string; points: number }) => string;

  // ---- points --------------------------------------------------------------
  myPoints: (args: { points: number; price: number }) => string;
  /** Where to send the money, shown before the six accepted receipt formats. */
  buyPointsAccounts: (args: {
    cbeAccountName: string;
    cbeAccountNumber: string;
    telebirrAccountName: string;
    telebirrAccountNumber: string;
  }) => string;
  buyPointsNoAccounts: (admin: string) => string;
  buyPointsHow: (admin: string) => string;
  receiptUnreadable: (admin: string) => string;
  /**
   * The page was reachable but carried no amount. Commonest cause by far is a
   * mistyped reference (letter O for zero), so the copy points at that without
   * asserting it — a redesigned page lands here too, and it is still queued.
   */
  receiptNoAmount: (admin: string) => string;
  receiptDuplicate: string;
  receiptCredited: (args: { points: number; balance: number; amount: number }) => string;
  receiptQueued: string;
  receiptTooSmall: (args: { amount: number; price: number }) => string;

  // ---- cards ---------------------------------------------------------------
  otpSelected: (slot: number) => string;
  otpUnavailable: (admin: string) => string;
  /** The provider did not answer, or answered in a shape we cannot read. */
  otpNotAnswered: (admin: string) => string;
  /** Names the cost before a FAN is asked for, so nobody is surprised by it. */
  otpAsk: (args: { slot: number; points: number }) => string;
  otpSending: string;
  /** `phone` is masked by the provider before it ever reaches us. */
  otpSent: (phone: string) => string;
  otpVerifying: string;
  otpNotSixDigits: string;
  otpNoSession: string;
  otpTooManyAttempts: string;
  /** The provider's own wording, which is written for the person reading it. */
  otpRejected: (message: string) => string;
  otpDelivered: (args: { pointsSpent: number; balance: number }) => string;
  /**
   * A short text recap of the identity a JSON verify returned, shown with the
   * card. Fields are the holder's own, so nothing here is secret to them.
   */
  otpIdentitySummary: (args: {
    name: string;
    fan: string;
    fin: string;
    dateOfBirth: string;
    phone: string;
    remainingPoints: number | null;
  }) => string;
  /** Caption on the provider's original PDF, sent after the designed card. */
  otpOriginalPdf: string;
  uploadUnavailable: (admin: string) => string;
  /** Prompt after tapping Fayda Screenshot / Upload PDF, naming the cost. */
  uploadAsk: (points: number) => string;
  uploadNeedMorePoints: (args: { have: number; need: number }) => string;
  uploadReceived: (args: { pointsSpent: number; balance: number }) => string;
  uploadWrongType: string;

  // ---- settings ------------------------------------------------------------
  settingsPrompt: string;
  downloadTypePrompt: (current: string) => string;
  downloadTypes: Record<DownloadType, string>;
  btnDownloadType: string;
  btnBackSettings: string;
  saved: string;
};

/** The outputs, matching bot_users.download_type. */
export type DownloadType = "png_mirror" | "pdf_mirror" | "duo_png" | "zip" | "printable";

export const DOWNLOAD_TYPES: DownloadType[] = ["png_mirror", "pdf_mirror", "duo_png", "zip", "printable"];

const en: Copy = {
  languageName: "English",
  chooseLanguage: "Please choose your language.\nእባክዎ ቋንቋ ይምረጡ።",
  languageChanged: "Language set to English.",

  welcome: (name) =>
    `Hello ${name}! 👋\n\n` +
    "I can check the status of a Fayda application, answer common questions, " +
    "explain how appointments work, and pass a message to a human.\n\n" +
    "What would you like to do?",
  menuPrompt: "What would you like to do?",

  btnCheckStatus: "🔎 Check application status",
  btnFaq: "❓ Frequently asked questions",
  btnAppointment: "📅 Appointment information",
  btnSupport: "💬 Contact support",
  btnLanguage: "🌐 Change language",
  btnBack: "⬅️ Back",
  btnCancel: "✖️ Cancel",
  btnCheckAnother: "🔎 Check another",

  askId:
    "Send your <b>FIN</b> (12 digits) or <b>FAN</b> (16 digits).\n\n" +
    "You can type it with or without spaces. Send /cancel to stop.",
  idInvalid:
    "That does not look like a FIN or a FAN.\n\n" +
    "A FIN is 12 digits and a FAN is 16 digits — digits only, nothing else. " +
    "Please check the number and send it again, or /cancel to stop.",
  idRateLimited: (minutes) =>
    `You have made several checks in a short time. Please wait ${minutes} ` +
    `minute${minutes === 1 ? "" : "s"} and try again.`,
  checking: "Checking…",

  resultFound: ({ status, last4, updated }) =>
    `Application ending <b>${last4}</b>\n\n` +
    `Status: <b>${status}</b>` +
    (updated ? `\nLast updated: ${updated}` : ""),
  resultNotFound:
    "No application was found for that number.\n\n" +
    "Check the digits against your receipt — a FIN and a FAN are different " +
    "numbers, and it is easy to send one where the other is expected. " +
    "If it still does not work, contact support and someone will look into it.",
  resultUnavailable:
    "Status checking is unavailable right now — this is on our side, not yours. " +
    "Please try again later.",
  resultError: "Something went wrong while checking. Please try again in a moment.",
  statusLabels: {
    submitted: "Submitted",
    processing: "Being processed",
    approved: "Approved",
    printed: "Printed",
    ready: "Ready for collection",
    collected: "Collected",
    rejected: "Rejected — please contact support",
  },

  faqPrompt: "Pick a question.",
  faq: [
    {
      id: "what",
      question: "What is Fayda?",
      answer:
        "<b>What is Fayda?</b>\n\n" +
        "Fayda is Ethiopia's national digital ID. It gives you a unique 12-digit " +
        "identification number (a FIN) tied to your biometrics, which you can use " +
        "as proof of identity for banks, SIM registration, and government services.",
    },
    {
      id: "fin-fan",
      question: "What is the difference between FIN and FAN?",
      answer:
        "<b>FIN and FAN</b>\n\n" +
        "The <b>FAN</b> is your application number — you get it when you register, " +
        "and it is what you use to follow the application while it is in progress.\n\n" +
        "The <b>FIN</b> is the identification number itself, issued once your " +
        "application is approved. That is the number that stays with you.",
    },
    {
      id: "documents",
      question: "What documents do I need to register?",
      answer:
        "<b>What to bring</b>\n\n" +
        "Bring one valid proof of identity — a kebele ID, passport, or driving " +
        "licence — and be ready to give fingerprints, an iris scan, and a photo. " +
        "Registration itself is free.",
    },
    {
      id: "howlong",
      question: "How long does it take?",
      answer:
        "<b>How long it takes</b>\n\n" +
        "Processing usually takes a few working days after registration, but it " +
        "varies by centre and by how busy they are. Check here with your FAN and " +
        "the status will tell you where it has got to.",
    },
    {
      id: "lost",
      question: "I lost my number. What do I do?",
      answer:
        "<b>Lost your number</b>\n\n" +
        "Go back to the centre where you registered, with the same proof of " +
        "identity you used, and staff can look you up. This bot cannot recover a " +
        "number for you — it can only report on one you already have.",
    },
  ],

  appointment:
    "<b>Appointments</b>\n\n" +
    "Registration is done in person at a registration centre. Many centres take " +
    "walk-ins, and some ask you to book a slot first — it depends on the centre.\n\n" +
    "Bring a valid proof of identity, and allow around 30 minutes for the " +
    "biometric capture.\n\n" +
    "Contact support below if you need help finding a centre near you.",

  supportAsk:
    "Type your message and I will pass it to the support team. " +
    "Include your FAN if your question is about a specific application.\n\n" +
    "Send /cancel to stop.",
  supportTooLong: "That message is too long. Please shorten it to 1000 characters or less.",
  supportSent:
    "Thank you — your message has been passed to the support team. " +
    "They will reply here in this chat.",
  supportFailed:
    "Your message was saved but could not be delivered right now. " +
    "The support team will still see it.",
  supportCancelled: "Cancelled — nothing was sent.",

  unknownInput: "I did not understand that. Use the buttons below, or send /start to begin again.",
  help:
    "<b>Commands</b>\n\n" +
    "/start — open the menu\n" +
    "/status — check an application\n" +
    "/faq — frequently asked questions\n" +
    "/support — message the support team\n" +
    "/language — change language\n" +
    "/cancel — stop what you are doing",
  cancelled: "Cancelled.",

  btnOtp1: "📱 OTP 1 ⭐",
  btnOtp2: "📱 OTP 2",
  btnOtp3: "📱 OTP 3",
  btnScreenshot: "🪪 Fayda Screenshot",
  btnUploadPdf: "📄 Upload PDF",
  btnBuyPoints: "💳 Buy Points",
  btnMyPoints: "📊 My Points",
  btnSettings: "⚙️ Settings",
  btnAdmin: "🛠 Admin",

  welcomeBot: ({ name, points }) =>
    `${name ? `Hello ${name}! 👋` : "👋"}\n\n` +
    `Welcome to the Fayda Telegram bot.\nYour points: ${points}`,

  myPoints: ({ points, price }) =>
    `Your points: ${points}\n` +
    `Print price (ETB/point): ${price}\n\n` +
    'To buy points, open "Buy Points" and send your receipt link or reference text.',

  buyPointsAccounts: ({ cbeAccountName, cbeAccountNumber, telebirrAccountName, telebirrAccountNumber }) => {
    const lines: string[] = [];
    if (cbeAccountName && cbeAccountNumber) {
      lines.push(`<b>CBE</b>: ${escapeHtml(cbeAccountNumber)} (${escapeHtml(cbeAccountName)})`);
    }
    if (telebirrAccountName && telebirrAccountNumber) {
      lines.push(`<b>Telebirr</b>: ${escapeHtml(telebirrAccountNumber)} (${escapeHtml(telebirrAccountName)})`);
    }
    return `<b>Send payment to</b>\n\n${lines.join("\n")}`;
  },
  buyPointsNoAccounts: (admin) =>
    "No receiving account is set up yet on this bot.\n\n" + `Contact ${admin} to arrange payment.`,

  buyPointsHow: (admin) =>
    "Once you have paid, paste the receipt link OR the transaction/reference here " +
    "to confirm it.\n\n" +
    "You can paste any of these:\n" +
    "1) CBE link: https://apps.cbe.com.et:100/?id=FT25391XM4KP07823491\n" +
    "2) CBE link: https://mbreciept.cbe.com.et/FT26257QHWN-41985602\n" +
    "3) CBE reference only: FT25391XM4KP\n" +
    "4) TELEBirr receipt link: https://transactioninfo.ethiotelecom.et/receipt/CKM8P4YJNQ\n" +
    "5) TELEBirr transaction id only: CKM8P4YJNQ\n" +
    "6) The full SMS/email text (copy/paste).\n\n" +
    "If you type an id, copy it exactly: the capital letter O and the digit 0 " +
    "look alike, as do the letter I and the digit 1.\n\n" +
    "Send the payment link now.\n\n" +
    `Need help? Contact ${admin}`,

  receiptUnreadable: (admin) =>
    "I could not find a payment reference in that.\n\n" +
    "Send the receipt link, or the reference on its own, or paste the whole SMS. " +
    `If it keeps failing, contact ${admin}`,
  receiptNoAmount: (admin) =>
    "I reached the payment page but could not read an amount on it.\n\n" +
    "The usual cause is a reference typed with a look-alike character — the " +
    "capital letter O and the digit 0 look the same, and so do the letter I and " +
    "the digit 1. Paste the receipt link if you have it, or check the id and " +
    "send it again.\n\n" +
    `It has also been passed to a person to check. If it keeps failing, contact ${admin}`,
  receiptDuplicate:
    "That receipt has already been used. Each payment can be redeemed once.\n\n" +
    "If you have made a new payment, send that receipt instead.",
  receiptCredited: ({ points, balance, amount }) =>
    `Payment confirmed: ${amount} ETB\n` +
    `Points added: ${points}\n` +
    `Your points: ${balance}`,
  receiptQueued:
    "Your receipt has been received and is being checked.\n\n" +
    "This happens when the bank's page cannot be read automatically — it does " +
    "not mean anything is wrong with your payment. You will get a message here " +
    "once it is confirmed.",
  receiptTooSmall: ({ amount, price }) =>
    `That payment is ${amount} ETB, which is less than the price of one point ` +
    `(${price} ETB).\n\nPay at least ${price} ETB and send the new receipt.`,

  otpSelected: (slot) => `OTP ${slot} selected. Send your Fayda FAN number.`,
  otpAsk: ({ slot, points }) =>
    `OTP ${slot} selected. Send your 16-digit Fayda FAN number.\n\n` +
    `This costs ${points} point${points === 1 ? "" : "s"} once the card is delivered. ` +
    "Send /cancel to stop.",
  otpSending: "Sending the code…",
  otpSent: (phone) =>
    `A 6-digit code was sent to ${phone || "the registered phone"}.\n\n` +
    `Reply with the code. It expires in 10 minutes — send /cancel to stop.`,
  otpVerifying: "Checking the code and preparing your card. This can take up to a minute…",
  otpNotSixDigits: "Send the 6-digit code from the SMS, or /cancel to stop.",
  otpNoSession:
    "That code has expired, or no code is waiting. Start again from an OTP button.",
  otpTooManyAttempts:
    "Too many wrong codes. Start again from an OTP button to get a new one.",
  otpRejected: (message) => `${message}\n\nStart again from an OTP button to try once more.`,
  otpDelivered: ({ pointsSpent, balance }) =>
    `Here is your Fayda card.\n\nPoints used: ${pointsSpent}\nYour points: ${balance}`,
  otpIdentitySummary: ({ name, fan, fin, dateOfBirth, phone, remainingPoints }) => {
    const lines: string[] = [];
    if (name) lines.push(`<b>${escapeHtml(name)}</b>`);
    if (fan) lines.push(`FAN: ${escapeHtml(fan)}`);
    if (fin) lines.push(`FIN: ${escapeHtml(fin)}`);
    if (dateOfBirth) lines.push(`Date of birth: ${escapeHtml(dateOfBirth)}`);
    if (phone) lines.push(`Phone: ${escapeHtml(phone)}`);
    if (remainingPoints !== null) lines.push(`Remaining points: ${remainingPoints}`);
    return lines.join("\n");
  },
  otpOriginalPdf: "📄 Original PDF from the provider.",
  otpUnavailable: (admin) =>
    "Card retrieval is not connected on this deployment yet.\n\n" +
    `Contact ${admin} to have it enabled.`,
  otpNotAnswered: (admin) =>
    "Card retrieval did not answer just now.\n\n" +
    "Please try again in a few minutes. If it keeps happening, contact " +
    `${admin} and say roughly when it happened.`,
  uploadUnavailable: (admin) =>
    "Card rendering is not connected on this deployment yet.\n\n" +
    `Contact ${admin} to have it enabled.`,
  uploadAsk: (points) =>
    `Send your Fayda screenshot or PDF now.\n\n` +
    `This uses ${points} point${points === 1 ? "" : "s"}. An admin will check it and get ` +
    `back to you here. Send /cancel to stop.`,
  uploadNeedMorePoints: ({ have, need }) =>
    `You have ${have} point${have === 1 ? "" : "s"}, and this needs ${need}. ` +
    `Buy more points first.`,
  uploadReceived: ({ pointsSpent, balance }) =>
    `Received — an admin will process this and message you here when it is ready.\n\n` +
    `Points used: ${pointsSpent}\nYour points: ${balance}`,
  uploadWrongType: "Send a photo or a PDF document. Send /cancel to stop.",

  settingsPrompt: "Choose what to change.",
  downloadTypePrompt: (current) =>
    `Current download type: ${current}\n\n` +
    "Top-left: Download PNG Mirror,\n" +
    "Top-right: Download PDF Mirror,\n" +
    "Middle-left: Download Duo PNG,\n" +
    "Middle-right: Download ZIP,\n" +
    "Bottom: Printable Card",
  downloadTypes: {
    png_mirror: "Download PNG Mirror",
    pdf_mirror: "Download PDF Mirror",
    duo_png: "Download Duo PNG",
    zip: "Download ZIP",
    printable: "Printable Card",
  },
  btnDownloadType: "📄 Download format",
  btnBackSettings: "⬅️ Back to Settings",
  saved: "Saved.",
};

const am: Copy = {
  languageName: "አማርኛ",
  chooseLanguage: "እባክዎ ቋንቋ ይምረጡ።\nPlease choose your language.",
  languageChanged: "ቋንቋው ወደ አማርኛ ተቀይሯል።",

  welcome: (name) =>
    `ሰላም ${name}! 👋\n\n` +
    "የፋይዳ ማመልከቻ ሁኔታን ማረጋገጥ፣ በተደጋጋሚ የሚጠየቁ ጥያቄዎችን መመለስ፣ " +
    "ስለ ቀጠሮ ማብራራት እና መልእክትዎን ለድጋፍ ሰጪ ቡድን ማድረስ እችላለሁ።\n\n" +
    "ምን ማድረግ ይፈልጋሉ?",
  menuPrompt: "ምን ማድረግ ይፈልጋሉ?",

  btnCheckStatus: "🔎 የማመልከቻ ሁኔታ ማረጋገጥ",
  btnFaq: "❓ በተደጋጋሚ የሚጠየቁ ጥያቄዎች",
  btnAppointment: "📅 ስለ ቀጠሮ መረጃ",
  btnSupport: "💬 ድጋፍ ማግኘት",
  btnLanguage: "🌐 ቋንቋ መቀየር",
  btnBack: "⬅️ ተመለስ",
  btnCancel: "✖️ ይቅር",
  btnCheckAnother: "🔎 ሌላ ማረጋገጥ",

  askId:
    "የ<b>FIN</b> (12  አሃዝ) ወይም የ<b>FAN</b> (16 አሃዝ) ቁጥርዎን ይላኩ።\n\n" +
    "በክፍተት ጋር ወይም ያለ ክፍተት መጻፍ ይችላሉ። ለማቆም /cancel ይላኩ።",
  idInvalid:
    "ይህ የFIN ወይም የFAN ቁጥር አይመስልም።\n\n" +
    "FIN 12 አሃዝ ሲሆን FAN ደግሞ 16 አሃዝ ነው — አሃዞች ብቻ። " +
    "እባክዎ ቁጥሩን አረጋግጠው እንደገና ይላኩ፣ ወይም ለማቆም /cancel ይላኩ።",
  idRateLimited: (minutes) =>
    `በአጭር ጊዜ ውስጥ ብዙ ጊዜ አረጋግጠዋል። እባክዎ ${minutes} ደቂቃ ጠብቀው እንደገና ይሞክሩ።`,
  checking: "በማረጋገጥ ላይ…",

  resultFound: ({ status, last4, updated }) =>
    `በ<b>${last4}</b> የሚያልቅ ማመልከቻ\n\n` +
    `ሁኔታ፡ <b>${status}</b>` +
    (updated ? `\nለመጨረሻ ጊዜ የተዘመነው፡ ${updated}` : ""),
  resultNotFound:
    "በዚህ ቁጥር ምንም ማመልከቻ አልተገኘም።\n\n" +
    "እባክዎ ቁጥሩን ከደረሰኝዎ ጋር ያመሳክሩ — FIN እና FAN የተለያዩ ቁጥሮች ናቸው። " +
    "አሁንም ካልሰራ፣ ድጋፍ ሰጪ ቡድኑን ያግኙ።",
  resultUnavailable: "በአሁኑ ሰዓት ሁኔታ ማረጋገጥ አይቻልም። እባክዎ ቆይተው ይሞክሩ።",
  resultError: "በማረጋገጥ ላይ ችግር ተፈጥሯል። እባክዎ ከጥቂት ጊዜ በኋላ ይሞክሩ።",
  statusLabels: {
    submitted: "ቀርቧል",
    processing: "በሂደት ላይ ነው",
    approved: "ጸድቋል",
    printed: "ታትሟል",
    ready: "ለመውሰድ ዝግጁ ነው",
    collected: "ተወስዷል",
    rejected: "ውድቅ ተደርጓል — እባክዎ ድጋፍ ያግኙ",
  },

  faqPrompt: "ጥያቄ ይምረጡ።",
  faq: [
    {
      id: "what",
      question: "ፋይዳ ምንድን ነው?",
      answer:
        "<b>ፋይዳ ምንድን ነው?</b>\n\n" +
        "ፋይዳ የኢትዮጵያ ብሔራዊ ዲጂታል መታወቂያ ነው። ከባዮሜትሪክ መረጃዎ ጋር የተያያዘ " +
        "የ12 አሃዝ ልዩ መለያ ቁጥር (FIN) ይሰጥዎታል፤ ይህንንም በባንክ፣ በሲም ካርድ ምዝገባ እና " +
        "በመንግስት አገልግሎቶች ማንነትዎን ለማረጋገጥ ይጠቀሙበታል።",
    },
    {
      id: "fin-fan",
      question: "የFIN እና የFAN ልዩነት ምንድን ነው?",
      answer:
        "<b>FIN እና FAN</b>\n\n" +
        "<b>FAN</b> የማመልከቻ ቁጥር ነው — በሚመዘገቡበት ጊዜ የሚሰጥዎ ሲሆን፣ ማመልከቻዎ " +
        "በሂደት ላይ እያለ ለመከታተል ይጠቀሙበታል።\n\n" +
        "<b>FIN</b> ደግሞ ማመልከቻዎ ከጸደቀ በኋላ የሚሰጥ የመታወቂያ ቁጥር ነው። ይህ ቁጥር " +
        "ለዘለቄታው የእርስዎ ነው።",
    },
    {
      id: "documents",
      question: "ለመመዝገብ ምን ሰነዶች ያስፈልጋሉ?",
      answer:
        "<b>ምን ይዘው ይምጡ</b>\n\n" +
        "አንድ ህጋዊ የማንነት ማረጋገጫ — የቀበሌ መታወቂያ፣ ፓስፖርት ወይም መንጃ ፈቃድ — " +
        "ይዘው ይምጡ። እንዲሁም የጣት አሻራ፣ የአይን ስካን እና ፎቶ ይወሰዳል። ምዝገባው ነጻ ነው።",
    },
    {
      id: "howlong",
      question: "ምን ያህል ጊዜ ይወስዳል?",
      answer:
        "<b>የሚወስደው ጊዜ</b>\n\n" +
        "ከምዝገባ በኋላ በተለምዶ ጥቂት የስራ ቀናት ይወስዳል፤ ነገር ግን እንደ ማዕከሉ ስራ ብዛት " +
        "ይለያያል። የFAN ቁጥርዎን በመጠቀም እዚህ ላይ ሁኔታውን ማረጋገጥ ይችላሉ።",
    },
    {
      id: "lost",
      question: "ቁጥሬን አጥቻለሁ። ምን ማድረግ አለብኝ?",
      answer:
        "<b>ቁጥርዎን ካጡ</b>\n\n" +
        "በተመዘገቡበት ማዕከል፣ ተመሳሳይ የማንነት ማረጋገጫ ይዘው ይሂዱ፤ ሰራተኞቹ ሊፈልጉልዎ " +
        "ይችላሉ። ይህ ቦት ቁጥር መመለስ አይችልም — አስቀድመው ያለዎትን ቁጥር ሁኔታ ብቻ ነው " +
        "የሚያሳውቅዎ።",
    },
  ],

  appointment:
    "<b>ስለ ቀጠሮ</b>\n\n" +
    "ምዝገባ በአካል በመመዝገቢያ ማዕከል ይከናወናል። አንዳንድ ማዕከላት ያለ ቀጠሮ ይቀበላሉ፣ " +
    "ሌሎች ደግሞ አስቀድሞ ቀጠሮ እንዲይዙ ይጠይቃሉ።\n\n" +
    "ህጋዊ የማንነት ማረጋገጫ ይዘው ይምጡ፤ ለባዮሜትሪክ ምዝገባው 30 ደቂቃ ያህል ይያዙ።\n\n" +
    "በአቅራቢያዎ ያለ ማዕከል ለማግኘት እገዛ ከፈለጉ ከታች ድጋፍ ያግኙ።",

  supportAsk:
    "መልእክትዎን ይጻፉ፤ ለድጋፍ ሰጪ ቡድኑ አደርሳለሁ። ጥያቄዎ ስለ አንድ የተወሰነ ማመልከቻ " +
    "ከሆነ የFAN ቁጥርዎን ያካትቱ።\n\nለማቆም /cancel ይላኩ።",
  supportTooLong: "መልእክቱ በጣም ረዥም ነው። እባክዎ ከ1000 ፊደላት በታች ያሳጥሩት።",
  supportSent: "አመሰግናለሁ — መልእክትዎ ለድጋፍ ሰጪ ቡድኑ ደርሷል። በዚሁ ውይይት ውስጥ ይመልሱልዎታል።",
  supportFailed: "መልእክትዎ ተቀምጧል ነገር ግን አሁን ማድረስ አልተቻለም። የድጋፍ ቡድኑ አሁንም ያየዋል።",
  supportCancelled: "ተሰርዟል — ምንም አልተላከም።",

  unknownInput: "አልገባኝም። እባክዎ ከታች ያሉትን ቁልፎች ይጠቀሙ፣ ወይም እንደገና ለመጀመር /start ይላኩ።",
  help:
    "<b>ትዕዛዞች</b>\n\n" +
    "/start — ምናሌውን ክፈት\n" +
    "/status — ማመልከቻ አረጋግጥ\n" +
    "/faq — በተደጋጋሚ የሚጠየቁ ጥያቄዎች\n" +
    "/support — ለድጋፍ ቡድኑ መልእክት ላክ\n" +
    "/language — ቋንቋ ቀይር\n" +
    "/cancel — የያዙትን አቁም",
  cancelled: "ተሰርዟል።",

  btnOtp1: "📱 OTP 1 ⭐",
  btnOtp2: "📱 OTP 2",
  btnOtp3: "📱 OTP 3",
  btnScreenshot: "🪪 የፋይዳ ስክሪንshot",
  btnUploadPdf: "📄 PDF ይላኩ",
  btnBuyPoints: "💳 ነጥብ ይግዙ",
  btnMyPoints: "📊 የእኔ ነጥብ",
  btnSettings: "⚙️ ቅንብሮች",
  btnAdmin: "🛠 አስተዳዳሪ",

  welcomeBot: ({ name, points }) =>
    `${name ? `ሰላም ${name}! 👋` : "👋"}\n\n` +
    `እንኳን ወደ ፋይዳ ቴሌግራም ቦት በደህና መጡ።\nየእርስዎ ነጥብ፡ ${points}`,

  myPoints: ({ points, price }) =>
    `የእርስዎ ነጥብ፡ ${points}\n` +
    `የህትመት ዋጋ (ብር/ነጥብ)፡ ${price}\n\n` +
    'ነጥብ ለመግዛት "ነጥብ ይግዙ" የሚለውን ከፍተው የክፍያ ደረሰኝ ሊንክዎን ወይም ማጣቀሻዎን ይላኩ።',

  buyPointsAccounts: ({ cbeAccountName, cbeAccountNumber, telebirrAccountName, telebirrAccountNumber }) => {
    const lines: string[] = [];
    if (cbeAccountName && cbeAccountNumber) {
      lines.push(`<b>CBE</b>፡ ${escapeHtml(cbeAccountNumber)} (${escapeHtml(cbeAccountName)})`);
    }
    if (telebirrAccountName && telebirrAccountNumber) {
      lines.push(`<b>Telebirr</b>፡ ${escapeHtml(telebirrAccountNumber)} (${escapeHtml(telebirrAccountName)})`);
    }
    return `<b>ክፍያ ወደዚህ ይላኩ</b>\n\n${lines.join("\n")}`;
  },
  buyPointsNoAccounts: (admin) =>
    "በዚህ ቦት ላይ ገና የክፍያ መቀበያ አካውንት አልተዘጋጀም።\n\n" + `ለማስተካከል ${admin} ያግኙ።`,

  buyPointsHow: (admin) =>
    "ከፈጸሙ በኋላ የደረሰኙን ሊንክ ወይም የግብይት ማጣቀሻ ቁጥር እዚህ ልከው ያረጋግጡ።\n\n" +
    "ከሚከተሉት ውስጥ ማንኛውንም መላክ ይችላሉ፡\n" +
    "1) የCBE ሊንክ፡ https://apps.cbe.com.et:100/?id=FT25391XM4KP07823491\n" +
    "2) የCBE ሊንክ፡ https://mbreciept.cbe.com.et/FT26257QHWN-41985602\n" +
    "3) የCBE ማጣቀሻ ብቻ፡ FT25391XM4KP\n" +
    "4) የTELEBirr ደረሰኝ ሊንክ፡ https://transactioninfo.ethiotelecom.et/receipt/CKM8P4YJNQ\n" +
    "5) የTELEBirr የግብይት ቁጥር ብቻ፡ CKM8P4YJNQ\n" +
    "6) የSMS/ኢሜይል ሙሉ ጽሑፍ (ገልብጠው ይለጥፉ)።\n\n" +
    "ቁጥር ከተየቡ በትክክል ይገልብጡ፡ ካፒታል O ከዜሮ (0)፣ እንዲሁም I ከአንድ (1) ይመሳሰላሉ።\n\n" +
    "አሁን የክፍያ ሊንኩን ይላኩ።\n\n" +
    `እገዛ ይፈልጋሉ? ${admin} ያግኙ`,

  receiptUnreadable: (admin) =>
    "በላኩት ውስጥ የክፍያ ማጣቀሻ ማግኘት አልቻልኩም።\n\n" +
    "የደረሰኙን ሊንክ፣ ወይም ማጣቀሻውን ብቻ፣ ወይም ሙሉ የSMS ጽሑፉን ይላኩ። " +
    `ችግሩ ከቀጠለ ${admin} ያግኙ`,
  receiptNoAmount: (admin) =>
    "የክፍያው ገጽ ደርሶኝ ቢሆንም በእሱ ላይ ያለውን መጠን ማንበብ አልቻልኩም።\n\n" +
    "ብዙውን ጊዜ የሚሆነው ማጣቀሻው ተመሳሳይ ፊደል/ቁጥር ስለሚይዝ ነው — ካፒታል O ከዜሮ (0)፣ " +
    "እንዲሁም I ከአንድ (1) ይመሳሰላሉ። የደረሰኙ ሊንክ ካለዎት ይለጥፉ፤ አለበለዚያ " +
    "ቁጥሩን አረጋግጠው እንደገና ይላኩ።\n\n" +
    `ለማጣራት ለአንድ ሰው ተላልፏልም። ችግሩ ከቀጠለ ${admin} ያግኙ`,
  receiptDuplicate:
    "ይህ ደረሰኝ ቀድሞውኑ ጥቅም ላይ ውሏል። እያንዳንዱ ክፍያ አንድ ጊዜ ብቻ ነው የሚያገለግለው።\n\n" +
    "አዲስ ክፍያ ከፈጸሙ የዚያኑ ደረሰኝ ይላኩ።",
  receiptCredited: ({ points, balance, amount }) =>
    `ክፍያው ተረጋግጧል፡ ${amount} ብር\n` + `የተጨመረ ነጥብ፡ ${points}\n` + `የእርስዎ ነጥብ፡ ${balance}`,
  receiptQueued:
    "ደረሰኝዎ ደርሶናል፤ በማጣራት ላይ ነው።\n\n" +
    "ይህ የሚሆነው የባንኩ ገጽ በራስ-ሰር ማንበብ ሳይቻል ሲቀር ነው — በክፍያዎ ላይ ችግር አለ ማለት አይደለም። " +
    "ከተረጋገጠ በኋላ በዚሁ ውይይት እናሳውቅዎታለን።",
  receiptTooSmall: ({ amount, price }) =>
    `የከፈሉት ${amount} ብር ሲሆን ይህ ከአንድ ነጥብ ዋጋ (${price} ብር) ያንሳል።\n\n` +
    `ቢያንስ ${price} ብር ከፍለው አዲሱን ደረሰኝ ይላኩ።`,

  otpSelected: (slot) => `OTP ${slot} ተመርጧል። የፋይዳ FAN ቁጥርዎን ይላኩ።`,
  otpAsk: ({ slot, points }) =>
    `OTP ${slot} ተመርጧል። የ16 አኃዝ የፋይዳ FAN ቁጥርዎን ይላኩ።\n\n` +
    `መታወቂያው ሲደርስዎ ${points} ነጥብ ያስከፍላል። ለማቆም /cancel ይላኩ።`,
  otpSending: "ኮዱ እየተላከ ነው…",
  otpSent: (phone) =>
    `የ6 አኃዝ ኮድ ወደ ${phone || "የተመዘገበው ስልክ"} ተልኳል።\n\n` +
    "ኮዱን በዚህ ይላኩ። በ10 ደቂቃ ውስጥ ጊዜው ያልፋል — ለማቆም /cancel ይላኩ።",
  otpVerifying: "ኮዱን በማረጋገጥ እና መታወቂያዎን በማዘጋጀት ላይ። እስከ አንድ ደቂቃ ሊወስድ ይችላል…",
  otpNotSixDigits: "ከSMS የደረሰዎትን የ6 አኃዝ ኮድ ይላኩ፣ ወይም ለማቆም /cancel ይላኩ።",
  otpNoSession: "የኮዱ ጊዜ አልፏል፣ ወይም የሚጠበቅ ኮድ የለም። ከOTP ቁልፍ እንደገና ይጀምሩ።",
  otpTooManyAttempts: "ብዙ ጊዜ የተሳሳተ ኮድ ገብቷል። አዲስ ኮድ ለማግኘት ከOTP ቁልፍ እንደገና ይጀምሩ።",
  otpRejected: (message) => `${message}\n\nእንደገና ለመሞከር ከOTP ቁልፍ ይጀምሩ።`,
  otpDelivered: ({ pointsSpent, balance }) =>
    `የፋይዳ መታወቂያዎ ይኸውና።\n\nየተጠቀሙት ነጥብ፡ ${pointsSpent}\nየእርስዎ ነጥብ፡ ${balance}`,
  otpIdentitySummary: ({ name, fan, fin, dateOfBirth, phone, remainingPoints }) => {
    const lines: string[] = [];
    if (name) lines.push(`<b>${escapeHtml(name)}</b>`);
    if (fan) lines.push(`FAN፡ ${escapeHtml(fan)}`);
    if (fin) lines.push(`FIN፡ ${escapeHtml(fin)}`);
    if (dateOfBirth) lines.push(`የትውልድ ቀን፡ ${escapeHtml(dateOfBirth)}`);
    if (phone) lines.push(`ስልክ፡ ${escapeHtml(phone)}`);
    if (remainingPoints !== null) lines.push(`የቀረ ነጥብ፡ ${remainingPoints}`);
    return lines.join("\n");
  },
  otpOriginalPdf: "📄 የመጀመሪያው PDF ከአገልግሎት አቅራቢው።",
  otpUnavailable: (admin) =>
    "የመታወቂያ ማውጣት አገልግሎት በዚህ ላይ ገና አልተገናኘም።\n\n" + `ለማስጀመር ${admin} ያግኙ።`,
  otpNotAnswered: (admin) =>
    "የመታወቂያ ማውጣት አገልግሎት አሁን ምላሽ አልሰጠም።\n\n" +
    `እባክዎ ከጥቂት ደቂቃዎች በኋላ እንደገና ይሞክሩ። ችግሩ ከቀጠለ ${admin} ያግኙ።`,
  uploadUnavailable: (admin) =>
    "የመታወቂያ ህትመት አገልግሎት በዚህ ላይ ገና አልተገናኘም።\n\n" + `ለማስጀመር ${admin} ያግኙ።`,
  uploadAsk: (points) =>
    `የፋይዳ ስክሪንshot ወይም PDF አሁን ይላኩ።\n\n` +
    `ይህ ${points} ነጥብ ያስከፍላል። አድሚን አረጋግጦ በዚሁ ውይይት ይመልስልዎታል። ለማቆም /cancel ይላኩ።`,
  uploadNeedMorePoints: ({ have, need }) =>
    `${have} ነጥብ አለዎት፣ ይህ ደግሞ ${need} ነጥብ ይፈልጋል። እባክዎ ተጨማሪ ነጥብ ይግዙ።`,
  uploadReceived: ({ pointsSpent, balance }) =>
    `ደርሶናል — አድሚን አረጋግጦ ሲጨርስ በዚሁ ውይይት ያሳውቅዎታል።\n\n` +
    `የተጠቀሙት ነጥብ፡ ${pointsSpent}\nየእርስዎ ነጥብ፡ ${balance}`,
  uploadWrongType: "እባክዎ ፎቶ ወይም PDF ሰነድ ይላኩ። ለማቆም /cancel ይላኩ።",

  settingsPrompt: "ምን መቀየር እንደሚፈልጉ ይምረጡ።",
  downloadTypePrompt: (current) =>
    `የአሁኑ የማውረጃ አይነት፡ ${current}\n\n` +
    "ላይ-ግራ፡ PNG Mirror አውርድ፣\n" +
    "ላይ-ቀኝ፡ PDF Mirror አውርድ፣\n" +
    "መሃል-ግራ፡ Duo PNG አውርድ፣\n" +
    "መሃል-ቀኝ፡ ZIP አውርድ፣\n" +
    "ታች፡ የህትመት ካርድ",
  downloadTypes: {
    png_mirror: "PNG Mirror አውርድ",
    pdf_mirror: "PDF Mirror አውርድ",
    duo_png: "Duo PNG አውርድ",
    zip: "ZIP አውርድ",
    printable: "የህትመት ካርድ",
  },
  btnDownloadType: "📄 የማውረጃ አይነት",
  btnBackSettings: "⬅️ ወደ ቅንብሮች ተመለስ",
  saved: "ተቀምጧል።",
};

const COPY: Record<Lang, Copy> = { am, en };

/** `t("am").btnFaq` — the whole table for one language, not a key lookup. */
export function t(lang: Lang): Copy {
  return COPY[lang] ?? COPY.en;
}

/** The command list shown in Telegram's menu button, per language. */
export function commandsFor(lang: Lang): { command: string; description: string }[] {
  const labels =
    lang === "am"
      ? {
          start: "ምናሌውን ክፈት",
          status: "የማመልከቻ ሁኔታ አረጋግጥ",
          faq: "በተደጋጋሚ የሚጠየቁ ጥያቄዎች",
          support: "ለድጋፍ ቡድኑ መልእክት ላክ",
          language: "ቋንቋ ቀይር",
          cancel: "የያዙትን አቁም",
        }
      : {
          start: "Open the menu",
          status: "Check an application",
          faq: "Frequently asked questions",
          support: "Message the support team",
          language: "Change language",
          cancel: "Stop what you are doing",
        };
  return Object.entries(labels).map(([command, description]) => ({ command, description }));
}
