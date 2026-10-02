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

function formatInline(text) {
  return text
    .replace(/\*\*(?!\s)([^*]+?)(?<!\s)\*\*/g, (_, b) => `<strong>${b}</strong>`)
    .replace(/(?<!\*)\*(?!\s)([^*]+?)(?<!\s)\*(?!\*)/g, (_, i) => `<em>${i}</em>`)
    .replace(/(^|\W)_([^_]+?)_(\W|$)/g, (_, pre, i, post) => `${pre}<em>${i}</em>${post}`);
}

export function md(text) {
  const escaped = esc(text);
  // Protect code spans first so ** and * inside code stay literal.
  const codes = [];
  const noCode = escaped.replace(/`([^`\n]+?)`/g, (_, code) => {
    codes.push(`<code>${code}</code>`);
    return `\0CODE${codes.length - 1}\0`;
  });
  // Build links next, formatting the label but keeping the URL literal.
  // The finished <a> tags are stashed like code spans so bold/italic
  // never rewrites the href (e.g. https://example.com/_docs_/x).
  const links = [];
  const withLinks = noCode.replace(/\[([^\]]+?)\]\(([^)\s]+?)\)/g, (m, label, url) =>
    isSafeUrl(url)
      ? (() => {
          links.push(
            `<a href="${url}" target="_blank" rel="noopener noreferrer">${formatInline(label)}</a>`
          );
          return `\0LINK${links.length - 1}\0`;
        })()
      : m
  );
  const formatted = formatInline(withLinks);
  // Content is already escaped, so this injects only our safe tags.
  return formatted
    .replace(/\0LINK(\d+)\0/g, (_, n) => links[Number(n)])
    .replace(/\0CODE(\d+)\0/g, (_, n) => codes[Number(n)]);
}

function isSafeUrl(url) {
  return /^(https?:\/\/[^\s"'<>]+|\/[^\s"'<>]*|#[^\s"'<>]*)$/.test(url);
}
