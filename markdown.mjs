// Minimal markdown renderer for grill-with-ui (issue #9).
// Zero dependencies, no build step. Escape first, then add safe tags.
// This module is the testable seam. page.html inlines the same function.
export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}

export function md(text) {
  const escaped = esc(text);
  // Protect code spans first so ** and * inside code stay literal.
  const codes = [];
  const noCode = escaped.replace(/`([^`\n]+?)`/g, (_, code) => {
    codes.push(`<code>${code}</code>`);
    return `\0CODE${codes.length - 1}\0`;
  });
  const linked = noCode.replace(/\[([^\]]+?)\]\(([^)\s]+?)\)/g, (m, label, url) =>
    isSafeUrl(url) ? `<a href="${url}">${label}</a>` : m
  );
  const formatted = linked
    .replace(/\*\*([^*]+?)\*\*/g, (_, b) => `<strong>${b}</strong>`)
    .replace(/\*([^*]+?)\*/g, (_, i) => `<em>${i}</em>`)
    .replace(/(^|\W)_([^_]+?)_(\W|$)/g, (_, pre, i, post) => `${pre}<em>${i}</em>${post}`);
  // Content is already escaped, so this injects only our safe tags.
  return formatted.replace(/\0CODE(\d+)\0/g, (_, n) => codes[Number(n)]);
}

function isSafeUrl(url) {
  return /^(https?:\/\/[^\s"'<>]+|\/[^\s"'<>]*|#[^\s"'<>]*)$/.test(url);
}
