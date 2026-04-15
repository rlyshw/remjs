/**
 * Element targeting — generates deterministic CSS selector paths.
 *
 * Given a DOM element, produces a selector string that uniquely
 * identifies it in the document. Uses tag#id when available,
 * falls back to tag:nth-child(n) ancestry chains.
 */

export function getTargetPath(element: Element): string {
  if (element === document.documentElement) return "html";
  if (element === document.body) return "body";

  const parts: string[] = [];
  let current: Element | null = element;

  while (current && current !== document.documentElement) {
    const tag = current.tagName.toLowerCase();

    if (current.id) {
      parts.unshift(`${tag}#${current.id}`);
      break;
    }

    const parent: Element | null = current.parentElement;
    if (!parent) {
      parts.unshift(tag);
      break;
    }

    const siblings = Array.from(parent.children);
    const sameTag = siblings.filter((s: Element) => s.tagName === current!.tagName);
    if (sameTag.length === 1) {
      parts.unshift(tag);
    } else {
      const index = sameTag.indexOf(current) + 1;
      parts.unshift(`${tag}:nth-of-type(${index})`);
    }

    current = parent;
  }

  return parts.join(" > ");
}

