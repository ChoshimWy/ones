// 本地线性图标，不加载外部资源；装饰图标不重复朗读控件名称。
const paths: Record<string, string> = {
  bugs: 'M8 8h8v8a4 4 0 0 1-8 0V8Zm2 0V6a2 2 0 0 1 4 0v2M4 10h4m8 0h4M4 16h4m8 0h4M6 4l3 3m9-3-3 3M6 21l3-3m9 3-3-3M12 9v10',
  implementation: 'M14 6a5 5 0 0 0-6 6L3 17a3 3 0 0 0 4 4l5-5a5 5 0 0 0 6-6l-3 3-4-4 3-3Z',
  hours: 'M12 8v5l3 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  recovery: 'm7 11 3 3 7-7M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2',
  settings: 'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0M3 21v-2a6 6 0 0 1 6-6h6a6 6 0 0 1 6 6v2H3',
  shield: 'm12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6l9-4Zm-5 9 4 4 6-7',
  filter: 'M3 3h18v3l-7 8v7l-4-2v-5L3 6V3',
  folder: 'M3 5h6l2 3h10v13H3V5',
  refresh: 'M20 7a9 9 0 1 0 1 9M20 2v6h-6'
}
export function icon(name: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('class', 'ui-icon')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  const path = document.createElementNS(svg.namespaceURI, 'path')
  path.setAttribute('d', paths[name] ?? paths.bugs!)
  path.setAttribute('fill', 'none')
  path.setAttribute('stroke', 'currentColor')
  path.setAttribute('stroke-width', '1.7')
  path.setAttribute('stroke-linecap', 'round')
  path.setAttribute('stroke-linejoin', 'round')
  svg.append(path)
  return svg
}
