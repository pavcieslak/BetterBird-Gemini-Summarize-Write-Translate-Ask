"use strict";

/* ---------- text helpers ---------- */

function htmlToText(html) {
  const cleaned = String(html || "")
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|table)>/gi, "\n");
  const doc = new DOMParser().parseFromString(cleaned, "text/html");
  return (doc.body.textContent || "")
    .replace(/ /g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function clip(text, max) {
  if (!max || text.length <= max) return text;
  return text.slice(0, max) + "\n\n[…truncated]";
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/* ---------- reading a message ---------- */

function collectParts(part, out) {
  const type = (part.contentType || "").toLowerCase();
  if (part.parts && part.parts.length) {
    part.parts.forEach(p => collectParts(p, out));
  } else if (part.body && !part.name) {
    if (type === "text/plain") out.plain.push(part.body);
    else if (type === "text/html") out.html.push(part.body);
  }
}

function extractText(fullPart) {
  const out = { plain: [], html: [] };
  collectParts(fullPart, out);
  if (out.plain.join("").trim()) return out.plain.join("\n\n").trim();
  return out.html.map(htmlToText).join("\n\n").trim();
}

async function loadMessageContext(messageId, maxChars) {
  const [header, full] = await Promise.all([
    messenger.messages.get(messageId),
    messenger.messages.getFull(messageId)
  ]);
  const body = extractText(full);
  if (!body) throw new Error("This message has no readable text content.");
  return {
    id: messageId,
    subject: header.subject || "",
    from: header.author || "",
    date: header.date ? new Date(header.date).toISOString() : "",
    body: clip(body, maxChars)
  };
}

/* ---------- compose body: find the user's own text, apart from quote/signature ---------- */

const hasText = ls => ls.some(l => String(l).trim());

function splitPlain(text) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const isQuote = l => /^>/.test(l);
  let sig = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^-- ?$/.test(lines[i])) { sig = i; break; }
  }
  const end = sig >= 0 ? sig : lines.length;
  let first = -1, last = -1;
  for (let i = 0; i < end; i++) {
    if (isQuote(lines[i])) { if (first < 0) first = i; last = i; }
  }
  if (first < 0) {
    return { before: lines.slice(0, end), quote: [], after: [], sig: lines.slice(end), useAfter: false };
  }
  const citeStart = first > 0 && lines[first - 1].trim() && !isQuote(lines[first - 1]) ? first - 1 : first;
  const before = lines.slice(0, citeStart);
  const quote = lines.slice(citeStart, last + 1);
  const after = lines.slice(last + 1, end);
  let useAfter;
  if (hasText(before)) useAfter = false;
  else if (hasText(after)) useAfter = true;
  else useAfter = after.length > before.length;
  return { before, quote, after, sig: lines.slice(end), useAfter };
}

function plainDraftText(split) {
  return (split.useAfter ? split.after : split.before).join("\n").trim();
}

function applyPlain(split, newText, how) {
  const newLines = String(newText).trim().split("\n");
  const region = split.useAfter ? split.after : split.before;
  let merged;
  if (how === "insert" && hasText(region)) {
    merged = newLines.concat([""], region);
  } else {
    merged = newLines.concat([""]);
  }
  let before = split.before, after = split.after;
  if (split.useAfter) after = [""].concat(merged);
  else before = merged;
  const out = before.concat(split.quote, after);
  if (split.sig.length && out.length && out[out.length - 1].trim()) out.push("");
  return out.concat(split.sig).join("\n");
}

