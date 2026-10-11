import { DOMParser, type Element, type Node } from '@xmldom/xmldom';

const ELEMENT_NODE = 1;

/**
 * Parses an XML part of an Office/iWork package.
 *
 * @throws Error naming the part when the XML is malformed (xmldom throws on
 *   fatal errors and reports recoverable ones), so a broken export fails
 *   loudly instead of importing as an empty or partial document
 */
export function parseXml(xml: string, part: string): Element {
  const errors: string[] = [];
  const fail = (reason: string) =>
    new Error(`${part} is not valid XML: ${reason}`);
  let root: Element;
  try {
    // A document without a root is a fatal error, so the root exists here.
    root = new DOMParser({
      onError: (level, message) => {
        if (level !== 'warning') errors.push(message);
      },
    }).parseFromString(xml, 'text/xml').documentElement!;
  } catch (error) {
    throw fail((error as Error).message);
  }
  if (errors.length > 0) throw fail(errors[0]);
  return root;
}

/** Element children of a node, optionally only those with one tag name. */
export function children(node: Node, name?: string): Element[] {
  const out: Element[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (
      child.nodeType === ELEMENT_NODE &&
      (!name || (child as Element).nodeName === name)
    ) {
      out.push(child as Element);
    }
  }
  return out;
}

export function firstChild(
  node: Node | undefined,
  name: string,
): Element | undefined {
  return node ? children(node, name)[0] : undefined;
}

/** An attribute value, or undefined when the element or attribute is absent. */
export function attr(
  element: Element | undefined,
  name: string,
): string | undefined {
  // getAttribute returns null for an absent attribute.
  return element?.getAttribute(name) ?? undefined;
}

/** Text of an element; xmldom types it nullable, though elements never are. */
export function textOf(node: Node): string {
  return node.textContent ?? '';
}
