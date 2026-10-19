import DOMPurify from "dompurify";

/**
 * Everything rendered from a file goes through here. Files are untrusted:
 * no scripts, no event handlers, no <style> that could restyle the app,
 * no forms, no iframes.
 */
export function sanitize(html: string): string {
  return DOMPurify.sanitize(html, {
    FORBID_TAGS: ["style", "form", "iframe", "object", "embed", "base", "meta", "link"],
    FORBID_ATTR: ["style", "srcset"],
    ADD_ATTR: ["target"],
  });
}