function splitHtml(html) {
  const doc = new DOMParser().parseFromString(html || "<html><body></body></html>", "text/html");
  const nodes = Array.from(doc.body.childNodes);
  const isQuote = n => n.nodeType === 1 && n.matches("blockquote[type=cite], .moz-cite-prefix, .moz-forward-container");
  const isSig = n => n.nodeType === 1 && n.classList.contains("moz-signature");
  const nodeHasText = ns => ns.some(n => (n.textContent || "").trim());
  const nodeHasEl = ns => ns.some(n => n.nodeType === 1);
  const qIdx = [];
  nodes.forEach((n, i) => { if (isQuote(n)) qIdx.push(i); });

  let region, ref, quoteNodes = [];
  if (!qIdx.length) {
    region = nodes.filter(n => !isSig(n));
    ref = nodes.find(isSig) || null;
  } else {
    const first = qIdx[0], last = qIdx[qIdx.length - 1];
    const head = nodes.slice(0, first).filter(n => !isSig(n));
    const tail = nodes.slice(last + 1).filter(n => !isSig(n));
    quoteNodes = nodes.slice(first, last + 1);
    let useTail;
    if (nodeHasText(head)) useTail = false;
    else if (nodeHasText(tail)) useTail = true;
    else useTail = !nodeHasEl(head) && nodeHasEl(tail);
    region = useTail ? tail : head;
    ref = useTail ? (nodes[last + 1] || null) : nodes[first];
  }
  const serialize = ns => ns.map(n => (n.nodeType === 1 ? n.outerHTML : n.textContent)).join("");
  return {
    doc,
    region,
    ref,
    draftText: htmlToText(serialize(region)),
    quoteText: htmlToText(serialize(quoteNodes))
  };
}

function textToFragment(doc, text) {
  const frag = doc.createDocumentFragment();
  String(text).trim().split(/\n{2,}/).forEach(par => {
    const p = doc.createElement("p");
    par.split("\n").forEach((line, i) => {
      if (i) p.appendChild(doc.createElement("br"));
      p.appendChild(doc.createTextNode(line));
    });
    frag.appendChild(p);
  });
  return frag;
}

function applyHtml(split, newText, how) {
  const { doc, region, ref } = split;
  const insertBefore = region.length ? region[0] : ref;
  doc.body.insertBefore(textToFragment(doc, newText), insertBefore);
  if (how === "replace") region.forEach(n => n.remove());
  return "<!DOCTYPE html>\n" + doc.documentElement.outerHTML;
}

/* ---------- compose window ---------- */

async function getComposeContext(tabId, settings) {
  const details = await messenger.compose.getComposeDetails(tabId);
  let draft, quoteText = "";
  if (details.isPlainText) {
    const s = splitPlain(details.plainTextBody);
    draft = plainDraftText(s);
    quoteText = s.quote.map(l => l.replace(/^(>\s?)+/, "")).join("\n").trim();
  } else {
    const s = splitHtml(details.body);
    draft = s.draftText;
    quoteText = s.quoteText;
  }
  let original = null;
  if (details.relatedMessageId) {
    try {
      original = await loadMessageContext(details.relatedMessageId, settings.maxChars);
    } catch (e) {
      /* fall back to quoted text below */
    }
  }
  if (!original && quoteText) {
    original = { subject: details.subject || "", from: "", date: "", body: clip(quoteText, settings.maxChars) };
  }
  return { subject: details.subject || "", draft, original };
}

async function applyToCompose(tabId, text, how) {
  const details = await messenger.compose.getComposeDetails(tabId);
  if (details.isPlainText) {
    const merged = applyPlain(splitPlain(details.plainTextBody), text, how);
    await messenger.compose.setComposeDetails(tabId, { plainTextBody: merged });
  } else {
    const merged = applyHtml(splitHtml(details.body), text, how);
    await messenger.compose.setComposeDetails(tabId, { body: merged });
  }
}

async function openReplyWithText(messageId, text, replyAll) {
  const tab = await messenger.compose.beginReply(messageId, replyAll ? "replyToAll" : "replyToSender");
  let lastError;
  for (let i = 0; i < 10; i++) {
    try {
      await applyToCompose(tab.id, text, "insert");
      return;
    } catch (e) {
      lastError = e;
      await sleep(300);
    }
  }
  throw new Error("The reply window opened, but the text could not be inserted. Use Copy instead. (" + (lastError && lastError.message) + ")");
}
