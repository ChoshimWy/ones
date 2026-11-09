import type { Answer } from '../protocol.ts'
import type { JsonValue } from 'orca/host'

export class UIError extends Error {}
export async function request<T>(name: string, input?: unknown, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted()
  const response = await orca.host.call(
    'plugin.request',
    {
      name,
      ...(input === undefined ? {} : { input: input as JsonValue }),
      timeoutMs: 120000
    },
    { signal }
  )
  signal?.throwIfAborted()
  const result = response.output as Answer<T>
  if (!result.ok) throw new UIError(result.error.message)
  return result.value
}
export function message(error: unknown): string {
  return error instanceof UIError
    ? error.message
    : '操作未完成，请检查连接后重试；未知写入结果不可重发。'
}
export type Child = Node | string | number | null | undefined | false
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = className
  for (const child of children)
    if (child !== null && child !== undefined && child !== false)
      node.append(child instanceof Node ? child : String(child))
  return node
}
export const text = (value: string, muted = false) => el('p', muted ? 'muted' : '', value)
export const row = (...children: Child[]) => el('div', 'row', ...children)
export const stack = (...children: Child[]) => el('div', 'stack', ...children)
export const card = (title: string, ...children: Child[]) =>
  el('section', 'card stack', el('h2', '', title), ...children)
export function notice(value: string, danger = false): HTMLElement {
  const node = el('div', danger ? 'notice danger' : 'notice', value)
  node.setAttribute('role', danger ? 'alert' : 'status')
  return node
}
export function button(
  label: string,
  action: () => unknown,
  disabled = false,
  kind = ''
): HTMLButtonElement {
  const node = el('button', kind, label)
  node.type = 'button'
  node.disabled = disabled
  node.addEventListener('click', () => {
    void action()
  })
  return node
}
export function input(
  label: string,
  value: string,
  change: (value: string) => void,
  options: { type?: string; disabled?: boolean; multiline?: boolean } = {}
): HTMLElement {
  const field = options.multiline ? el('textarea') : el('input')
  field.id = label
  field.value = value
  field.disabled = !!options.disabled
  field.autocomplete = 'off'
  field.spellcheck = false
  if (field instanceof HTMLInputElement) field.type = options.type ?? 'text'
  else {
    field.rows = 3
    field.maxLength = 2000
  }
  field.addEventListener('input', () => change(field.value))
  const caption = el('label', '', label)
  caption.htmlFor = field.id
  return el('div', 'field', caption, field)
}
export function check(
  label: string,
  checked: boolean,
  change: (value: boolean) => void,
  disabled = false
): HTMLElement {
  const field = el('input')
  field.type = 'checkbox'
  field.checked = checked
  field.disabled = disabled
  field.addEventListener('change', () => change(field.checked))
  return el('label', 'check', field, el('span', '', label))
}
export function select(
  label: string,
  value: string,
  options: { value: string; label: string }[],
  change: (value: string) => void,
  disabled = false
): HTMLElement {
  const field = el('select')
  field.id = label
  field.disabled = disabled
  for (const option of options) {
    const node = el('option', '', option.label)
    node.value = option.value
    field.append(node)
  }
  field.value = value
  field.addEventListener('change', () => change(field.value))
  const caption = el('label', '', label)
  caption.htmlFor = label
  return el('div', 'field', caption, field)
}
export const hours = (minutes: number) => `${Number((minutes / 60).toFixed(3))} 小时`
export const original = (team: string, task: string) =>
  `http://aputureones.com:8088/project/#/team/${encodeURIComponent(team)}/task/${encodeURIComponent(task)}`
export function openOriginal(team: string, task: string): void {
  void orca.shell?.openExternal(original(team, task)).catch(() => {})
}
