import type { FabricObject } from 'fabric'
import type { EditorCanvas } from './editor'

/** 左下图层面板：列表（顶层在上）、选中高亮、可见性、透明度、层序、删除 */
export function setupLayersPanel(
  editor: EditorCanvas,
  listEl: HTMLElement,
  propsEl: HTMLElement,
  onMutate?: () => void
): { render: () => void } {
  const activeObj = (): FabricObject | null => editor.canvas.getActiveObject() ?? null

  function mkBtn(text: string, fn: () => void): HTMLButtonElement {
    const b = document.createElement('button')
    b.className = 'mini'
    b.textContent = text
    b.onclick = fn
    return b
  }

  function render(): void {
    const objs = editor.layers().slice().reverse() // 顶层显示在列表最上方
    listEl.innerHTML = ''
    if (objs.length === 0) {
      const hint = document.createElement('div')
      hint.className = 'lib-hint'
      hint.textContent = '打开 DDS 后这里显示图层'
      listEl.appendChild(hint)
      renderProps(null)
      return
    }
    const active = activeObj()
    for (const obj of objs) {
      const meta = editor.metaOf(obj)
      const isBase = meta?.kind === 'base'
      const row = document.createElement('div')
      row.className = 'layer-row' + (obj === active ? ' active' : '')

      const vis = document.createElement('button')
      vis.className = 'lr-btn'
      vis.textContent = obj.visible ? '👁' : '🚫'
      vis.title = obj.visible ? '点击隐藏' : '点击显示'
      vis.onclick = (e) => {
        e.stopPropagation()
        editor.setVisible(obj, !obj.visible)
        render()
        onMutate?.()
      }
      row.appendChild(vis)

      const name = document.createElement('span')
      name.className = 'lr-name'
      name.textContent = meta?.name ?? (isBase ? '原贴图' : '图层')
      row.appendChild(name)

      if (isBase) {
        const tag = document.createElement('span')
        tag.className = 'lr-tag'
        tag.textContent = '底图'
        row.appendChild(tag)
      } else {
        const del = document.createElement('button')
        del.className = 'lr-btn'
        del.textContent = '🗑'
        del.title = '删除图层'
        del.onclick = (e) => {
          e.stopPropagation()
          editor.removeObject(obj)
        }
        row.appendChild(del)
      }

      row.onclick = () => {
        if (obj.selectable === false) return // 底图不可选中
        editor.setActive(obj)
      }
      listEl.appendChild(row)
    }
    renderProps(active)
  }

  function renderProps(obj: FabricObject | null): void {
    propsEl.innerHTML = ''
    const meta = obj ? editor.metaOf(obj) : undefined
    if (!obj || meta?.kind === 'base') {
      propsEl.classList.remove('show')
      return
    }
    propsEl.classList.add('show')

    // 透明度滑块
    const opRow = document.createElement('div')
    opRow.className = 'prop-row'
    const opLabel = document.createElement('label')
    opLabel.textContent = '透明度'
    const op = document.createElement('input')
    op.type = 'range'
    op.min = '0'
    op.max = '100'
    op.value = String(Math.round((obj.opacity ?? 1) * 100))
    const opVal = document.createElement('span')
    opVal.textContent = op.value + '%'
    op.oninput = () => {
      editor.setOpacity(obj, Number(op.value) / 100)
      opVal.textContent = op.value + '%'
      onMutate?.()
    }
    opRow.append(opLabel, op, opVal)
    propsEl.appendChild(opRow)

    // 层序 / 删除
    const btnRow = document.createElement('div')
    btnRow.className = 'prop-row'
    btnRow.append(
      mkBtn('上移', () => editor.raise(obj)),
      mkBtn('下移', () => editor.lower(obj)),
      mkBtn('删除', () => editor.removeObject(obj))
    )
    propsEl.appendChild(btnRow)
  }

  // 键盘 Delete / Backspace 删除选中的 overlay（输入框聚焦 / 透视编辑态除外）
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Delete' && e.key !== 'Backspace') return
    if (editor.isPerspActive()) return
    const tgt = e.target as HTMLElement | null
    if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA')) return
    const obj = activeObj()
    if (obj && editor.metaOf(obj)?.kind === 'overlay') editor.removeObject(obj)
  })

  return { render }
}
