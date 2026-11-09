export type HTMLNode = { nodeName: string; tagName?: string; value?: string; attrs?: { name: string; value: string }[]; childNodes?: HTMLNode[] }
export function parseFragment(html: string): HTMLNode
