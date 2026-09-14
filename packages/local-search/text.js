"use strict";

const { TextDecoder } = require("node:util");

function truncateUtf8(text, maxBytes) {
  const encoded = Buffer.from(text, "utf8");
  if (encoded.length <= maxBytes) return text;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let end = maxBytes; end >= Math.max(0, maxBytes - 3); end -= 1) {
    try { return decoder.decode(encoded.subarray(0, end)); } catch {}
  }
  return "";
}

module.exports = { truncateUtf8 };
